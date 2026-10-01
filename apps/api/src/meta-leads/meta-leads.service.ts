import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelSecretsService, type EncryptedSecretEnvelope } from '@omnicus/channel-secrets';
import type { ApiEnvironment } from '@omnicus/config/server';
import { Prisma, type MetaLeadConfig } from '@omnicus/database';
import { DatabaseService } from '../database/database.service';
import { MetaGraphClient, record } from './meta-graph.client';
import { metaError } from './meta-leads.errors';
import type {
  MetaLeadHistoryDto,
  SaveMetaLeadConfigDto,
  StartMetaLeadsDto,
} from './meta-leads.dto';

export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

// This response is emitted before the CRM enters its creation critical section.
export class MetaCrmBusyError extends Error {
  constructor() {
    super('META_LEADS_CRM_BUSY');
  }
}

@Injectable()
export class MetaLeadsService {
  private readonly secrets: ChannelSecretsService;
  constructor(
    @Inject(DatabaseService) readonly database: DatabaseService,
    @Inject(ConfigService) config: ConfigService<ApiEnvironment, true>,
  ) {
    this.secrets = new ChannelSecretsService(config.get('CHANNEL_SECRETS_KEY', { infer: true }));
  }

  async configuration(projectId: string) {
    const config = await this.database.client.metaLeadConfig.findUnique({ where: { projectId } });
    if (!config) throw new NotFoundException(metaError('META_LEADS_NOT_CONFIGURED'));
    return config;
  }

  async safeConfig(projectId: string) {
    const config = await this.database.client.metaLeadConfig.findUnique({ where: { projectId } });
    if (!config) return null;
    return {
      id: config.id,
      projectId: config.projectId,
      pageId: config.pageId,
      formIds: config.formIds,
      graphVersion: config.graphVersion,
      enabled: config.enabled,
      deliveryEnabled: config.deliveryEnabled,
      liveFrom: config.liveFrom,
      verifiedAt: config.verifiedAt,
      credentialsConfigured: true,
      webhookPath: `/webhooks/meta-leads/${projectId}`,
    };
  }

  secret(config: MetaLeadConfig, field: string): string {
    const envelope = record(config.credentialsEncrypted)[field];
    if (!envelope)
      throw new ServiceUnavailableException(metaError('META_LEADS_CREDENTIAL_UNAVAILABLE'));
    try {
      return this.secrets.decryptSecret({
        channelConnectionId: config.id,
        channelType: 'meta-leads',
        field,
        projectId: config.projectId,
        envelope: envelope as EncryptedSecretEnvelope,
      });
    } catch {
      throw new ServiceUnavailableException(metaError('META_LEADS_CREDENTIAL_UNAVAILABLE'));
    }
  }

  graph(config: MetaLeadConfig) {
    return new MetaGraphClient(this.secret(config, 'pageToken'), config.graphVersion);
  }

  async save(projectId: string, input: SaveMetaLeadConfigDto) {
    await this.crmRoute(projectId);
    const old = await this.database.client.metaLeadConfig.findUnique({ where: { projectId } });
    if (old?.enabled) throw new ConflictException(metaError('META_LEADS_STOP_BEFORE_EDIT'));
    if (old && old.pageId !== input.pageId)
      throw new ConflictException(metaError('META_LEADS_PAGE_IMMUTABLE'));
    const id = old?.id ?? randomUUID();
    const encrypted = { ...record(old?.credentialsEncrypted) };
    for (const field of ['pageToken', 'appSecret', 'verifyToken'] as const) {
      const plaintext = input[field]?.trim();
      if (plaintext)
        encrypted[field] = this.secrets.encryptSecret({
          channelConnectionId: id,
          channelType: 'meta-leads',
          field,
          projectId,
          plaintext,
        });
      if (!encrypted[field])
        throw new BadRequestException(metaError('META_LEADS_CREDENTIALS_REQUIRED'));
    }
    if (old) {
      const saved = await this.database.client.metaLeadConfig.updateMany({
        where: { projectId, enabled: false, updatedAt: old.updatedAt },
        data: {
          formIds: input.formIds,
          graphVersion: input.graphVersion,
          credentialsEncrypted: json(encrypted),
          verifiedAt: null,
          deliveryEnabled: false,
        },
      });
      if (!saved.count) throw new ConflictException(metaError('META_LEADS_STOP_BEFORE_EDIT'));
    } else
      await this.database.client.metaLeadConfig.create({
        data: {
          id,
          projectId,
          pageId: input.pageId,
          formIds: input.formIds,
          graphVersion: input.graphVersion,
          credentialsEncrypted: json(encrypted),
        },
      });
    return this.safeConfig(projectId);
  }

