import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { executeExternalHttpRequest, ExternalHttpError } from '@omnicus/automation-http';
import {
  externalHttpRequestConfigSchema,
  scenarioGraphSchema,
  type ExternalHttpRequestConfig,
} from '@omnicus/automation-core';
import { ChannelSecretsService, type EncryptedSecretEnvelope } from '@omnicus/channel-secrets';
import type { WorkerEnvironment } from '@omnicus/config/server';
import type { Prisma } from '@omnicus/database';

import { AutomationRuntimeService } from '../automation/automation-runtime.service';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class ExternalHttpOutboxService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExternalHttpOutboxService.name);
  private readonly secrets: ChannelSecretsService;
  private readonly workerId = `external-http-${process.pid}-${randomUUID()}`;
  private scanning = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AutomationRuntimeService) private readonly runtime: AutomationRuntimeService,
  ) {
    this.secrets = new ChannelSecretsService(config.get('CHANNEL_SECRETS_KEY', { infer: true }));
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(
      () => void this.scanOnce(),
      this.config.get('AUTOMATION_CONTINUATION_INTERVAL_MS', { infer: true }),
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scanOnce(now = new Date()): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const leaseExpiredBefore = new Date(now.getTime() - 60_000);
      const rows = await this.database.client.outboxRecord.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true },
        take: this.config.get('AUTOMATION_CONTINUATION_BATCH_SIZE', { infer: true }),
        where: {
          kind: 'HTTP',
          OR: [
            {
              status: { in: ['PENDING', 'RETRY'] },
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
            },
            { lockedAt: { lt: leaseExpiredBefore }, status: 'PROCESSING' },
          ],
        },
      });
      for (const row of rows) await this.process(row.id, now, leaseExpiredBefore);
      if (rows.length)
        this.logger.log({ count: rows.length, message: 'external_http_outbox_scan' });
    } catch {
      this.logger.warn({ message: 'external_http_outbox_scan_failed' });
    } finally {
      this.scanning = false;
    }
  }

  private async process(
    outboxRecordId: string,
    now: Date,
    leaseExpiredBefore: Date,
  ): Promise<void> {
    const operation = await this.load(outboxRecordId);
    if (!operation) return;
    const config = this.nodeConfig(operation);
    if (
      operation.outbox.status === 'PROCESSING' &&
      operation.outbox.lockedAt &&
      operation.outbox.lockedAt < leaseExpiredBefore &&
      config?.method !== 'GET'
    ) {
      await this.markUnknown(operation, 'external_http_expired_mutation_unknown');
      return;
    }
    const lease = `${this.workerId}-${randomUUID()}`;
    const claimed = await this.database.client.outboxRecord.updateMany({
      data: {
        attempts: { increment: 1 },
        lastError: null,
        lockedAt: now,
        lockedBy: lease,
        status: 'PROCESSING',
      },
      where: {
        id: outboxRecordId,
        kind: 'HTTP',
        OR: [
          {
            status: { in: ['PENDING', 'RETRY'] },
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          { lockedAt: { lt: leaseExpiredBefore }, status: 'PROCESSING' },
        ],
      },
    });
    if (claimed.count !== 1) return;
    const refreshed = await this.load(outboxRecordId);
    if (!refreshed || !config) {
      await this.finishPermanent(refreshed ?? operation, lease, 'external_http_config_invalid');
      return;
    }
    try {
      const result = await executeExternalHttpRequest({
        config,
        idempotencyKey: refreshed.outbox.id,
        secretFor: (secretId) => this.secretValue(refreshed.projectId, secretId),
        variables: this.variables(refreshed),
      });
      if (
        result.outcome === 'failure' &&
        [429, 500, 502, 503, 504].includes(result.statusCode) &&
        refreshed.outbox.attempts < refreshed.outbox.maxAttempts
      ) {
        await this.retry(refreshed, lease, `external_http_status_${result.statusCode}`);
        return;
      }
      await this.database.client.$transaction(async (transaction) => {
        const finished = await transaction.outboxRecord.updateMany({
          data: {
            completedAt: new Date(),
            lastError: null,
            lockedAt: null,
            lockedBy: null,
            nextAttemptAt: null,
            status: 'SUCCEEDED',
          },
          where: {
            id: refreshed.outbox.id,
            lockedBy: lease,
            projectId: refreshed.projectId,
            status: 'PROCESSING',
          },
        });
        if (finished.count !== 1) return;
        const safeOutput = {
          contentType: result.contentType,
          mappingKeys: result.mappingKeys,
          outcome: result.outcome,
          sizeBytes: result.sizeBytes,
          statusCode: result.statusCode,
        } satisfies Prisma.InputJsonObject;
        await transaction.externalHttpOperation.update({
          data: { resultSafe: safeOutput },
          where: {
            projectId_id: { id: refreshed.id, projectId: refreshed.projectId },
          },
        });
        await this.runtime.resumeExternalHttpInTransaction(transaction, {
          mappedVariables: this.withNodeStatus(
            result.mappedVariables,
            refreshed.nodeId,
            result.statusCode,
          ) as Prisma.InputJsonValue,
          nodeId: refreshed.nodeId,
          outcome: result.outcome,
          projectId: refreshed.projectId,
          safeOutput,
          scenarioExecutionId: refreshed.scenarioExecutionId,
          startNodeId:
            result.outcome === 'success' ? refreshed.successNodeId : refreshed.failureNodeId,
        });
      });
    } catch (error) {
      const failure =
        error instanceof ExternalHttpError
          ? error
          : new ExternalHttpError('UNKNOWN', 'external_http_unexpected_unknown');
      if (
        failure.outcome === 'RETRYABLE_FAILURE' &&
        refreshed.outbox.attempts < refreshed.outbox.maxAttempts
      )
        await this.retry(refreshed, lease, failure.safeCode);
      else if (
        failure.outcome === 'UNKNOWN' &&
        config.method === 'GET' &&
        refreshed.outbox.attempts < refreshed.outbox.maxAttempts
      )
        await this.retry(refreshed, lease, failure.safeCode);
      else if (failure.outcome === 'UNKNOWN')
        await this.markUnknown(refreshed, failure.safeCode, lease);
      else await this.finishPermanent(refreshed, lease, failure.safeCode);
    }
  }

  private async finishPermanent(
    operation: Awaited<ReturnType<ExternalHttpOutboxService['load']>> & {},
    lease: string,
    safeCode: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const finished = await transaction.outboxRecord.updateMany({
        data: {
          completedAt: new Date(),
          lastError: safeCode,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
          status: 'FAILED',
        },
        where: {
          id: operation.outbox.id,
          lockedBy: lease,
          projectId: operation.projectId,
          status: 'PROCESSING',
        },
      });
      if (finished.count !== 1) return;
      const safeOutput = { errorCode: safeCode, outcome: 'failure' };
      await transaction.externalHttpOperation.update({
        data: { resultSafe: safeOutput },
        where: { projectId_id: { id: operation.id, projectId: operation.projectId } },
      });
      await this.runtime.resumeExternalHttpInTransaction(transaction, {
        mappedVariables: {},
        nodeId: operation.nodeId,
        outcome: 'failure',
        projectId: operation.projectId,
        safeOutput,
        scenarioExecutionId: operation.scenarioExecutionId,
        startNodeId: operation.failureNodeId,
      });
    });
  }

  private async retry(
    operation: NonNullable<Awaited<ReturnType<ExternalHttpOutboxService['load']>>>,
    lease: string,
    safeCode: string,
  ): Promise<void> {
    const delay = Math.min(300_000, 1_000 * 2 ** Math.min(operation.outbox.attempts, 8));
    await this.database.client.outboxRecord.updateMany({
      data: {
        lastError: safeCode,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: new Date(Date.now() + delay),
        status: 'RETRY',
      },
      where: {
        id: operation.outbox.id,
        lockedBy: lease,
        projectId: operation.projectId,
        status: 'PROCESSING',
      },
    });
  }

  private async markUnknown(
    operation: NonNullable<Awaited<ReturnType<ExternalHttpOutboxService['load']>>>,
    safeCode: string,
    lease?: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const finished = await transaction.outboxRecord.updateMany({
        data: {
          completedAt: new Date(),
          lastError: safeCode,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
          status: 'UNKNOWN',
        },
        where: {
          id: operation.outbox.id,
          projectId: operation.projectId,
          status: 'PROCESSING',
          ...(lease ? { lockedBy: lease } : {}),
        },
      });
      if (finished.count !== 1) return;
      await transaction.externalHttpOperation.update({
        data: { resultSafe: { errorCode: safeCode, outcome: 'unknown' } },
        where: { projectId_id: { id: operation.id, projectId: operation.projectId } },
      });
      await transaction.nodeExecution.updateMany({
        data: {
          completedAt: new Date(),
          errorSafe: { code: 'external_http_unknown_requires_review' },
          status: 'FAILED',
        },
        where: {
          nodeId: operation.nodeId,
          projectId: operation.projectId,
          scenarioExecutionId: operation.scenarioExecutionId,
        },
      });
      await transaction.scenarioExecution.updateMany({
        data: {
          errorSafe: { code: 'external_http_unknown_requires_review' },
          status: 'PAUSED',
        },
        where: {
          id: operation.scenarioExecutionId,
          projectId: operation.projectId,
          status: 'WAITING',
        },
      });
    });
  }

  private load(outboxRecordId: string) {
    return this.database.client.externalHttpOperation.findUnique({
      include: {
        execution: {
          include: {
            contact: true,
            conversation: true,
            project: { select: { id: true, name: true } },
            scenarioVersion: { select: { compiledDefinition: true } },
            triggerEvent: { select: { createdAt: true, payload: true } },
          },
        },
        outbox: true,
      },
      where: { outboxRecordId },
    });
  }

  private nodeConfig(
    operation: NonNullable<Awaited<ReturnType<ExternalHttpOutboxService['load']>>>,
  ): ExternalHttpRequestConfig | undefined {
    const graph = scenarioGraphSchema.safeParse(
      operation.execution.scenarioVersion.compiledDefinition,
    );
    if (!graph.success) return undefined;
    const node = graph.data.nodes.find((candidate) => candidate.id === operation.nodeId);
    if (node?.type !== 'EXTERNAL_HTTP_REQUEST') return undefined;
    const config = externalHttpRequestConfigSchema.safeParse(node.config);
    return config.success ? config.data : undefined;
  }

  private variables(
    operation: NonNullable<Awaited<ReturnType<ExternalHttpOutboxService['load']>>>,
  ): Record<string, unknown> {
    const triggerEvent = operation.execution.triggerEvent;
    const conversation = operation.execution.conversation;
    if (!triggerEvent || !conversation)
      throw new ExternalHttpError('PERMANENT_FAILURE', 'external_http_context_unavailable');
    const event = this.record(triggerEvent.payload);
    const content = this.record(event.content);
    const executionVariables = this.record(operation.execution.variables);
    return {
      ...executionVariables,
      contact: {
        channel: 'TELEGRAM',
        customFields: operation.execution.contact.customFields,
        email: operation.execution.contact.email,
        firstName: operation.execution.contact.firstName,
        id: operation.execution.contact.id,
        lastName: operation.execution.contact.lastName,
        phone: operation.execution.contact.phone,
        username: operation.execution.contact.username,
      },
      conversation: { id: conversation.id },
      message: {
        id: operation.execution.triggerEventId,
        text: content.text,
        type: event.type,
      },
      nodes: this.record(executionVariables.nodes),
      project: operation.execution.project,
      trigger: { occurredAt: triggerEvent.createdAt, type: event.type },
      variables: executionVariables,
    };
  }

  private async secretValue(projectId: string, secretId: string): Promise<string> {
    const secret = await this.database.client.automationSecret.findFirst({
      where: { archivedAt: null, id: secretId, projectId },
    });
    if (!secret)
      throw new ExternalHttpError('PERMANENT_FAILURE', 'external_http_secret_unavailable');
    try {
      return this.secrets.decryptSecret({
        channelConnectionId: secret.id,
        channelType: 'automation',
        envelope: secret.valueEncrypted as unknown as EncryptedSecretEnvelope,
        field: 'value',
        projectId,
      });
    } catch {
      throw new ExternalHttpError('PERMANENT_FAILURE', 'external_http_secret_unavailable');
    }
  }

  private withNodeStatus(
    mapped: Record<string, unknown>,
    nodeId: string,
    statusCode: number,
  ): Record<string, unknown> {
    return {
      ...mapped,
      nodes: {
        ...this.record(mapped.nodes),
        [nodeId]: {
          ...this.record(this.record(mapped.nodes)[nodeId]),
          response: { status: statusCode },
        },
      },
    };
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
