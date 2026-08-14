import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiEnvironment } from '@omnicus/config/server';
import { ChannelSecretsService, type EncryptedSecretEnvelope } from '@omnicus/channel-secrets';
import {
  TelegramAdapter,
  TelegramApiError,
  TelegramHttpTransport,
} from '@omnicus/channel-telegram';
import { WhatsAppApiError, WhatsAppCloudApi } from '@omnicus/channel-whatsapp';
import {
  MediaValidationError,
  prepareMediaForEmail,
  prepareMediaForTelegram,
  prepareMediaForWhatsApp,
  S3MediaStorage,
  type MediaKind,
} from '@omnicus/media-core';

import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { RequestSecurityContext } from '../auth/auth.service';
import { DatabaseService } from '../database/database.service';

interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

@Injectable()
export class MediaService {
  private readonly maximumBytes: number;
  private readonly retentionDays: number;
  private readonly signedUrlTtl: number;
  private readonly secrets: ChannelSecretsService;
  private readonly storage: S3MediaStorage | undefined;
  private readonly telegram = new TelegramAdapter(new TelegramHttpTransport());
  private readonly whatsapp = new WhatsAppCloudApi();

  constructor(
    @Inject(ConfigService) config: ConfigService<ApiEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.maximumBytes = config.get('MEDIA_MAX_UPLOAD_BYTES', { infer: true });
    this.retentionDays = config.get('MEDIA_RETENTION_DAYS', { infer: true });
    this.signedUrlTtl = config.get('MEDIA_SIGNED_URL_TTL_SECONDS', { infer: true });
    this.secrets = new ChannelSecretsService(config.get('CHANNEL_SECRETS_KEY', { infer: true }));
    if (config.get('MEDIA_STORAGE_ENABLED', { infer: true })) {
      this.storage = new S3MediaStorage({
        accessKeyId: config.get('MEDIA_BUCKET_ACCESS_KEY_ID', { infer: true })!,
        bucket: config.get('MEDIA_BUCKET', { infer: true })!,
        endpoint: config.get('MEDIA_BUCKET_ENDPOINT', { infer: true })!,
        forcePathStyle: config.get('MEDIA_BUCKET_FORCE_PATH_STYLE', { infer: true }),
        region: config.get('MEDIA_BUCKET_REGION', { infer: true }),
        secretAccessKey: config.get('MEDIA_BUCKET_SECRET_ACCESS_KEY', { infer: true })!,
      });
    }
  }

  async list(projectId: string) {
    const assets = await this.database.client.mediaAsset.findMany({
      orderBy: { createdAt: 'desc' },
      where: { projectId, status: { not: 'DELETED' } },
    });
    return assets.map((asset) => this.safe(asset));
  }

  async get(projectId: string, assetId: string) {
    const asset = await this.asset(projectId, assetId);
    return this.safe(asset);
  }

  async upload(
    projectId: string,
    kind: MediaKind,
    file: UploadedFile | undefined,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
    channel: 'email' | 'telegram' | 'whatsapp' = 'telegram',
  ) {
    const stored = await this.store(projectId, kind, file, undefined, channel);
    await this.audit.record({
      action: 'media.uploaded',
      actorUserId: actor.userId,
      afterSafeJson: { kind, sizeBytes: stored.sizeBytes },
      correlationId: context.correlationId,
      entityId: stored.asset.id,
      entityType: 'MediaAsset',
      projectId,
    });
    return this.safe(stored.asset);
  }