  async test(projectId: string) {
    const config = await this.configuration(projectId);
    const graph = this.graph(config);
    const page = await graph.get('me', { fields: 'id' });
    if (page.id !== config.pageId)
      throw new BadRequestException(metaError('META_LEADS_PAGE_TOKEN_MISMATCH'));
    for (const formId of config.formIds) {
      const form = await graph.get(formId, { fields: 'id,page_id' });
      if (form.id !== formId || String(form.page_id) !== config.pageId)
        throw new BadRequestException(metaError('META_LEADS_FORM_PAGE_MISMATCH'));
      // Verify actual lead-read permission as well, without importing anything.
      await graph.get(`${formId}/leads`, { fields: 'id', limit: '1' });
    }
    await this.crm(projectId, 'preview', {
      pageId: config.pageId,
      formId: config.formIds[0],
      leadId: '0',
      createdAt: new Date().toISOString(),
    });
    const verified = await this.database.client.metaLeadConfig.updateMany({
      where: { projectId, updatedAt: config.updatedAt },
      data: { verifiedAt: new Date() },
    });
    if (!verified.count) throw new ConflictException(metaError('META_LEADS_TEST_REQUIRED'));
    return { ok: true };
  }

  async start(projectId: string, input: StartMetaLeadsDto) {
    const config = await this.configuration(projectId);
    if (!config.verifiedAt) throw new ConflictException(metaError('META_LEADS_TEST_REQUIRED'));
    const from = new Date(input.liveFrom);
    // Historical loading is a separate explicit preview workflow.
    if (
      !Number.isFinite(from.getTime()) ||
      (!config.liveFrom && from.getTime() < Date.now() - 10 * 60_000) ||
      from.getTime() > Date.now() + 24 * 60 * 60_000
    )
      throw new BadRequestException(metaError('META_LEADS_LIVE_FROM_INVALID'));
    if (config.liveFrom && config.liveFrom.getTime() !== from.getTime())
      throw new ConflictException(metaError('META_LEADS_CUTOVER_IMMUTABLE'));
    await this.database.client.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`meta-start:${projectId}`}, 0))`,
      );
      const started = await tx.metaLeadConfig.updateMany({
        where: { projectId, updatedAt: config.updatedAt, verifiedAt: { not: null } },
        data: { enabled: true, deliveryEnabled: input.deliveryEnabled, liveFrom: from },
      });
      if (!started.count) throw new ConflictException(metaError('META_LEADS_TEST_REQUIRED'));
      for (const formId of config.formIds) {
        const existing = await tx.metaLeadPoll.findFirst({
          where: { projectId, formId, historical: false },
        });
        if (!existing)
          await tx.metaLeadPoll.create({ data: { projectId, configId: config.id, formId, from } });
      }
    });
    return this.safeConfig(projectId);
  }

  async stop(projectId: string) {
    await this.database.client.metaLeadConfig.update({
      where: { projectId },
      data: { enabled: false, deliveryEnabled: false },
    });
    return this.safeConfig(projectId);
  }

  async history(projectId: string, input: MetaLeadHistoryDto): Promise<{ count: number }> {
    const config = await this.configuration(projectId);
    if (!config.enabled) throw new ConflictException(metaError('META_LEADS_DISABLED'));
    if (!config.verifiedAt) throw new ConflictException(metaError('META_LEADS_TEST_REQUIRED'));
    const from = new Date(input.from),
      until = new Date(input.until);
    if (
      from >= until ||
      until.getTime() > Date.now() ||
      until.getTime() - from.getTime() > 90 * 86_400_000
    )
      throw new BadRequestException(metaError('META_LEADS_HISTORY_RANGE_INVALID'));
    // Intake may be enabled in preview mode. This action never enables live writes.
    return this.database.client.metaLeadPoll.createMany({
      data: config.formIds.map((formId) => ({
        projectId,
        configId: config.id,
        formId,
        from,
        until,
        historical: true,
      })),
    });
  }

  async approve(projectId: string, id: string, confirmHistoricalImport: boolean) {
    const config = await this.configuration(projectId);
    if (!config.enabled) throw new ConflictException(metaError('META_LEADS_DISABLED'));
    const row = await this.database.client.metaLeadSubmission.findFirst({
      where: { id, projectId },
    });
    if (!row) throw new NotFoundException(metaError('META_LEAD_NOT_FOUND'));
    if (row.historical && !confirmHistoricalImport)
      throw new BadRequestException(metaError('META_LEADS_HISTORY_CONFIRMATION_REQUIRED'));
    const result = await this.database.client.metaLeadSubmission.updateMany({
      where: { id, projectId, state: { in: ['PREVIEW_NEW', 'PREVIEW_MATCH'] } },
      data: { approved: true, notify: false, state: 'READY', nextAttemptAt: new Date() },
    });
    if (!result.count) throw new ConflictException(metaError('META_LEAD_NOT_APPROVABLE'));
    return { queued: true };
  }

  async retry(projectId: string, id: string, confirmUnknownRetry: boolean) {
    const row = await this.database.client.metaLeadSubmission.findFirst({
      where: { id, projectId },
    });
    if (!row) throw new NotFoundException(metaError('META_LEAD_NOT_FOUND'));
    if (!['REVIEW', 'ERROR', 'UNKNOWN'].includes(row.state))
      throw new ConflictException(metaError('META_LEAD_NOT_RETRYABLE'));
    if (row.state === 'UNKNOWN' && !confirmUnknownRetry)
      throw new BadRequestException(metaError('META_LEAD_UNKNOWN_CONFIRMATION_REQUIRED'));
    if (row.lockedUntil && row.lockedUntil > new Date())
      throw new ConflictException(metaError('META_LEAD_BUSY'));
    await this.database.client.metaLeadSubmission.updateMany({
      where: { id, projectId, state: row.state, lockedBy: row.lockedBy },
      data: {
        state: row.payload ? 'READY' : 'FETCH',
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
      },
    });
    return { queued: true };
  }

  async verify(projectId: string, mode?: string, token?: string, challenge?: string) {
    const config = await this.configuration(projectId);
    const expected = this.secret(config, 'verifyToken');
    if (mode !== 'subscribe' || !token || !challenge || !safeEqual(expected, token))
      throw new ForbiddenException(metaError('META_LEADS_VERIFICATION_FAILED'));
    return challenge;
  }

  async receive(
    projectId: string,
    rawBody: Buffer | undefined,
    signature: string | undefined,
    body: unknown,
  ) {
    const config = await this.configuration(projectId);
    if (!rawBody || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature))
      throw new ForbiddenException(metaError('META_LEADS_SIGNATURE_INVALID'));
    const expected = createHmac('sha256', this.secret(config, 'appSecret'))
      .update(rawBody)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex')))
      throw new ForbiddenException(metaError('META_LEADS_SIGNATURE_INVALID'));
    if (!config.enabled) throw new ServiceUnavailableException(metaError('META_LEADS_DISABLED'));
    const envelope = record(body);
    if (envelope.object !== 'page' || !Array.isArray(envelope.entry) || envelope.entry.length > 100)
      throw new BadRequestException(metaError('META_LEADS_ENVELOPE_INVALID'));
    const rows: Prisma.MetaLeadSubmissionCreateManyInput[] = [];
    let count = 0;
    for (const raw of envelope.entry) {
      const entry = record(raw);
      if (entry.id !== config.pageId || !Array.isArray(entry.changes)) continue;
      for (const rawChange of entry.changes) {
        if (++count > 500)
          throw new BadRequestException(metaError('META_LEADS_ENVELOPE_TOO_LARGE'));
        const change = record(rawChange),
          value = record(change.value);
        if (change.field !== 'leadgen') continue;
        if (
          typeof value.leadgen_id !== 'string' ||
          !/^\d{1,30}$/.test(value.leadgen_id) ||
          typeof value.form_id !== 'string' ||
          !config.formIds.includes(value.form_id) ||
          (value.page_id && value.page_id !== config.pageId)
        )
          continue;
        rows.push({
          configId: config.id,
          projectId,
          pageId: config.pageId,
          formId: value.form_id,
          leadId: value.leadgen_id,
        });
      }
    }
    // Single transaction; a 200 means the receipt is durable. No provider/CRM call here.
    await this.database.client.metaLeadSubmission.createMany({ data: rows, skipDuplicates: true });
    return { ok: true };
  }

  async crmRoute(projectId: string) {
    const route = await this.database.client.crmProjectConfig.findUnique({ where: { projectId } });
    if (
      !route?.enabled ||
      route.status !== 'ACTIVE' ||
      !route.baseUrl ||
      !route.credentialsEncrypted
    )
      throw new ConflictException(metaError('META_LEADS_CRM_PAIRING_REQUIRED'));
    return route;
  }

  async crm(
    projectId: string,
    action: 'preview' | 'apply' | 'reconcile',
    payload: Record<string, unknown>,
  ) {
    const route = await this.crmRoute(projectId);
    const token = this.secrets.decryptSecret({
      channelConnectionId: route.id,
      channelType: 'crm',
      field: 'authToken',
      projectId,
      envelope: route.credentialsEncrypted as unknown as EncryptedSecretEnvelope,
    });
    const url = new URL(`/integrations/v1/omnicus/meta-leads/v1/${action}`, route.baseUrl!);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('META_LEADS_CRM_HTTPS_REQUIRED');
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        crmProjectId: route.crmProjectId,
        omnicusProjectId: projectId,
      }),
    });
    if (!response.ok) {
      const failure = record(await response.json().catch(() => null));
      if (response.status === 503 && record(failure.error).code === 'LEAD_CREATION_BUSY')
        throw new MetaCrmBusyError();
      throw new Error(`META_LEADS_CRM_HTTP_${response.status}`);
    }
    const result = record(await response.json());
    if (
      !['NEW', 'MATCH', 'REVIEW', 'LINKED', 'CREATED', 'NOT_FOUND'].includes(String(result.outcome))
    )
      throw new Error('META_LEADS_CRM_RESPONSE_INVALID');
    return result;
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
