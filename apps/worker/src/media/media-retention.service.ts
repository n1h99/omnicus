import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnvironment } from '@omnicus/config/server';
import { S3MediaStorage } from '@omnicus/media-core';

import { DatabaseService } from '../database/database.service';

@Injectable()
export class MediaRetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MediaRetentionService.name);
  private readonly storage: S3MediaStorage | undefined;
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {
    if (config.get('MEDIA_STORAGE_ENABLED', { infer: true }))
      this.storage = new S3MediaStorage({
        accessKeyId: config.get('MEDIA_BUCKET_ACCESS_KEY_ID', { infer: true })!,
        bucket: config.get('MEDIA_BUCKET', { infer: true })!,
        endpoint: config.get('MEDIA_BUCKET_ENDPOINT', { infer: true })!,
        forcePathStyle: config.get('MEDIA_BUCKET_FORCE_PATH_STYLE', { infer: true }),
        region: config.get('MEDIA_BUCKET_REGION', { infer: true }),
        secretAccessKey: config.get('MEDIA_BUCKET_SECRET_ACCESS_KEY', { infer: true })!,
      });
  }

  onApplicationBootstrap(): void {
    if (!this.storage) return;
    this.timer = setInterval(
      () => void this.scanSafely(),
      this.config.get('MEDIA_RETENTION_INTERVAL_MS', { infer: true }),
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scanOnce(now = new Date()): Promise<number> {
    if (!this.storage || this.scanning) return 0;
    this.scanning = true;
    try {
      const assets = await this.database.client.mediaAsset.findMany({
        orderBy: { retentionUntil: 'asc' },
        take: this.config.get('MEDIA_RETENTION_BATCH_SIZE', { infer: true }),
        where: {
          bucketKey: { not: null },
          retentionUntil: { lte: now },
          status: 'AVAILABLE',
          emailReferences: { none: {} },
          templateVersions: { none: { status: { in: ['PUBLISHED', 'SUPERSEDED'] } } },
        },
      });
      let deleted = 0;
      for (const asset of assets) {
        if (!asset.bucketKey) continue;
        try {
          await this.storage.deleteObject(asset.bucketKey);
          const updated = await this.database.client.mediaAsset.updateMany({
            data: { bucketKey: null, deletedAt: new Date(), status: 'DELETED' },
            where: {
              bucketKey: asset.bucketKey,
              id: asset.id,
              projectId: asset.projectId,
              status: 'AVAILABLE',
            },
          });
          deleted += updated.count;
        } catch {
          this.logger.warn({ assetId: asset.id, message: 'media_retention_delete_failed' });
        }
      }
      this.logger.log({ deleted, message: 'media_retention_scan', scanned: assets.length });
      return deleted;
    } finally {
      this.scanning = false;
    }
  }

  private async scanSafely(): Promise<void> {
    try {
      await this.scanOnce();
    } catch {
      this.logger.warn({ message: 'media_retention_scan_failed' });
    }
  }
}