  async uploadFromService(
    projectId: string,
    kind: MediaKind,
    file: UploadedFile | undefined,
    idempotencyKey: string,
    correlationId: string,
    channel: 'telegram' | 'whatsapp' = 'telegram',
  ) {
    const digest = createHash('sha256')
      .update(
        channel === 'telegram'
          ? `${projectId}:crm-media:${idempotencyKey}`
          : `${projectId}:crm-media:${channel}:${idempotencyKey}`,
      )
      .digest('hex');
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(
      13,
      16,
    )}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const stored = await this.store(projectId, kind, file, id, channel);
    await this.audit.record({
      action: 'crm.media_uploaded',
      actorType: 'SERVICE',
      afterSafeJson: { kind, sizeBytes: stored.sizeBytes },
      correlationId,
      entityId: stored.asset.id,
      entityType: 'MediaAsset',
      projectId,
    });
    return this.safe(stored.asset);
  }

  private async store(
    projectId: string,
    kind: MediaKind,
    file: UploadedFile | undefined,
    requestedId?: string,
    channel: 'email' | 'telegram' | 'whatsapp' = 'telegram',
  ) {
    if (!file)
      throw new BadRequestException({ code: 'MEDIA_FILE_REQUIRED', message: 'A file is required' });
    const storage = this.requireStorage();
    let validated;
    try {
      const prepare =
        channel === 'email'
          ? prepareMediaForEmail
          : channel === 'whatsapp'
            ? prepareMediaForWhatsApp
            : prepareMediaForTelegram;
      validated = await prepare({
        bytes: file.buffer,
        declaredMimeType: file.mimetype,
        filename: file.originalname,
        kind,
        maximumBytes: this.maximumBytes,
      });
    } catch (error) {
      if (error instanceof MediaValidationError)
        throw new BadRequestException({ code: error.code, message: 'Media file was rejected' });
      throw error;
    }
    const id = requestedId ?? randomUUID();
    const bucketKey = `${projectId}/assets/${channel}/${id}.${validated.extension}`;
    const checksumSha256 = createHash('sha256').update(validated.bytes).digest('hex');
    const existing = await this.database.client.mediaAsset.findUnique({
      where: { projectId_id: { id, projectId } },
    });
    const existingValidationChannel = existing
      ? this.validationChannel(existing.source, existing.providerMetadata)
      : undefined;
    if (
      existing &&
      (existing.kind !== kind ||
        existing.checksumSha256 !== checksumSha256 ||
        (existingValidationChannel !== undefined && existingValidationChannel !== channel) ||
        (existingValidationChannel === undefined && channel !== 'telegram'))
    )
      throw new ConflictException({
        code: 'MEDIA_IDEMPOTENCY_CONFLICT',
        message: 'The media idempotency key was already used for different content',
      });
    if (existing?.status === 'AVAILABLE')
      return { asset: existing, sizeBytes: validated.sizeBytes };
    const pending = existing
      ? await this.database.client.mediaAsset.update({
          data: {
            bucketKey,
            checksumSha256,
            declaredMimeType: file.mimetype,
            detectedMimeType: validated.mimeType,
            extension: validated.extension,
            originalFilename: file.originalname,
            providerMetadata: { validationChannel: channel },
            sizeBytes: BigInt(validated.sizeBytes),
            status: 'PENDING_UPLOAD',
          },
          where: { projectId_id: { id, projectId } },
        })
      : await this.database.client.mediaAsset.create({
          data: {
            bucketKey,
            checksumSha256,
            declaredMimeType: file.mimetype,
            detectedMimeType: validated.mimeType,
            extension: validated.extension,
            id,
            kind,
            originalFilename: file.originalname,
            providerMetadata: { validationChannel: channel },
            projectId,
            sizeBytes: BigInt(validated.sizeBytes),
            source: 'USER_UPLOAD',
            status: 'PENDING_UPLOAD',
          },
        });
    try {
      await storage.putObject(bucketKey, validated.bytes, validated.mimeType, {
        assetId: id,
        projectId,
      });
    } catch {
      await this.database.client.mediaAsset.updateMany({
        data: { status: 'UNAVAILABLE' },
        where: { id, projectId, status: 'PENDING_UPLOAD' },
      });
      throw new ServiceUnavailableException({
        code: 'MEDIA_STORAGE_UNAVAILABLE',
        message: 'Media storage is temporarily unavailable',
      });
    }
    const asset = await this.database.client.mediaAsset.update({
      data: { availableAt: new Date(), status: 'AVAILABLE' },
      where: { projectId_id: { id: pending.id, projectId } },
    });
    return { asset, sizeBytes: validated.sizeBytes };
  }

  async materialize(
    projectId: string,
    assetId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const asset = await this.asset(projectId, assetId);
    if (asset.status === 'AVAILABLE') return this.safe(asset);
    if (
      !['TELEGRAM', 'WHATSAPP'].includes(asset.source) ||
      !asset.connectionId ||
      !asset.providerMediaId ||
      asset.status !== 'PROVIDER_REFERENCE'
    )
      throw new BadRequestException({
        code: 'MEDIA_CANNOT_MATERIALIZE',
        message: 'Media cannot be materialized',
      });
    const storage = this.requireStorage();
    const connection = await this.database.client.channelConnection.findUnique({
      where: { projectId_id: { id: asset.connectionId, projectId } },
    });
    if (!connection)
      throw new NotFoundException({
        code: 'MEDIA_CONNECTION_NOT_FOUND',
        message: 'Media connection was not found',
      });
    if (
      (asset.source === 'TELEGRAM' && connection.type !== 'TELEGRAM') ||
      (asset.source === 'WHATSAPP' && connection.type !== 'WHATSAPP')
    )
      throw new NotFoundException({
        code: 'MEDIA_CONNECTION_NOT_FOUND',
        message: 'Media connection was not found',
      });
    let downloaded: { bytes: Uint8Array; contentType?: string; filePath?: string };
    try {
      if (asset.source === 'TELEGRAM') {
        const token = this.secrets.decryptSecret({
          channelConnectionId: connection.id,
          channelType: 'telegram',
          envelope: connection.credentialsEncrypted as unknown as EncryptedSecretEnvelope,
          field: 'botToken',
          projectId,
        });
        downloaded = await this.telegram.downloadFile(
          token,
          asset.providerMediaId,
          this.maximumBytes,
        );
      } else {
        const credentials =
          connection.credentialsEncrypted &&
          typeof connection.credentialsEncrypted === 'object' &&
          !Array.isArray(connection.credentialsEncrypted)
            ? (connection.credentialsEncrypted as unknown as {
                accessToken?: EncryptedSecretEnvelope;
              })
            : {};
        if (!credentials.accessToken)
          throw new ServiceUnavailableException({
            code: 'WHATSAPP_MEDIA_UNAVAILABLE',
            message: 'WhatsApp media is unavailable',
          });
        const metadata =
          connection.webhookMetadata &&
          typeof connection.webhookMetadata === 'object' &&
          !Array.isArray(connection.webhookMetadata)
            ? (connection.webhookMetadata as Record<string, unknown>)
            : {};
        const graphApiVersion = metadata.graphApiVersion;
        if (typeof graphApiVersion !== 'string' || !graphApiVersion)
          throw new ServiceUnavailableException({
            code: 'WHATSAPP_MEDIA_UNAVAILABLE',
            message: 'WhatsApp media is unavailable',
          });
        const token = this.secrets.decryptSecret({
          channelConnectionId: connection.id,
          channelType: 'whatsapp',
          envelope: credentials.accessToken,
          field: 'accessToken',
          projectId,
        });
        downloaded = await this.whatsapp.downloadMedia({
          accessToken: token,
          graphApiVersion,
          maximumBytes: this.maximumBytes,
          mediaId: asset.providerMediaId,
        });
      }
    } catch (error) {
      if (
        (error instanceof TelegramApiError && error.errorCode === 400) ||
        (error instanceof WhatsAppApiError && [400, 404, 410, 413].includes(error.status))
      )
        await this.database.client.mediaAsset.update({
          data: { status: 'UNAVAILABLE' },
          where: { projectId_id: { id: asset.id, projectId } },
        });
      throw new ServiceUnavailableException({
        code:
          asset.source === 'TELEGRAM' ? 'TELEGRAM_MEDIA_UNAVAILABLE' : 'WHATSAPP_MEDIA_UNAVAILABLE',
        message:
          asset.source === 'TELEGRAM'
            ? 'Telegram media is unavailable'
            : 'WhatsApp media is unavailable',
      });
    }
    let validated;
    try {
      const prepare =
        asset.source === 'WHATSAPP' ? prepareMediaForWhatsApp : prepareMediaForTelegram;
      validated = await prepare({
        bytes: downloaded.bytes,
        ...(downloaded.contentType || asset.declaredMimeType
          ? { declaredMimeType: downloaded.contentType ?? asset.declaredMimeType! }
          : {}),
        ...(asset.originalFilename ? { filename: asset.originalFilename } : {}),
        kind: asset.kind as MediaKind,
        maximumBytes: this.maximumBytes,
      });
    } catch (error) {
      const code = error instanceof MediaValidationError ? error.code : 'media_validation_failed';
      await this.database.client.mediaAsset.update({
        data: { rejectedAt: new Date(), status: 'REJECTED' },
        where: { projectId_id: { id: asset.id, projectId } },
      });
      throw new BadRequestException({
        code,
        message:
          asset.source === 'TELEGRAM'
            ? 'Telegram media was rejected'
            : 'WhatsApp media was rejected',
      });
    }
    const providerPath = asset.source === 'WHATSAPP' ? 'whatsapp' : 'telegram';
    const bucketKey = `${projectId}/${providerPath}/${asset.id}.${validated.extension}`;
    try {
      await storage.putObject(bucketKey, validated.bytes, validated.mimeType, {
        assetId: asset.id,
        projectId,
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'MEDIA_STORAGE_UNAVAILABLE',
        message: 'Media storage is temporarily unavailable',
      });
    }
    const updated = await this.database.client.mediaAsset.update({
      data: {
        availableAt: new Date(),
        bucketKey,
        checksumSha256: createHash('sha256').update(validated.bytes).digest('hex'),
        detectedMimeType: validated.mimeType,
        extension: validated.extension,
        providerMetadata: {
          ...(asset.providerMetadata as object | null),
          ...(asset.source === 'WHATSAPP'
            ? { materializedFromWhatsApp: true }
            : { materializedFromTelegram: true }),
        },
        retentionUntil: new Date(Date.now() + this.retentionDays * 86_400_000),
        sizeBytes: BigInt(validated.sizeBytes),
        status: 'AVAILABLE',
      },
      where: { projectId_id: { id: asset.id, projectId } },
    });
    await this.audit.record({
      action: 'media.materialized',
      actorUserId: actor.userId,
      afterSafeJson: { kind: asset.kind, sizeBytes: validated.sizeBytes },
      correlationId: context.correlationId,
      entityId: asset.id,
      entityType: 'MediaAsset',
      projectId,
    });
    return this.safe(updated);
  }

  async signedUrl(projectId: string, assetId: string) {
    const asset = await this.asset(projectId, assetId);
    if (asset.status !== 'AVAILABLE' || !asset.bucketKey)
      throw new BadRequestException({
        code: 'MEDIA_NOT_AVAILABLE',
        message: 'Media is not available',
      });
    return {
      expiresInSeconds: this.signedUrlTtl,
      url: await this.requireStorage().signedDownloadUrl(asset.bucketKey, this.signedUrlTtl),
    };
  }

  async remove(
    projectId: string,
    assetId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const asset = await this.asset(projectId, assetId);
    const [publishedUsage, emailUsage] = await Promise.all([
      this.database.client.messageTemplateVersion.count({
        where: {
          mediaAssetId: assetId,
          projectId,
          status: { in: ['PUBLISHED', 'SUPERSEDED'] },
        },
      }),
      this.database.client.emailAssetReference.count({
        where: { mediaAssetId: assetId, projectId },
      }),
    ]);
    if (publishedUsage || emailUsage)
      throw new BadRequestException({
        code: 'MEDIA_USED_BY_PUBLISHED_TEMPLATE',
        message: 'Published templates still reference this media',
      });
    if (asset.bucketKey) await this.requireStorage().deleteObject(asset.bucketKey);
    await this.database.client.mediaAsset.update({
      data: { bucketKey: null, deletedAt: new Date(), status: 'DELETED' },
      where: { projectId_id: { id: assetId, projectId } },
    });
    await this.audit.record({
      action: 'media.deleted',
      actorUserId: actor.userId,
      correlationId: context.correlationId,
      entityId: assetId,
      entityType: 'MediaAsset',
      projectId,
    });
    return { deleted: true };
  }

  private async asset(projectId: string, assetId: string) {
    const asset = await this.database.client.mediaAsset.findUnique({
      where: { projectId_id: { id: assetId, projectId } },
    });
    if (!asset)
      throw new NotFoundException({
        code: 'MEDIA_ASSET_NOT_FOUND',
        message: 'Media asset was not found',
      });
    return asset;
  }

  private requireStorage(): S3MediaStorage {
    if (!this.storage)
      throw new ServiceUnavailableException({
        code: 'MEDIA_STORAGE_NOT_CONFIGURED',
        message: 'Media storage is not configured',
      });
    return this.storage;
  }

  private safe(asset: {
    bucketKey: string | null;
    providerMetadata?: unknown;
    sizeBytes: bigint | null;
    source?: unknown;
    [key: string]: unknown;
  }) {
    const safe: Record<string, unknown> = { ...asset };
    delete safe.bucketKey;
    delete safe.providerMetadata;
    safe.sizeBytes = asset.sizeBytes?.toString() ?? null;
    const validationChannel = this.validationChannel(asset.source, asset.providerMetadata);
    if (validationChannel) safe.validationChannel = validationChannel;
    return safe;
  }

  private validationChannel(
    source: unknown,
    providerMetadata: unknown,
  ): 'telegram' | 'whatsapp' | undefined {
    if (
      providerMetadata &&
      typeof providerMetadata === 'object' &&
      !Array.isArray(providerMetadata)
    ) {
      const value = (providerMetadata as Record<string, unknown>).validationChannel;
      if (value === 'telegram' || value === 'whatsapp') return value;
    }
    if (source === 'TELEGRAM') return 'telegram';
    if (source === 'WHATSAPP') return 'whatsapp';
    return undefined;
  }
}
