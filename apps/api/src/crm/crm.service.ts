import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelSecretsService, type EncryptedSecretEnvelope } from '@omnicus/channel-secrets';
import type { ApiEnvironment } from '@omnicus/config/server';
import type { Prisma } from '@omnicus/database';

import type { AuthenticatedUser } from '../auth/auth.types';
import type { RequestSecurityContext } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import type {
  CompleteCrmPairingDto,
  RetryCrmOperationDto,
  StartCrmPairingDto,
  UpsertCrmProjectConfigDto,
  CrmOperationsQueryDto,
} from './dto';

type SafeCrmOperation = {
  attempts: number;
  createdAt: Date;
  id: string;
  lastError: string | null;
  resultSafe: unknown;
  status: 'FAILED' | 'PENDING' | 'PROCESSING' | 'RETRY' | 'SUCCEEDED' | 'UNKNOWN';
  type:
    | 'CREATE_OR_UPDATE_LEAD'
    | 'MERGE_CONTACTS'
    | 'FORWARD_INBOUND_MESSAGE'
    | 'FORWARD_OUTBOUND_MESSAGE'
    | 'FORWARD_REACTION_EVENT'
    | 'FORWARD_MESSAGE_EDIT'
    | 'FORWARD_CONTACT_SHARE'
    | 'FORWARD_AUTOMATION_STATE'
    | 'FORWARD_EMAIL_EVENT'
    | 'FORWARD_TRACKED_LINK_CLICK'
    | 'FORWARD_MESSAGE_STATUS';
  updatedAt: Date;
};

