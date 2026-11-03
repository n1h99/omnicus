import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelSecretsService, type EncryptedSecretEnvelope } from '@omnicus/channel-secrets';
import type { ApiEnvironment } from '@omnicus/config/server';
import { Prisma } from '@omnicus/database';
import { DatabaseService } from '../database/database.service';
import { WebinarStarsClient, WebinarStarsError } from './webinar-stars.client';
import type { ReportListDto, SaveWebinarConnectionDto, WebinarListDto } from './webinar-stars.dto';

@Injectable()
export class WebinarStarsService {
  private readonly secrets: ChannelSecretsService;
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) config: ConfigService<ApiEnvironment, true>,
  ) {
    this.secrets = new ChannelSecretsService(config.get('CHANNEL_SECRETS_KEY', { infer: true }));
  }
  private context(projectId: string) {
    return {
      projectId,
      channelConnectionId: projectId,
      channelType: 'webinar-stars',
      field: 'apiToken',
    };
  }
  async config(projectId: string) {
    const row = await this.database.client.webinarConnection.findUnique({
      where: { projectId },
      select: {
        id: true,
        verifiedAt: true,
        updatedAt: true,
        revision: true,
        connected: true,
        enabled: true,
        enabledAt: true,
        webhookSecretHash: true,
        lastPollError: true,
        nextPollAt: true,
      },
    });
    if (!row || row.connected === false) return null;
    return {
      id: row.id,
      verifiedAt: row.verifiedAt,
      updatedAt: row.updatedAt,
      revision: row.revision,
      connected: row.connected,
      enabled: row.enabled,
      enabledAt: row.enabledAt,
      lastPollError: row.lastPollError,
      nextPollAt: row.nextPollAt,
      webhookConfigured: Boolean(row.webhookSecretHash),
    };
  }
  async save(projectId: string, input: SaveWebinarConnectionDto) {
    const envelope = this.secrets.encryptSecret({
      ...this.context(projectId),
      plaintext: input.token,
    });
    const tokenEncrypted = JSON.parse(JSON.stringify(envelope)) as Prisma.InputJsonValue;
    await this.database.client.webinarConnection.upsert({
      where: { projectId },
      create: { projectId, tokenEncrypted },
      update: {
        tokenEncrypted,
        connected: true,
        enabled: false,
        verifiedAt: null,
        revision: { increment: 1 },
      },
    });
    return this.config(projectId);
  }
  async disconnect(projectId: string) {
    await this.database.client.webinarConnection.updateMany({
      where: { projectId },
      data: {
        tokenEncrypted: Prisma.DbNull,
        connected: false,
        enabled: false,
        webhookSecretHash: null,
        verifiedAt: null,
        revision: { increment: 1 },
      },
    });
    return { disconnected: true };
  }
  async connection(projectId: string) {
    const row = await this.database.client.webinarConnection.findUnique({ where: { projectId } });
    if (!row || row.connected === false)
      throw new NotFoundException({ code: 'WEBINAR_STARS_NOT_CONFIGURED' });
    try {
      const token = this.secrets.decryptSecret({
        ...this.context(projectId),
        envelope: row.tokenEncrypted as unknown as EncryptedSecretEnvelope,
      });
      return { row, client: new WebinarStarsClient(token) };
    } catch {
      throw new ServiceUnavailableException({ code: 'WEBINAR_STARS_CREDENTIAL_UNAVAILABLE' });
    }
  }
  private async provider<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof WebinarStarsError)) throw error;
      const status =
        error.code === 'WEBINAR_STARS_ACCESS_DENIED'
          ? 400
          : error.code === 'WEBINAR_STARS_REPORT_NOT_FOUND'
            ? 404
            : error.code === 'WEBINAR_STARS_RATE_LIMITED'
              ? 429
              : 502;
      throw new HttpException({ code: error.code }, status);
    }
  }
  async test(projectId: string) {
    const { row, client } = await this.connection(projectId);
    await this.provider(() => client.webinars({ limit: 1, offset: 0 }));
    const result = await this.database.client.webinarConnection.updateMany({
      where: { projectId, id: row.id, revision: row.revision },
      data: { verifiedAt: new Date() },
    });
    if (!result.count) throw new ConflictException({ code: 'WEBINAR_STARS_CONNECTION_CHANGED' });
    return { ok: true };
  }
  async webinars(projectId: string, input: WebinarListDto) {
    const { client } = await this.connection(projectId);
    return this.provider(() => client.webinars(input));
  }
  async reports(projectId: string, input: ReportListDto) {
    for (const value of [input.from, input.to]) {
      if (
        value &&
        (!Number.isFinite(Date.parse(value)) ||
          new Date(value).toISOString().slice(0, 10) !== value)
      )
        throw new BadRequestException({ code: 'WEBINAR_STARS_DATE_RANGE_INVALID' });
    }
    if (input.from && input.to && input.from > input.to)
      throw new BadRequestException({ code: 'WEBINAR_STARS_DATE_RANGE_INVALID' });
    const { client } = await this.connection(projectId);
    return this.provider(() => client.reports(input));
  }
  async report(projectId: string, reportId: string) {
    if (!/^\d{1,30}$/.test(reportId))
      throw new BadRequestException({ code: 'WEBINAR_STARS_REPORT_ID_INVALID' });
    const { client } = await this.connection(projectId);
    return this.provider(() => client.report(reportId));
  }
}