@Injectable()
export class CrmService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<ApiEnvironment, true>,
  ) {}

  async getConfig(projectId: string) {
    const config = await this.database.client.crmProjectConfig.findUnique({ where: { projectId } });
    return config ? this.safeConfig(config) : null;
  }

  async upsertConfig(
    projectId: string,
    dto: UpsertCrmProjectConfigDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const update: Prisma.CrmProjectConfigUpdateInput = { crmProjectId: dto.crmProjectId };
    if (dto.additionalParameters !== undefined)
      update.additionalParameters = this.json(dto.additionalParameters);
    if (dto.defaultPipeline !== undefined) update.defaultPipeline = dto.defaultPipeline;
    if (dto.defaultStage !== undefined) update.defaultStage = dto.defaultStage;
    if (dto.enabled !== undefined) update.enabled = dto.enabled;
    if (dto.fieldMapping !== undefined) update.fieldMapping = this.json(dto.fieldMapping);
    const config = await this.database.client.crmProjectConfig.upsert({
      create: {
        additionalParameters: this.json(dto.additionalParameters ?? {}),
        crmProjectId: dto.crmProjectId,
        defaultPipeline: dto.defaultPipeline ?? null,
        defaultStage: dto.defaultStage ?? null,
        enabled: dto.enabled ?? true,
        fieldMapping: this.json(dto.fieldMapping ?? {}),
        projectId,
      },
      update,
      where: { projectId },
    });
    await this.audit.record({
      action: 'crm.project_config.upsert',
      actorUserId: actor.userId,
      afterSafeJson: { crmProjectId: config.crmProjectId, enabled: config.enabled },
      correlationId: context.correlationId,
      entityId: config.id,
      entityType: 'CrmProjectConfig',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return this.safeConfig(config);
  }

  async startPairing(
    projectId: string,
    dto: StartCrmPairingDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const pairingCode = `omx_${randomBytes(24).toString('base64url')}`;
    const pairingCodeHash = this.hash(pairingCode);
    const pairingExpiresAt = new Date(Date.now() + 10 * 60 * 1_000);
    const existing = await this.database.client.crmProjectConfig.findUnique({
      where: { projectId },
    });
    const connection = await this.database.client.crmProjectConfig.upsert({
      create: {
        crmProjectId: dto.crmProjectId,
        id: randomUUID(),
        pairingCodeHash,
        pairingExpiresAt,
        projectId,
        status: 'PAIRING',
      },
      update: {
        crmProjectId: dto.crmProjectId,
        pairingCodeHash,
        pairingExpiresAt,
        status: existing?.status === 'ACTIVE' ? 'ACTIVE' : 'PAIRING',
      },
      where: { projectId },
    });
    await this.audit.record({
      action: 'crm.pairing.started',
      actorUserId: actor.userId,
      afterSafeJson: { crmProjectId: dto.crmProjectId, expiresAt: pairingExpiresAt },
      correlationId: context.correlationId,
      entityId: connection.id,
      entityType: 'CrmProjectConfig',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return {
      expiresAt: pairingExpiresAt,
      omnicusApiUrl: this.config.get('API_PUBLIC_URL', { infer: true }),
      pairingCode,
    };
  }

  async completePairing(dto: CompleteCrmPairingDto) {
    const pairingCodeHash = this.hash(dto.pairingCode);
    const now = new Date();
    const connection = await this.database.client.crmProjectConfig.findUnique({
      include: { project: { select: { name: true, slug: true, status: true } } },
      where: { pairingCodeHash },
    });
    if (
      !connection ||
      !connection.pairingExpiresAt ||
      connection.pairingExpiresAt <= now ||
      connection.project.status !== 'ACTIVE' ||
      connection.crmProjectId !== dto.crmProjectId
    )
      throw new NotFoundException({
        code: 'CRM_PAIRING_CODE_INVALID',
        message: 'Pairing code is invalid or expired',
      });
    const baseUrl = this.exactOrigin(dto.crmBaseUrl);
    const inboundToken = `omnicus_${randomBytes(32).toString('base64url')}`;
    const credentialsEncrypted = this.secrets().encryptSecret({
      channelConnectionId: connection.id,
      channelType: 'crm',
      field: 'authToken',
      plaintext: dto.crmInboundAuthToken,
      projectId: connection.projectId,
    });
    await this.database.client.$transaction(async (transaction) => {
      const updated = await transaction.crmProjectConfig.updateMany({
        data: {
          baseUrl,
          capabilities: this.json(dto.capabilities ?? {}),
          credentialsEncrypted: credentialsEncrypted as unknown as Prisma.InputJsonValue,
          enabled: true,
          inboundTokenHash: this.hash(inboundToken),
          lastErrorAt: null,
          pairingCodeHash: null,
          pairingExpiresAt: null,
          status: 'ACTIVE',
        },
        where: {
          id: connection.id,
          pairingCodeHash,
          pairingExpiresAt: { gt: now },
          projectId: connection.projectId,
        },
      });
      if (updated.count !== 1)
        throw new NotFoundException({
          code: 'CRM_PAIRING_CODE_INVALID',
          message: 'Pairing code is invalid or expired',
        });
      await transaction.auditLog.create({
        data: {
          action: 'crm.pairing.completed',
          actorType: 'SERVICE',
          afterSafeJson: {
            baseUrl,
            crmProjectId: connection.crmProjectId,
            provider: connection.provider,
          },
          correlationId: `crm-pairing:${connection.id}`,
          entityId: connection.id,
          entityType: 'CrmProjectConfig',
          projectId: connection.projectId,
          projectNameSnapshot: connection.project.name,
          projectSlugSnapshot: connection.project.slug,
          purgeAfter: new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000),
        },
      });
    });
    return {
      crmProjectId: connection.crmProjectId,
      omnicusInboundAuthToken: inboundToken,
      omnicusProjectId: connection.projectId,
      status: 'ACTIVE' as const,
    };
  }

  async testConnection(
    projectId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const connection = await this.database.client.crmProjectConfig.findUnique({
      where: { projectId },
    });
    if (
      !connection?.baseUrl ||
      !connection.credentialsEncrypted ||
      connection.status === 'DISABLED'
    )
      throw new BadRequestException({ code: 'CRM_CONNECTION_NOT_PAIRED' });
    let ok = false;
    try {
      const response = await fetch(
        new URL('/integrations/v1/omnicus/connection', `${connection.baseUrl}/`),
        {
          headers: { Authorization: `Bearer ${this.decryptCredential(connection)}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      ok = response.ok;
    } catch {
      ok = false;
    }
    const updated = await this.database.client.crmProjectConfig.update({
      data: ok
        ? { lastErrorAt: null, lastTestedAt: new Date(), status: 'ACTIVE' }
        : { lastErrorAt: new Date(), lastTestedAt: new Date(), status: 'ERROR' },
      where: { projectId },
    });
    await this.audit.record({
      action: 'crm.connection.tested',
      actorUserId: actor.userId,
      afterSafeJson: { ok },
      correlationId: context.correlationId,
      entityId: connection.id,
      entityType: 'CrmProjectConfig',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return { ok, status: updated.status };
  }

  async disableConnection(
    projectId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const current = await this.database.client.crmProjectConfig.findUnique({
      where: { projectId },
    });
    if (!current) throw new NotFoundException({ code: 'CRM_CONNECTION_NOT_FOUND' });
    const updated = await this.database.client.crmProjectConfig.update({
      data: {
        enabled: false,
        pairingCodeHash: null,
        pairingExpiresAt: null,
        status: 'DISABLED',
      },
      where: { projectId },
    });
    await this.audit.record({
      action: 'crm.connection.disabled',
      actorUserId: actor.userId,
      afterSafeJson: { status: updated.status },
      correlationId: context.correlationId,
      entityId: current.id,
      entityType: 'CrmProjectConfig',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return this.safeConfig(updated);
  }

  async listOperations(
    projectId: string,
    query: CrmOperationsQueryDto,
  ): Promise<{ items: SafeCrmOperation[]; page: number; pageSize: number; total: number }> {
    const skip = (query.page - 1) * query.pageSize;
    const operations = await this.database.client.crmOperation.findMany({
      include: { outbox: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: query.pageSize,
      where: { projectId },
    });
    const total = await this.database.client.crmOperation.count({ where: { projectId } });
    return {
      items: operations.map((operation) => this.safeOperation(operation)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async retryOperation(
    projectId: string,
    operationId: string,
    dto: RetryCrmOperationDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ): Promise<SafeCrmOperation> {
    const retryResult = await this.database.client.$transaction(async (transaction) => {
      const current = await transaction.crmOperation.findUnique({
        include: { outbox: true },
        where: { projectId_id: { id: operationId, projectId } },
      });
      if (!current) throw new NotFoundException({ code: 'CRM_OPERATION_NOT_FOUND' });
      if (!['FAILED', 'UNKNOWN'].includes(current.outbox.status))
        throw new BadRequestException({ code: 'CRM_OPERATION_NOT_TERMINAL' });
      if (current.outbox.status === 'UNKNOWN' && dto.confirmUnknownDelivery !== true)
        throw new BadRequestException({ code: 'CRM_UNKNOWN_RETRY_CONFIRMATION_REQUIRED' });
      const updated = await transaction.outboxRecord.updateMany({
        data: {
          attempts: 0,
          completedAt: null,
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: new Date(),
          status: 'PENDING',
        },
        where: {
          id: current.outboxRecordId,
          projectId,
          status: current.outbox.status,
        },
      });
      if (updated.count !== 1)
        throw new BadRequestException({ code: 'CRM_OPERATION_STATE_CHANGED' });
      const refreshed = await transaction.crmOperation.findUniqueOrThrow({
        include: { outbox: true },
        where: { projectId_id: { id: operationId, projectId } },
      });
      return { operation: refreshed, retriedUnknown: current.outbox.status === 'UNKNOWN' };
    });
    await this.audit.record({
      action: 'crm.operation.manual_retry_requested',
      actorUserId: actor.userId,
      afterSafeJson: {
        confirmedUnknownDelivery: retryResult.retriedUnknown,
        operationType: retryResult.operation.type,
      },
      correlationId: context.correlationId,
      entityId: operationId,
      entityType: 'CrmOperation',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return this.safeOperation(retryResult.operation);
  }

  private decryptCredential(connection: {
    credentialsEncrypted: Prisma.JsonValue | null;
    id: string;
    projectId: string;
  }): string {
    const envelope = connection.credentialsEncrypted as EncryptedSecretEnvelope | null;
    if (!envelope) throw new Error('crm_credential_missing');
    return this.secrets().decryptSecret({
      channelConnectionId: connection.id,
      channelType: 'crm',
      envelope,
      field: 'authToken',
      projectId: connection.projectId,
    });
  }

  private exactOrigin(value: string): string {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !['http:', 'https:'].includes(url.protocol)
    )
      throw new BadRequestException({ code: 'CRM_BASE_URL_INVALID' });
    const appEnvironment = this.config.get('APP_ENV', { infer: true });
    if (!['development', 'test'].includes(appEnvironment) && url.protocol !== 'https:')
      throw new BadRequestException({ code: 'CRM_BASE_URL_HTTPS_REQUIRED' });
    return url.origin;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private json(value: Record<string, unknown>): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private safeConfig(config: {
    baseUrl: string | null;
    capabilities: Prisma.JsonValue;
    createdAt: Date;
    crmProjectId: string;
    defaultPipeline: string | null;
    defaultStage: string | null;
    enabled: boolean;
    fieldMapping: Prisma.JsonValue;
    id: string;
    lastErrorAt: Date | null;
    lastTestedAt: Date | null;
    projectId: string;
    provider: string;
    status: string;
    updatedAt: Date;
  }) {
    return {
      baseUrl: config.baseUrl,
      capabilities: config.capabilities,
      createdAt: config.createdAt,
      crmProjectId: config.crmProjectId,
      defaultPipeline: config.defaultPipeline,
      defaultStage: config.defaultStage,
      enabled: config.enabled,
      fieldMapping: config.fieldMapping,
      id: config.id,
      lastErrorAt: config.lastErrorAt,
      lastTestedAt: config.lastTestedAt,
      paired: ['ACTIVE', 'ERROR'].includes(config.status),
      projectId: config.projectId,
      provider: config.provider,
      status: config.status,
      updatedAt: config.updatedAt,
    };
  }

  private safeOperation(operation: {
    createdAt: Date;
    id: string;
    resultSafe: unknown;
    type:
      | 'CREATE_OR_UPDATE_LEAD'
      | 'MERGE_CONTACTS'
      | 'FORWARD_INBOUND_MESSAGE'
      | 'FORWARD_OUTBOUND_MESSAGE'
      | 'FORWARD_REACTION_EVENT'
      | 'FORWARD_MESSAGE_EDIT'
      | 'FORWARD_CONTACT_SHARE'
      | 'FORWARD_AUTOMATION_STATE'
      | 'FORWARD_EMAIL_EVENT'
      | 'FORWARD_TRACKED_LINK_CLICK'
      | 'FORWARD_MESSAGE_STATUS';
    updatedAt: Date;
    outbox: {
      attempts: number;
      lastError: string | null;
      status: 'FAILED' | 'PENDING' | 'PROCESSING' | 'RETRY' | 'SUCCEEDED' | 'UNKNOWN';
    };
  }): SafeCrmOperation {
    return {
      attempts: operation.outbox.attempts,
      createdAt: operation.createdAt,
      id: operation.id,
      lastError: operation.outbox.lastError,
      resultSafe: operation.resultSafe,
      status: operation.outbox.status,
      type: operation.type,
      updatedAt: operation.updatedAt,
    };
  }

  private secrets(): ChannelSecretsService {
    return new ChannelSecretsService(this.config.get('CHANNEL_SECRETS_KEY', { infer: true }));
  }
}
