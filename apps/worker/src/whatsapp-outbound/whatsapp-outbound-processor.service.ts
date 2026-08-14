import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelSecretsService, type EncryptedSecretEnvelope } from '@omnicus/channel-secrets';
import {
  assertWhatsAppMedia,
  assertWhatsAppReactionEmoji,
  assertWhatsAppTemplateComponents,
  whatsAppTemplateDisabledReason,
  WhatsAppApiError,
  WhatsAppCloudApi,
  WHATSAPP_OUTBOUND_JOB_NAME,
  WHATSAPP_OUTBOUND_QUEUE_NAME,
  type WhatsAppOutboundJob,
  type WhatsAppOutboundMessage,
  type WhatsAppInteractive,
  type WhatsAppTemplateParameter,
  type WhatsAppTemplateSend,
} from '@omnicus/channel-whatsapp';
import type { WorkerEnvironment } from '@omnicus/config/server';
import type { Prisma } from '@omnicus/database';
import { S3MediaStorage } from '@omnicus/media-core';
import { Worker, type Job } from 'bullmq';

import { DatabaseService } from '../database/database.service';
import { ensureCrmOutboundHistoryIntent } from '../crm/crm-outbound-history';
import { redisConnectionFromUrl } from '../queue/redis-connection';

export const WHATSAPP_OUTBOUND_PROCESSOR_CLIENT = Symbol('WHATSAPP_OUTBOUND_PROCESSOR_CLIENT');

export interface WhatsAppOutboundProcessorClient {
  close(force?: boolean): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  waitUntilReady(): Promise<unknown>;
}

interface ClaimedOutboxRecord {
  attempts: number;
  connectionId: string;
  id: string;
  leaseToken: string;
  maxAttempts: number;
  payload: Prisma.JsonValue;
  projectId: string;
}

type SendFailureSafeReason =
  | 'ACCESS_TOKEN_DECRYPT_FAILED'
  | 'ACCESS_TOKEN_MISSING'
  | 'RECIPIENT_MISSING'
  | 'GRAPH_API_INVALID_PHONE_NUMBER_ID'
  | 'GRAPH_API_INVALID_RECIPIENT'
  | 'GRAPH_API_PERMISSION_DENIED'
  | 'GRAPH_API_PROVIDER_REJECTED'
  | 'GRAPH_API_RATE_LIMITED'
  | 'GRAPH_API_REQUEST_INVALID'
  | 'GRAPH_API_TEMPLATE_REQUIRED'
  | 'GRAPH_API_TIMEOUT'
  | 'GRAPH_API_UNKNOWN_RESULT'
  | 'GRAPH_API_UNAUTHORIZED';

type SendFailureMode = 'FAIL' | 'RETRY' | 'UNKNOWN';

interface SendFailureAnalysis {
  httpStatus?: number;
  mode: SendFailureMode;
  providerErrorCode?: number;
  providerErrorSubcode?: number;
  providerErrorType?: string;
  providerSafeMessage?: string;
  providerTraceId?: string;
  retryAfterSeconds?: number;
  safeReason: SendFailureSafeReason;
}

interface AccessTokenResolution {
  accessToken: string;
  accessTokenDecryptSucceeded: boolean;
  accessTokenPresent: boolean;
}

interface SendAttemptContext {
  accessTokenPresent: boolean;
  accessTokenDecryptSucceeded: boolean;
  connectionId: string;
  correlationId: string | undefined;
  graphApiVersion: string;
  phoneNumberId: string | undefined;
  messageType: string;
  operationId: string;
  outboxId: string;
  phoneNumberIdPresent: boolean;
  projectId: string;
  recipientPresent: boolean;
  retryCount?: number;
}

type JsonObject = Record<string, unknown>;

class WhatsAppOutboundPermanentError extends Error {}
class WhatsAppOutboundLeaseConflictError extends Error {}
class WhatsAppOutboundUnknownError extends Error {}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

@Injectable()
export class WhatsAppOutboundProcessorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly api = new WhatsAppCloudApi();
  private readonly logger = new Logger(WhatsAppOutboundProcessorService.name);
  private readonly secrets: ChannelSecretsService;
  private readonly storage: S3MediaStorage | undefined;
  private readonly workerId = `whatsapp-outbound:${process.pid}:${randomUUID()}`;
  private processor: WhatsAppOutboundProcessorClient | undefined;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(WHATSAPP_OUTBOUND_PROCESSOR_CLIENT)
    processor?: WhatsAppOutboundProcessorClient,
  ) {
    this.processor = processor;
    this.secrets = new ChannelSecretsService(config.get('CHANNEL_SECRETS_KEY', { infer: true }));
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

  async onApplicationBootstrap(): Promise<void> {
    if (!this.processor)
      this.processor = new Worker(
        WHATSAPP_OUTBOUND_QUEUE_NAME,
        async (job: Job<WhatsAppOutboundJob>) => {
          if (job.name !== WHATSAPP_OUTBOUND_JOB_NAME)
            throw new Error('Unsupported WhatsApp outbound job');
          await this.process(job.data);
        },
        {
          concurrency: 4,
          connection: {
            ...redisConnectionFromUrl(this.config.get('REDIS_URL', { infer: true })),
            maxRetriesPerRequest: null,
          },
        },
      );
    this.processor.on('error', () =>
      this.logger.error({ message: 'WhatsApp outbound BullMQ consumer failed' }),
    );
    await this.processor.waitUntilReady();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.processor?.close();
  }

  async process(job: WhatsAppOutboundJob): Promise<void> {
    const claimed = await this.claim(job.outboxRecordId);
    if (!claimed) return;
    const payload = object(claimed.payload);
    if (!payload) {
      await this.fail(claimed, 'whatsapp_outbound_payload_invalid');
      return;
    }
    let messageId: string | undefined;
    let sendContext: SendAttemptContext | undefined;
    try {
      const connection = await this.connection(claimed);
      const action = string(payload.action);
      if (action === 'MARK_READ') {
        const providerMessageId = string(payload.providerMessageId);
        if (!providerMessageId) {
          await this.failOutboxOnly(claimed, 'whatsapp_read_target_invalid');
          return;
        }
        const accessToken = this.resolveAccessToken(connection);
        const phoneNumberId = connection.phoneNumberId;
        sendContext = {
          accessTokenDecryptSucceeded: accessToken.accessTokenDecryptSucceeded,
          accessTokenPresent: accessToken.accessTokenPresent,
          connectionId: connection.id,
          correlationId: string(object(payload.correlationId)),
          graphApiVersion: connection.graphApiVersion,
          messageType: 'whatsapp_read',
          operationId: claimed.id,
          outboxId: claimed.id,
          phoneNumberId,
          phoneNumberIdPresent: Boolean(phoneNumberId),
          projectId: claimed.projectId,
          recipientPresent: false,
        };
        if (!accessToken.accessTokenPresent) {
          await this.logOutboundSendRejection(
            claimed,
            undefined,
            {
              mode: 'FAIL',
              safeReason: 'ACCESS_TOKEN_MISSING',
            },
            sendContext,
          );
          await this.failOutboxOnly(claimed, 'whatsapp_mark_read_failed');
          return;
        }
        if (!accessToken.accessTokenDecryptSucceeded) {
          await this.logOutboundSendRejection(
            claimed,
            undefined,
            {
              mode: 'FAIL',
              safeReason: 'ACCESS_TOKEN_DECRYPT_FAILED',
            },
            sendContext,
          );
          await this.failOutboxOnly(claimed, 'whatsapp_mark_read_failed');
          return;
        }
        if (!accessToken.accessToken) {
          await this.logOutboundSendRejection(
            claimed,
            undefined,
            {
              mode: 'FAIL',
              safeReason: 'ACCESS_TOKEN_MISSING',
            },
            sendContext,
          );
          await this.failOutboxOnly(claimed, 'whatsapp_mark_read_failed');
          return;
        }
        if (!phoneNumberId) {
          await this.logOutboundSendRejection(
            claimed,
            undefined,
            {
              mode: 'FAIL',
              safeReason: 'GRAPH_API_INVALID_PHONE_NUMBER_ID',
            },
            sendContext,
          );
          await this.failOutboxOnly(claimed, 'whatsapp_mark_read_failed');
          return;
        }
        try {
          await this.api.markMessageRead({
            accessToken: accessToken.accessToken,
            graphApiVersion: connection.graphApiVersion,
            messageId: providerMessageId,
            phoneNumberId,
          });
        } catch (error) {
          await this.handleMarkReadError(claimed, error, sendContext);
          return;
        }
        await this.succeedOutboxOnly(claimed);
        return;
      }

      if (action === 'SET_REACTION') {
        await this.setReaction(claimed, connection, payload);
        return;
      }

      messageId = string(payload.messageId);
      const identityId = string(payload.channelIdentityId);
      if (!messageId || !identityId)
        throw new WhatsAppOutboundPermanentError('whatsapp_outbound_payload_invalid');
      const journaledProviderMessageId = string(payload.providerMessageId);
      if (journaledProviderMessageId) {
        await this.recoverJournaledSend(claimed, messageId, journaledProviderMessageId);
        return;
      }
      const message = await this.database.client.message.findUnique({
        include: { conversation: true, mediaAsset: true },
        where: { projectId_id: { id: messageId, projectId: claimed.projectId } },
      });
      const identity = await this.database.client.channelIdentity.findUnique({
        where: { projectId_id: { id: identityId, projectId: claimed.projectId } },
      });
      if (
        !message ||
        !identity ||
        message.connectionId !== claimed.connectionId ||
        identity.connectionId !== claimed.connectionId ||
        identity.contactId !== message.contactId ||
        identity.channel !== 'WHATSAPP'
      )
        throw new WhatsAppOutboundPermanentError('whatsapp_outbound_scope_invalid');
      const broadcastRecipient = await this.database.client.broadcastRecipient.findFirst({
        include: { broadcast: { select: { status: true } } },
        where: { outboxRecordId: claimed.id, projectId: claimed.projectId },
      });
      if (broadcastRecipient?.broadcast.status === 'PAUSED') {
        await this.deferBroadcastRecipient(claimed);
        return;
      }
      if (broadcastRecipient && broadcastRecipient.broadcast.status !== 'RUNNING') {
        await this.cancelBroadcastRecipient(claimed, broadcastRecipient.id, message.id);
        return;
      }
      if (broadcastRecipient)
        await this.database.client.broadcastRecipient.updateMany({
          data: { lastError: null, status: 'PROCESSING' },
          where: {
            id: broadcastRecipient.id,
            projectId: claimed.projectId,
            status: { in: ['QUEUED', 'PROCESSING'] },
          },
        });
      await this.database.client.scheduledMessage.updateMany({
        data: { status: 'PROCESSING' },
        where: { messageId: message.id, projectId: claimed.projectId, status: 'QUEUED' },
      });
      const prepared = await this.prepareMessage(connection, message, claimed);
      if (!prepared.template) await this.assertServiceWindow(message.conversation.id, claimed);
      const accessToken = this.resolveAccessToken(connection);
      const recipientNumber = string(identity.externalUserId)?.trim();
      sendContext = {
        accessTokenDecryptSucceeded: accessToken.accessTokenDecryptSucceeded,
        accessTokenPresent: accessToken.accessTokenPresent,
        connectionId: connection.id,
        correlationId: string(object(message.metadata)?.correlationId),
        graphApiVersion: connection.graphApiVersion,
        messageType: prepared.message.type,
        operationId: claimed.id,
        outboxId: claimed.id,
        phoneNumberId: connection.phoneNumberId,
        phoneNumberIdPresent: Boolean(connection.phoneNumberId),
        projectId: claimed.projectId,
        recipientPresent: Boolean(recipientNumber),
        retryCount: claimed.attempts,
      };
      if (!recipientNumber) {
        await this.logOutboundSendRejection(
          claimed,
          message.id,
          {
            mode: 'FAIL',
            safeReason: 'RECIPIENT_MISSING',
          },
          sendContext,
        );
        await this.fail(claimed, 'whatsapp_outbound_rejected', message.id);
        return;
      }
      if (!accessToken.accessTokenPresent) {
        await this.logOutboundSendRejection(
          claimed,
          message.id,
          {
            mode: 'FAIL',
            safeReason: 'ACCESS_TOKEN_MISSING',
          },
          sendContext,
        );
        await this.fail(claimed, 'whatsapp_outbound_rejected', message.id);
        return;
      }
      if (!accessToken.accessTokenDecryptSucceeded) {
        await this.logOutboundSendRejection(
          claimed,
          message.id,
          {
            mode: 'FAIL',
            safeReason: 'ACCESS_TOKEN_DECRYPT_FAILED',
          },
          sendContext,
        );
        await this.fail(claimed, 'whatsapp_outbound_rejected', message.id);
        return;
      }
      if (!accessToken.accessToken) {
        await this.logOutboundSendRejection(
          claimed,
          message.id,
          {
            mode: 'FAIL',
            safeReason: 'ACCESS_TOKEN_MISSING',
          },
          sendContext,
        );
        await this.fail(claimed, 'whatsapp_outbound_rejected', message.id);
        return;
      }
      const replyToProviderMessageId = await this.replyProviderMessageId(
        message.metadata,
        claimed,
        { contactId: message.contactId, conversationId: message.conversationId },
      );
      const previewUrl = object(message.metadata)?.previewUrl === true;
      const outboundMessage =
        prepared.message.type === 'text' ? { ...prepared.message, previewUrl } : prepared.message;
      let providerMessageId: string;
      try {
        providerMessageId = (
          await this.api.sendMessage({
            accessToken: accessToken.accessToken,
            graphApiVersion: connection.graphApiVersion,
            message: outboundMessage,
            phoneNumberId: connection.phoneNumberId,
            ...(replyToProviderMessageId ? { replyToProviderMessageId } : {}),
            to: recipientNumber,
          })
        ).messageId;
      } catch (error) {
        await this.handleMessageSendError(claimed, message.id, error, sendContext);
        return;
      }
      if (!(await this.persistProviderSendJournal(claimed, providerMessageId))) {
        throw new WhatsAppOutboundLeaseConflictError();
      }
      await this.recoverJournaledSend(claimed, message.id, providerMessageId);
    } catch (error) {
      if (error instanceof WhatsAppOutboundLeaseConflictError) throw error;
      if (error instanceof WhatsAppOutboundUnknownError) return;
      if (error instanceof WhatsAppOutboundPermanentError) {
        await this.logOutboundSendRejection(
          claimed,
          messageId,
          {
            mode: 'FAIL',
            safeReason:
              error.message === 'whatsapp_template_required'
                ? 'GRAPH_API_TEMPLATE_REQUIRED'
                : 'GRAPH_API_REQUEST_INVALID',
          },
          sendContext,
        );
        await this.fail(claimed, error.message);
        return;
      }
      if (error instanceof WhatsAppApiError && error.status === 429) {
        await this.retry(claimed, 'whatsapp_outbound_retryable', error.retryAfterSeconds);
        throw error;
      }
      await this.retry(claimed, 'whatsapp_outbound_preparation_failed');
      throw error;
    }
  }

  private async claim(outboxRecordId: string): Promise<ClaimedOutboxRecord | undefined> {
    const existing = await this.database.client.outboxRecord.findUnique({
      where: { id: outboxRecordId },
    });
    if (
      !existing ||
      existing.kind !== 'WHATSAPP' ||
      !existing.connectionId ||
      ['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(existing.status)
    )
      return;
    const now = new Date();
    const leaseExpiry = new Date(
      now.getTime() - this.config.get('WHATSAPP_OUTBOUND_LEASE_MS', { infer: true }),
    );
    const leaseToken = `${this.workerId}:${randomUUID()}`;
    const claimed = await this.database.client.outboxRecord.updateMany({
      data: {
        attempts: { increment: 1 },
        lastError: null,
        lockedAt: now,
        lockedBy: leaseToken,
        status: 'PROCESSING',
      },
      where: {
        id: existing.id,
        kind: 'WHATSAPP',
        projectId: existing.projectId,
        OR: [
          { nextAttemptAt: null, status: { in: ['PENDING', 'RETRY'] } },
          { nextAttemptAt: { lte: now }, status: { in: ['PENDING', 'RETRY'] } },
          { lockedAt: { lt: leaseExpiry }, status: 'PROCESSING' },
        ],
      },
    });
    if (claimed.count !== 1) return;
    return {
      attempts: existing.attempts + 1,
      connectionId: existing.connectionId,
      id: existing.id,
      leaseToken,
      maxAttempts: existing.maxAttempts,
      payload: existing.payload,
      projectId: existing.projectId,
    };
  }

  private async connection(claimed: ClaimedOutboxRecord): Promise<{
    credentialsEncrypted: Prisma.JsonValue;
    graphApiVersion: string;
    id: string;
    phoneNumberId: string;
    projectId: string;
  }> {
    const row = await this.database.client.channelConnection.findUnique({
      where: { projectId_id: { id: claimed.connectionId, projectId: claimed.projectId } },
    });
    const metadata = object(row?.webhookMetadata);
    const graphApiVersion = string(metadata?.graphApiVersion);
    if (
      !row ||
      row.type !== 'WHATSAPP' ||
      row.status !== 'ACTIVE' ||
      !row.providerIdentityId ||
      !graphApiVersion
    )
      throw new WhatsAppOutboundPermanentError('whatsapp_connection_not_active');
    return {
      credentialsEncrypted: row.credentialsEncrypted,
      graphApiVersion,
      id: row.id,
      phoneNumberId: row.providerIdentityId,
      projectId: row.projectId,
    };
  }

  private decrypt(row: {
    credentialsEncrypted: Prisma.JsonValue;
    id: string;
    projectId: string;
  }): string {
    const container = object(row.credentialsEncrypted);
    const envelope = object(container?.accessToken) as EncryptedSecretEnvelope | undefined;
    if (!envelope) throw new WhatsAppOutboundPermanentError('whatsapp_access_token_unavailable');
    return this.secrets.decryptSecret({
      channelConnectionId: row.id,
      channelType: 'whatsapp',
      envelope,
      field: 'accessToken',
      projectId: row.projectId,
    });
  }

  private resolveAccessToken(connection: {
    credentialsEncrypted: Prisma.JsonValue;
    id: string;
    projectId: string;
  }): AccessTokenResolution {
    const container = object(connection.credentialsEncrypted);
    const envelope = object(container?.accessToken) as EncryptedSecretEnvelope | undefined;
    if (!envelope)
      return { accessToken: '', accessTokenPresent: false, accessTokenDecryptSucceeded: false };
    try {
      const accessToken = string(this.decrypt(connection)?.trim()) ?? '';
      return {
        accessToken,
        accessTokenDecryptSucceeded: true,
        accessTokenPresent: true,
      };
    } catch {
      return { accessToken: '', accessTokenPresent: true, accessTokenDecryptSucceeded: false };
    }
  }

  private sanitizeProviderMessage(message: string | undefined): string | undefined {
    const value = message?.trim();
    return value && value.length > 320 ? `${value.slice(0, 320)}...` : value;
  }

  private classifySendFailure(error: unknown, context?: SendAttemptContext): SendFailureAnalysis {
    const safeContext: SendAttemptContext = context ?? {
      accessTokenDecryptSucceeded: false,
      accessTokenPresent: false,
      connectionId: '',
      graphApiVersion: 'v23.0',
      messageType: 'unknown',
      operationId: '',
      outboxId: '',
      phoneNumberId: undefined,
      phoneNumberIdPresent: false,
      projectId: '',
      recipientPresent: false,
      correlationId: undefined,
    };
    if (error instanceof WhatsAppApiError) {
      const providerSafeMessage = this.sanitizeProviderMessage(error.providerMessage);
      const base: Omit<SendFailureAnalysis, 'mode' | 'safeReason'> = {
        httpStatus: error.status,
        ...(error.providerTraceId ? { providerTraceId: error.providerTraceId } : {}),
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
      if (error.providerCode !== undefined) base.providerErrorCode = error.providerCode;
      if (error.providerSubcode !== undefined) base.providerErrorSubcode = error.providerSubcode;
      if (error.providerType !== undefined) base.providerErrorType = error.providerType;
      if (providerSafeMessage !== undefined) base.providerSafeMessage = providerSafeMessage;
      if (error.status === 401) {
        return {
          ...base,
          mode: 'FAIL',
          safeReason: 'GRAPH_API_UNAUTHORIZED',
        };
      }
      if (error.status === 403) {
        return {
          ...base,
          mode: 'FAIL',
          safeReason: 'GRAPH_API_PERMISSION_DENIED',
        };
      }
      if (error.status === 404 && !safeContext.phoneNumberIdPresent) {
        return {
          ...base,
          mode: 'FAIL',
          safeReason: 'GRAPH_API_INVALID_PHONE_NUMBER_ID',
        };
      }
      if (error.status === 429) {
        return {
          ...base,
          mode: 'RETRY',
          safeReason: 'GRAPH_API_RATE_LIMITED',
        };
      }
      if (error.status >= 500) {
        return {
          ...base,
          mode: 'RETRY',
          safeReason: 'GRAPH_API_UNKNOWN_RESULT',
        };
      }
      if (error.status >= 400 && error.status < 500) {
        const hasRecipientError = /(phone|recipient|contact|to)/i.test(error.providerMessage ?? '');
        const hasRecipientErrorInSafeMessage = /(recipient|to)/i.test(providerSafeMessage ?? '');
        if ((error.providerCode === 100 || error.providerCode === 131000) && hasRecipientError)
          return { ...base, mode: 'FAIL', safeReason: 'GRAPH_API_INVALID_RECIPIENT' };
        if (
          (error.providerCode === 100 && !safeContext.recipientPresent) ||
          hasRecipientErrorInSafeMessage
        )
          return { ...base, mode: 'FAIL', safeReason: 'GRAPH_API_INVALID_RECIPIENT' };
        if (/(phone.?number.?id|phone number id|sender)/i.test(providerSafeMessage ?? '')) {
          return {
            ...base,
            mode: 'FAIL',
            safeReason: 'GRAPH_API_INVALID_PHONE_NUMBER_ID',
          };
        }
        if (/template/i.test(providerSafeMessage ?? '')) {
          return {
            ...base,
            mode: 'FAIL',
            safeReason: 'GRAPH_API_TEMPLATE_REQUIRED',
          };
        }
        return {
          ...base,
          mode: 'FAIL',
          safeReason: 'GRAPH_API_PROVIDER_REJECTED',
        };
      }
      return {
        ...base,
        mode: 'FAIL',
        safeReason: 'GRAPH_API_REQUEST_INVALID',
      };
    }
    if (error instanceof Error && error.name === 'TimeoutError')
      return { mode: 'UNKNOWN', safeReason: 'GRAPH_API_TIMEOUT' };
    const message = this.sanitizeProviderMessage(
      error instanceof Error ? error.message : undefined,
    );
    return message !== undefined
      ? {
          mode: 'UNKNOWN',
          safeReason: 'GRAPH_API_UNKNOWN_RESULT',
          providerSafeMessage: message,
        }
      : {
          mode: 'UNKNOWN',
          safeReason: 'GRAPH_API_UNKNOWN_RESULT',
        };
  }

  private async logOutboundSendRejection(
    claimed: ClaimedOutboxRecord,
    messageId: string | undefined,
    analysis: SendFailureAnalysis,
    context?: SendAttemptContext,
  ): Promise<void> {
    const contextValue = context ?? {
      accessTokenDecryptSucceeded: false,
      accessTokenPresent: false,
      connectionId: claimed.connectionId,
      correlationId: undefined,
      graphApiVersion: 'v23.0',
      messageType: 'unknown',
      operationId: claimed.id,
      outboxId: claimed.id,
      phoneNumberId: undefined,
      phoneNumberIdPresent: false,
      projectId: claimed.projectId,
      recipientPresent: false,
    };
    const payload: Record<string, unknown> = {
      event: 'whatsapp_outbound_rejected',
      outboxId: claimed.id,
      operationId: contextValue.operationId,
      connectionId: contextValue.connectionId,
      projectId: claimed.projectId,
      correlationId: contextValue.correlationId,
      graphApiVersion: contextValue.graphApiVersion,
      phoneNumberIdPresent: contextValue.phoneNumberIdPresent,
      accessTokenPresent: contextValue.accessTokenPresent,
      accessTokenDecryptSucceeded: contextValue.accessTokenDecryptSucceeded,
      recipientPresent: contextValue.recipientPresent,
      messageType: contextValue.messageType,
      httpStatus: analysis.httpStatus,
      providerErrorCode: analysis.providerErrorCode,
      providerErrorSubcode: analysis.providerErrorSubcode,
      providerErrorType: analysis.providerErrorType,
      providerSafeMessage: analysis.providerSafeMessage,
      providerTraceId: analysis.providerTraceId,
      retryable: analysis.mode === 'RETRY',
      safeReason: analysis.safeReason,
      ...(analysis.retryAfterSeconds ? { retryAfterSeconds: analysis.retryAfterSeconds } : {}),
    };
    if (messageId) payload.messageId = messageId;
    this.logger.warn(JSON.stringify(payload));
  }

  private async prepareMessage(
    connection: {
      credentialsEncrypted: Prisma.JsonValue;
      graphApiVersion: string;
      id: string;
      phoneNumberId: string;
      projectId: string;
    },
    message: {
      content: Prisma.JsonValue;
      mediaAsset: {
        bucketKey: string | null;
        connectionId: string | null;
        declaredMimeType: string | null;
        detectedMimeType: string | null;
        id: string;
        kind: string;
        originalFilename: string | null;
        providerMediaId: string | null;
        source: string;
        status: string;
      } | null;
      metadata: Prisma.JsonValue | null;
      type: string;
    },
    claimed: ClaimedOutboxRecord,
  ): Promise<{ message: WhatsAppOutboundMessage; template: boolean }> {
    const content = object(message.content) ?? {};
    const metadata = object(message.metadata) ?? {};
    const templateInput = object(content.whatsAppTemplate) ?? object(metadata.whatsAppTemplate);
    if (templateInput) {
      const template = await this.prepareTemplate(connection, templateInput, claimed);
      return { message: { template, type: 'template' }, template: true };
    }
    const reaction = object(content.reaction) ?? object(metadata.whatsAppReaction);
    if (reaction) {
      const target = string(reaction.providerMessageId);
      if (!target) throw new WhatsAppOutboundPermanentError('whatsapp_reaction_invalid');
      try {
        assertWhatsAppReactionEmoji(reaction.emoji);
      } catch {
        throw new WhatsAppOutboundPermanentError('whatsapp_reaction_invalid');
      }
      return {
        message: { emoji: reaction.emoji, messageId: target, type: 'reaction' },
        template: false,
      };
    }
    if (message.type === 'TEXT') {
      const text = string(content.text);
      if (!text) throw new WhatsAppOutboundPermanentError('whatsapp_text_invalid');
      return {
        message: { previewUrl: content.previewUrl === true, text, type: 'text' },
        template: false,
      };
    }
    if (['PHOTO', 'VIDEO', 'AUDIO', 'VOICE', 'DOCUMENT', 'STICKER'].includes(message.type)) {
      if (!message.mediaAsset)
        throw new WhatsAppOutboundPermanentError('whatsapp_media_unavailable');
      const mediaId = await this.providerMediaId(connection, message.mediaAsset, claimed);
      const caption = string(content.caption);
      if (message.type === 'PHOTO')
        return {
          message: { ...(caption ? { caption } : {}), mediaId, type: 'image' },
          template: false,
        };
      if (message.type === 'VIDEO')
        return {
          message: { ...(caption ? { caption } : {}), mediaId, type: 'video' },
          template: false,
        };
      if (message.type === 'DOCUMENT')
        return {
          message: {
            ...(caption ? { caption } : {}),
            ...(message.mediaAsset.originalFilename
              ? { filename: message.mediaAsset.originalFilename }
              : {}),
            mediaId,
            type: 'document',
          },
          template: false,
        };
      if (message.type === 'STICKER')
        return { message: { mediaId, type: 'sticker' }, template: false };
      return {
        message: { mediaId, type: 'audio', ...(message.type === 'VOICE' ? { voice: true } : {}) },
        template: false,
      };
    }
    if (message.type === 'LOCATION') {
      if (typeof content.latitude !== 'number' || typeof content.longitude !== 'number')
        throw new WhatsAppOutboundPermanentError('whatsapp_location_invalid');
      const address = string(content.address);
      const name = string(content.name);
      return {
        message: {
          ...(address ? { address } : {}),
          latitude: content.latitude,
          longitude: content.longitude,
          ...(name ? { name } : {}),
          type: 'location',
        },
        template: false,
      };
    }
    if (message.type === 'CONTACT') {
      const contact =
        object(content.contact) ??
        (Array.isArray(content.contacts) ? object(content.contacts[0]) : undefined);
      const name = object(contact?.name);
      const formattedName = string(contact?.formattedName) ?? string(name?.formattedName);
      const firstName = string(contact?.firstName) ?? string(name?.firstName);
      const lastName = string(contact?.lastName) ?? string(name?.lastName);
      const phones = Array.isArray(contact?.phones)
        ? contact.phones.flatMap((candidate) => {
            const phone = object(candidate);
            const value = string(phone?.phone);
            if (!value) return [];
            const phoneType = string(phone?.type);
            const waId = string(phone?.waId);
            return [
              {
                phone: value,
                ...(phoneType ? { type: phoneType } : {}),
                ...(waId ? { waId } : {}),
              },
            ];
          })
        : [];
      const emails = Array.isArray(contact?.emails)
        ? contact.emails.flatMap((candidate) => {
            const email = object(candidate);
            const value = string(email?.email);
            if (!value) return [];
            const emailType = string(email?.type);
            return [{ email: value, ...(emailType ? { type: emailType } : {}) }];
          })
        : undefined;
      if (!formattedName || phones.length === 0)
        throw new WhatsAppOutboundPermanentError('whatsapp_contact_invalid');
      return {
        message: {
          contact: {
            ...(emails?.length ? { emails } : {}),
            ...(firstName ? { firstName } : {}),
            formattedName,
            ...(lastName ? { lastName } : {}),
            phones,
          },
          type: 'contact',
        },
        template: false,
      };
    }
    if (message.type === 'INTERACTIVE') {
      const interactive = object(content.interactive);
      if (!interactive) throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
      return {
        message: {
          interactive: await this.prepareInteractive(connection, interactive, claimed),
          type: 'interactive',
        },
        template: false,
      };
    }
    throw new WhatsAppOutboundPermanentError('whatsapp_message_type_unsupported');
  }

  private async prepareTemplate(
    connection: {
      credentialsEncrypted: Prisma.JsonValue;
      graphApiVersion: string;
      id: string;
      phoneNumberId: string;
      projectId: string;
    },
    input: JsonObject,
    claimed: ClaimedOutboxRecord,
  ): Promise<WhatsAppTemplateSend> {
    const name = string(input.name);
    const languageCode = string(input.languageCode);
    if (!name || !languageCode)
      throw new WhatsAppOutboundPermanentError('whatsapp_template_invalid');
    const approved = await this.database.client.whatsAppMessageTemplate.findUnique({
      where: {
        projectId_connectionId_name_languageCode: {
          connectionId: connection.id,
          languageCode,
          name,
          projectId: connection.projectId,
        },
      },
    });
    if (!approved || approved.status !== 'APPROVED')
      throw new WhatsAppOutboundPermanentError('whatsapp_template_not_approved');
    if (whatsAppTemplateDisabledReason(approved))
      throw new WhatsAppOutboundPermanentError('whatsapp_template_unsupported');
    try {
      assertWhatsAppTemplateComponents(approved.components, input.components);
    } catch {
      throw new WhatsAppOutboundPermanentError('whatsapp_template_components_invalid');
    }
    const components = Array.isArray(input.components)
      ? await Promise.all(
          input.components.map(async (candidate) => {
            const component = object(candidate);
            const type = string(component?.type);
            if (!component || !type || !['header', 'body', 'button'].includes(type))
              throw new WhatsAppOutboundPermanentError('whatsapp_template_component_invalid');
            const parameters = Array.isArray(component.parameters)
              ? await Promise.all(
                  component.parameters.map((parameter) =>
                    this.templateParameter(connection, parameter, claimed),
                  ),
                )
              : [];
            if (type === 'button') {
              const subType = string(component.subType);
              const index = component.index;
              if (
                !['quick_reply', 'url'].includes(subType ?? '') ||
                typeof index !== 'number' ||
                !Number.isInteger(index) ||
                index < 0
              )
                throw new WhatsAppOutboundPermanentError('whatsapp_template_button_invalid');
              this.assertTemplateButton(
                approved.components,
                subType as 'quick_reply' | 'url',
                index,
                parameters,
              );
              return {
                index,
                parameters,
                subType: subType as 'quick_reply' | 'url',
                type: 'button' as const,
              };
            }
            return { parameters, type: type as 'body' | 'header' };
          }),
        )
      : undefined;
    return { ...(components ? { components } : {}), languageCode, name };
  }

  private assertTemplateButton(
    definition: Prisma.JsonValue,
    subType: 'quick_reply' | 'url',
    index: number,
    parameters: WhatsAppTemplateParameter[],
  ): void {
    const components = Array.isArray(definition) ? definition : [];
    const buttonsComponent = components
      .map((candidate) => object(candidate))
      .find((candidate) => candidate?.type === 'BUTTONS');
    const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : [];
    const button = object(buttons[index]);
    const expectedType = subType === 'url' ? 'URL' : 'QUICK_REPLY';
    if (!button || button.type !== expectedType)
      throw new WhatsAppOutboundPermanentError('whatsapp_template_button_invalid');
    if (subType === 'url') {
      if (button.dynamic !== true || parameters.length !== 1 || parameters[0]?.type !== 'text')
        throw new WhatsAppOutboundPermanentError('whatsapp_template_button_invalid');
      return;
    }
    if (parameters.length !== 1 || parameters[0]?.type !== 'payload')
      throw new WhatsAppOutboundPermanentError('whatsapp_template_button_invalid');
  }

  private async prepareInteractive(
    connection: {
      credentialsEncrypted: Prisma.JsonValue;
      graphApiVersion: string;
      id: string;
      phoneNumberId: string;
      projectId: string;
    },
    input: JsonObject,
    claimed: ClaimedOutboxRecord,
  ): Promise<WhatsAppInteractive> {
    const type = string(input.type);
    const body = object(input.body);
    const bodyText = string(body?.text);
    if (!bodyText || bodyText.length > 1_024 || !['button', 'list'].includes(type ?? ''))
      throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
    const footerInput = object(input.footer);
    const footerText = string(footerInput?.text);
    if (footerText && footerText.length > 60)
      throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
    const headerInput = object(input.header);
    let header: WhatsAppInteractive['header'];
    if (headerInput) {
      const headerType = string(headerInput.type);
      if (headerType === 'text') {
        const text = string(headerInput.text);
        if (!text || text.length > 60)
          throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
        header = { text, type: 'text' };
      } else if (type === 'button' && ['document', 'image', 'video'].includes(headerType ?? '')) {
        const mediaAssetId = string(headerInput.mediaAssetId);
        if (!mediaAssetId) throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
        const asset = await this.database.client.mediaAsset.findUnique({
          where: { projectId_id: { id: mediaAssetId, projectId: connection.projectId } },
        });
        if (!asset) throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
        header = {
          mediaId: await this.providerMediaId(connection, asset, claimed),
          type: headerType as 'document' | 'image' | 'video',
        };
      } else throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
    }
    const action = object(input.action);
    if (!action) throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
    if (type === 'button') {
      if (!Array.isArray(action.buttons) || action.buttons.length < 1 || action.buttons.length > 3)
        throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
      const ids = new Set<string>();
      const buttons = action.buttons.map((candidate) => {
        const button = object(candidate);
        const id = string(button?.id);
        const title = string(button?.title);
        if (!id || !title || id.length > 256 || title.length > 20 || ids.has(id))
          throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
        ids.add(id);
        return { id, title };
      });
      return {
        action: { buttons },
        body: { text: bodyText },
        ...(footerText ? { footer: { text: footerText } } : {}),
        ...(header
          ? {
              header: header as NonNullable<
                Extract<WhatsAppInteractive, { type: 'button' }>['header']
              >,
            }
          : {}),
        type: 'button',
      };
    }
    const button = string(action.button);
    if (
      !button ||
      button.length > 20 ||
      !Array.isArray(action.sections) ||
      action.sections.length < 1 ||
      action.sections.length > 10
    )
      throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
    const rowIds = new Set<string>();
    let rowCount = 0;
    const sections = action.sections.map((candidate) => {
      const section = object(candidate);
      const title = string(section?.title);
      if (
        !section ||
        (title && title.length > 24) ||
        !Array.isArray(section.rows) ||
        section.rows.length < 1
      )
        throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
      const rows = section.rows.map((rowInput) => {
        const row = object(rowInput);
        const id = string(row?.id);
        const rowTitle = string(row?.title);
        const description = string(row?.description);
        rowCount += 1;
        if (
          !id ||
          !rowTitle ||
          id.length > 200 ||
          rowTitle.length > 24 ||
          (description && description.length > 72) ||
          rowIds.has(id) ||
          rowCount > 10
        )
          throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
        rowIds.add(id);
        return { ...(description ? { description } : {}), id, title: rowTitle };
      });
      return { rows, ...(title ? { title } : {}) };
    });
    if (header && header.type !== 'text')
      throw new WhatsAppOutboundPermanentError('whatsapp_interactive_invalid');
    return {
      action: { button, sections },
      body: { text: bodyText },
      ...(footerText ? { footer: { text: footerText } } : {}),
      ...(header ? { header } : {}),
      type: 'list',
    };
  }

  private async templateParameter(
    connection: {
      credentialsEncrypted: Prisma.JsonValue;
      graphApiVersion: string;
      id: string;
      phoneNumberId: string;
      projectId: string;
    },
    candidate: unknown,
    claimed: ClaimedOutboxRecord,
  ): Promise<WhatsAppTemplateParameter> {
    const parameter = object(candidate);
    const type = string(parameter?.type);
    if (!parameter || !type)
      throw new WhatsAppOutboundPermanentError('whatsapp_template_parameter_invalid');
    if (type === 'text' && typeof parameter.text === 'string')
      return { text: parameter.text, type: 'text' };
    if (type === 'payload' && typeof parameter.payload === 'string')
      return { payload: parameter.payload, type: 'payload' };
    if (
      type === 'currency' &&
      typeof parameter.amount1000 === 'number' &&
      typeof parameter.code === 'string' &&
      typeof parameter.fallbackValue === 'string'
    )
      return {
        amount1000: parameter.amount1000,
        code: parameter.code,
        fallbackValue: parameter.fallbackValue,
        type: 'currency',
      };
    if (type === 'date_time' && typeof parameter.fallbackValue === 'string')
      return { fallbackValue: parameter.fallbackValue, type: 'date_time' };
    if (['image', 'video', 'document'].includes(type)) {
      const mediaAssetId = string(parameter.mediaAssetId);
      if (!mediaAssetId)
        throw new WhatsAppOutboundPermanentError('whatsapp_template_media_invalid');
      const asset = await this.database.client.mediaAsset.findUnique({
        where: { projectId_id: { id: mediaAssetId, projectId: connection.projectId } },
      });
      if (!asset) throw new WhatsAppOutboundPermanentError('whatsapp_template_media_invalid');
      return {
        mediaId: await this.providerMediaId(connection, asset, claimed),
        type: type as 'document' | 'image' | 'video',
      };
    }
    throw new WhatsAppOutboundPermanentError('whatsapp_template_parameter_invalid');
  }

  private async providerMediaId(
    connection: {
      credentialsEncrypted: Prisma.JsonValue;
      graphApiVersion: string;
      id: string;
      phoneNumberId: string;
      projectId: string;
    },
    asset: {
      bucketKey: string | null;
      connectionId: string | null;
      declaredMimeType: string | null;
      detectedMimeType: string | null;
      id: string;
      kind: string;
      originalFilename: string | null;
      providerMediaId: string | null;
      source: string;
      status: string;
    },
    claimed: ClaimedOutboxRecord,
  ): Promise<string> {
    if (
      asset.source === 'WHATSAPP' &&
      asset.connectionId === connection.id &&
      asset.providerMediaId &&
      asset.status === 'PROVIDER_REFERENCE'
    )
      return asset.providerMediaId;
    const claimedPayload = object(claimed.payload) ?? {};
    const uploadedMedia = object(claimedPayload.whatsAppMediaUploads) ?? {};
    const cachedMediaId = string(uploadedMedia[asset.id]);
    if (cachedMediaId) return cachedMediaId;
    if (asset.status !== 'AVAILABLE' || !asset.bucketKey || !this.storage)
      throw new WhatsAppOutboundPermanentError('whatsapp_media_unavailable');
    const stored = await this.storage.getObject(asset.bucketKey);
    const contentType = asset.detectedMimeType ?? asset.declaredMimeType ?? stored.contentType;
    const providerKind =
      asset.kind === 'PHOTO'
        ? 'image'
        : asset.kind === 'VOICE'
          ? 'audio'
          : asset.kind.toLowerCase();
    if (!contentType || !['audio', 'document', 'image', 'sticker', 'video'].includes(providerKind))
      throw new WhatsAppOutboundPermanentError('whatsapp_media_unsupported');
    try {
      assertWhatsAppMedia(
        providerKind as 'audio' | 'document' | 'image' | 'sticker' | 'video',
        contentType,
        stored.bytes.byteLength,
        stored.bytes,
      );
    } catch {
      throw new WhatsAppOutboundPermanentError('whatsapp_media_rejected');
    }
    let providerMediaId: string;
    try {
      providerMediaId = await this.api.uploadMedia({
        accessToken: this.decrypt(connection),
        bytes: stored.bytes,
        contentType,
        filename: asset.originalFilename ?? `${asset.id}.${providerKind}`,
        graphApiVersion: connection.graphApiVersion,
        phoneNumberId: connection.phoneNumberId,
      });
    } catch (error) {
      if (error instanceof WhatsAppApiError && error.status < 500 && error.status !== 429)
        throw new WhatsAppOutboundPermanentError('whatsapp_media_rejected');
      if (!(error instanceof WhatsAppApiError) || error.status >= 500) {
        const messageId = string(claimedPayload.messageId);
        if (messageId) await this.unknown(claimed, messageId, 'whatsapp_media_upload_unknown');
        else await this.unknownOutboxOnly(claimed, 'whatsapp_media_upload_unknown');
        throw new WhatsAppOutboundUnknownError('whatsapp_media_upload_unknown');
      }
      throw error;
    }
    const nextPayload = {
      ...claimedPayload,
      whatsAppMediaUploads: { ...uploadedMedia, [asset.id]: providerMediaId },
    } as Prisma.InputJsonObject;
    const persisted = await this.database.client.outboxRecord.updateMany({
      data: { payload: nextPayload },
      where: {
        id: claimed.id,
        lockedBy: claimed.leaseToken,
        projectId: claimed.projectId,
        status: 'PROCESSING',
      },
    });
    if (persisted.count !== 1) {
      const messageId = string(claimedPayload.messageId);
      if (messageId)
        await this.unknown(claimed, messageId, 'whatsapp_media_upload_persistence_unknown');
      else await this.unknownOutboxOnly(claimed, 'whatsapp_media_upload_persistence_unknown');
      throw new WhatsAppOutboundUnknownError('whatsapp_media_upload_persistence_unknown');
    }
    claimed.payload = nextPayload as unknown as Prisma.JsonValue;
    return providerMediaId;
  }

  private async assertServiceWindow(
    conversationId: string,
    claimed: ClaimedOutboxRecord,
  ): Promise<void> {
    const conversation = await this.database.client.conversation.findUnique({
      select: { serviceWindowExpiresAt: true },
      where: { projectId_id: { id: conversationId, projectId: claimed.projectId } },
    });
    if (!conversation?.serviceWindowExpiresAt || conversation.serviceWindowExpiresAt <= new Date())
      throw new WhatsAppOutboundPermanentError('whatsapp_template_required');
  }

  private async replyProviderMessageId(
    metadataValue: Prisma.JsonValue | null,
    claimed: ClaimedOutboxRecord,
    current: { contactId: string; conversationId: string },
  ): Promise<string | undefined> {
    const replyToMessageId = string(object(metadataValue)?.replyToMessageId);
    if (!replyToMessageId) return;
    const target = await this.database.client.message.findUnique({
      select: {
        connectionId: true,
        contactId: true,
        conversationId: true,
        externalMessageId: true,
      },
      where: { projectId_id: { id: replyToMessageId, projectId: claimed.projectId } },
    });
    if (
      !target ||
      target.connectionId !== claimed.connectionId ||
      target.contactId !== current.contactId ||
      target.conversationId !== current.conversationId ||
      !target.externalMessageId
    )
      throw new WhatsAppOutboundPermanentError('whatsapp_reply_target_invalid');
    return target.externalMessageId;
  }

  private async persistProviderSendJournal(
    claimed: ClaimedOutboxRecord,
    providerMessageId: string,
  ): Promise<boolean> {
    const payload = {
      ...(object(claimed.payload) ?? {}),
      providerMessageId,
    } as Prisma.InputJsonObject;
    const updated = await this.database.client.outboxRecord.updateMany({
      data: { payload },
      where: {
        id: claimed.id,
        lockedBy: claimed.leaseToken,
        projectId: claimed.projectId,
        status: 'PROCESSING',
      },
    });
    if (updated.count === 1) claimed.payload = payload as unknown as Prisma.JsonValue;
    return updated.count === 1;
  }

  private async recoverJournaledSend(
    claimed: ClaimedOutboxRecord,
    messageId: string,
    providerMessageId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const updated = await transaction.outboxRecord.updateMany({
        data: {
          completedAt: new Date(),
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
          status: 'SUCCEEDED',
        },
        where: {
          id: claimed.id,
          lockedBy: claimed.leaseToken,
          projectId: claimed.projectId,
          status: 'PROCESSING',
        },
      });
      if (updated.count !== 1) throw new WhatsAppOutboundLeaseConflictError();
      const messageUpdated = await transaction.message.updateMany({
        data: {
          externalMessageId: providerMessageId,
          failedAt: null,
          sentAt: new Date(),
          status: 'SENT',
        },
        where: {
          connectionId: claimed.connectionId,
          direction: 'OUTBOUND',
          id: messageId,
          projectId: claimed.projectId,
        },
      });
      if (messageUpdated.count !== 1) throw new WhatsAppOutboundLeaseConflictError();
      await transaction.broadcastRecipient.updateMany({
        data: {
          completedAt: new Date(),
          lastError: null,
          status: 'SENT',
        },
        where: { messageId, projectId: claimed.projectId },
      });
      const channelIdentityId = string(object(claimed.payload)?.channelIdentityId);
      if (channelIdentityId)
        await transaction.channelIdentity.updateMany({
          data: {
            whatsAppLastErrorCode: null,
            whatsAppReachability: 'PENDING',
            whatsAppReachabilityCheckedAt: new Date(),
          },
          where: {
            id: channelIdentityId,
            projectId: claimed.projectId,
            whatsAppReachability: { in: ['UNKNOWN', 'PENDING', 'UNAVAILABLE'] },
          },
        });
      await transaction.scheduledMessage.updateMany({
        data: { completedAt: new Date(), status: 'SENT' },
        where: {
          messageId,
          projectId: claimed.projectId,
          status: { in: ['QUEUED', 'PROCESSING'] },
        },
      });
      await this.queueCrmMessageStatus(
        transaction,
        claimed.projectId,
        messageId,
        'SENT',
        providerMessageId,
      );
      await ensureCrmOutboundHistoryIntent(transaction, claimed.projectId, messageId);
      await this.completeBroadcastForMessage(transaction, claimed.projectId, messageId);
    });
  }

  private async queueCrmMessageStatus(
    transaction: Prisma.TransactionClient,
    projectId: string,
    messageId: string,
    status: 'FAILED' | 'SENT' | 'UNKNOWN',
    providerMessageId?: string,
    errorCode?: string,
  ): Promise<void> {
    const [message, crm] = await Promise.all([
      transaction.message.findUnique({
        select: {
          connectionId: true,
          contactId: true,
          externalMessageId: true,
          metadata: true,
        },
        where: { projectId_id: { id: messageId, projectId } },
      }),
      transaction.crmProjectConfig.findUnique({
        select: { enabled: true, status: true },
        where: { projectId },
      }),
    ]);
    if (
      !message ||
      object(message.metadata)?.source !== 'crm' ||
      !crm?.enabled ||
      crm.status !== 'ACTIVE'
    )
      return;
    const effectiveProviderMessageId = providerMessageId ?? message.externalMessageId ?? undefined;
    const idempotencyKey = `crm-local-message-status-${messageId}-${status}`;
    await transaction.outboxRecord.createMany({
      data: [{ idempotencyKey, kind: 'CRM', payload: {}, projectId }],
      skipDuplicates: true,
    });
    const outbox = await transaction.outboxRecord.findUnique({
      include: { crmOperation: { select: { id: true } } },
      where: { projectId_idempotencyKey: { idempotencyKey, projectId } },
    });
    if (!outbox || outbox.crmOperation) return;
    const operation = await transaction.crmOperation.create({
      data: {
        contactId: message.contactId,
        inputSafe: {
          connectionId: message.connectionId,
          ...(errorCode ? { errorCode } : {}),
          messageId,
          occurredAt: new Date().toISOString(),
          ...(effectiveProviderMessageId ? { providerMessageId: effectiveProviderMessageId } : {}),
          status,
        },
        outboxRecordId: outbox.id,
        projectId,
        type: 'FORWARD_MESSAGE_STATUS',
      },
    });
    await transaction.outboxRecord.update({
      data: { payload: { crmOperationId: operation.id } },
      where: { projectId_id: { id: outbox.id, projectId } },
    });
  }

  private async setReaction(
    claimed: ClaimedOutboxRecord,
    connection: {
      credentialsEncrypted: Prisma.JsonValue;
      graphApiVersion: string;
      id: string;
      phoneNumberId: string;
      projectId: string;
    },
    payload: JsonObject,
  ): Promise<void> {
    const messageId = string(payload.messageId);
    const providerMessageId = string(payload.providerMessageId);
    const channelIdentityId = string(payload.channelIdentityId);
    if (!messageId || !providerMessageId || !channelIdentityId || typeof payload.emoji !== 'string')
      throw new WhatsAppOutboundPermanentError('whatsapp_reaction_invalid');
    try {
      assertWhatsAppReactionEmoji(payload.emoji);
    } catch {
      throw new WhatsAppOutboundPermanentError('whatsapp_reaction_invalid');
    }
    const [message, identity] = await Promise.all([
      this.database.client.message.findUnique({
        select: {
          connectionId: true,
          contactId: true,
          conversationId: true,
          externalMessageId: true,
        },
        where: { projectId_id: { id: messageId, projectId: claimed.projectId } },
      }),
      this.database.client.channelIdentity.findUnique({
        where: { projectId_id: { id: channelIdentityId, projectId: claimed.projectId } },
      }),
    ]);
    if (
      !message ||
      !identity ||
      message.connectionId !== claimed.connectionId ||
      message.externalMessageId !== providerMessageId ||
      identity.connectionId !== claimed.connectionId ||
      identity.contactId !== message.contactId ||
      identity.channel !== 'WHATSAPP'
    )
      throw new WhatsAppOutboundPermanentError('whatsapp_reaction_scope_invalid');
    await this.assertServiceWindow(message.conversationId, claimed);
    try {
      await this.api.sendMessage({
        accessToken: this.decrypt(connection),
        graphApiVersion: connection.graphApiVersion,
        message: { emoji: payload.emoji, messageId: providerMessageId, type: 'reaction' },
        phoneNumberId: connection.phoneNumberId,
        to: identity.externalUserId,
      });
    } catch (error) {
      if (error instanceof WhatsAppApiError && error.status === 429) {
        await this.retry(claimed, 'whatsapp_reaction_retryable', error.retryAfterSeconds, true);
        return;
      }
      if (error instanceof WhatsAppApiError && error.status < 500) {
        await this.failOutboxOnly(claimed, 'whatsapp_reaction_rejected');
        return;
      }
      await this.unknownOutboxOnly(claimed, 'whatsapp_reaction_unknown');
      return;
    }
    await this.succeedOutboxOnly(claimed);
  }

  private async handlePreMessageError(
    claimed: ClaimedOutboxRecord,
    error: unknown,
    fallback: string,
  ): Promise<void> {
    if (error instanceof WhatsAppApiError) {
      if (error.status === 429 || error.status >= 500) {
        await this.retry(claimed, fallback, error.retryAfterSeconds, true);
        return;
      }
      await this.failOutboxOnly(claimed, fallback);
      return;
    }
    await this.retry(claimed, fallback, undefined, true);
  }

  private async handleMessageSendError(
    claimed: ClaimedOutboxRecord,
    messageId: string,
    error: unknown,
    context?: SendAttemptContext,
  ): Promise<void> {
    const analysis = this.classifySendFailure(error, context);
    if (analysis.mode === 'FAIL') {
      if (context) await this.logOutboundSendRejection(claimed, messageId, analysis, context);
      await this.fail(claimed, 'whatsapp_outbound_rejected', messageId, analysis.safeReason);
      return;
    }
    if (analysis.mode === 'RETRY') {
      await this.retry(claimed, 'whatsapp_outbound_retryable', analysis.retryAfterSeconds);
      return;
    }
    await this.unknown(claimed, messageId, 'whatsapp_outbound_unknown');
  }

  private async handleMarkReadError(
    claimed: ClaimedOutboxRecord,
    error: unknown,
    context?: SendAttemptContext,
  ): Promise<void> {
    const analysis = this.classifySendFailure(error, context);
    if (analysis.mode === 'FAIL') {
      if (context) await this.logOutboundSendRejection(claimed, undefined, analysis, context);
      await this.failOutboxOnly(claimed, 'whatsapp_mark_read_failed');
      return;
    }
    if (analysis.mode === 'RETRY') {
      await this.retry(claimed, 'whatsapp_mark_read_retryable', analysis.retryAfterSeconds, true);
      return;
    }
    await this.unknownOutboxOnly(claimed, 'whatsapp_mark_read_unknown');
  }

  private async succeedOutboxOnly(claimed: ClaimedOutboxRecord): Promise<void> {
    const updated = await this.database.client.outboxRecord.updateMany({
      data: {
        completedAt: new Date(),
        lastError: null,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
        status: 'SUCCEEDED',
      },
      where: {
        id: claimed.id,
        lockedBy: claimed.leaseToken,
        projectId: claimed.projectId,
        status: 'PROCESSING',
      },
    });
    if (updated.count !== 1) throw new WhatsAppOutboundLeaseConflictError();
  }

  private async failOutboxOnly(claimed: ClaimedOutboxRecord, code: string): Promise<void> {
    const updated = await this.database.client.outboxRecord.updateMany({
      data: {
        completedAt: new Date(),
        lastError: code,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
        status: 'FAILED',
      },
      where: {
        id: claimed.id,
        lockedBy: claimed.leaseToken,
        projectId: claimed.projectId,
        status: 'PROCESSING',
      },
    });
    if (updated.count !== 1) throw new WhatsAppOutboundLeaseConflictError();
  }

  private async unknownOutboxOnly(claimed: ClaimedOutboxRecord, code: string): Promise<void> {
    const updated = await this.database.client.outboxRecord.updateMany({
      data: {
        completedAt: new Date(),
        lastError: code,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
        status: 'UNKNOWN',
      },
      where: {
        id: claimed.id,
        lockedBy: claimed.leaseToken,
        projectId: claimed.projectId,
        status: 'PROCESSING',
      },
    });
    if (updated.count !== 1) throw new WhatsAppOutboundLeaseConflictError();
  }

  private async fail(
    claimed: ClaimedOutboxRecord,
    code: string,
    messageId?: string,
    reachabilityErrorCode?: SendFailureSafeReason,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const updated = await transaction.outboxRecord.updateMany({
        data: {
          completedAt: new Date(),
          lastError: code,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
          status: 'FAILED',
        },
        where: {
          id: claimed.id,
          lockedBy: claimed.leaseToken,
          projectId: claimed.projectId,
          status: 'PROCESSING',
        },
      });
      if (updated.count !== 1) throw new WhatsAppOutboundLeaseConflictError();
      const resolvedMessageId = messageId ?? string(object(claimed.payload)?.messageId);
      if (!resolvedMessageId) return;
      await transaction.message.updateMany({
        data: { failedAt: new Date(), status: 'FAILED' },
        where: { id: resolvedMessageId, projectId: claimed.projectId },
      });
      const channelIdentityId = string(object(claimed.payload)?.channelIdentityId);
      const channelIdentity = channelIdentityId
        ? await transaction.channelIdentity.findUnique({
            select: { contactId: true },
            where: { projectId_id: { id: channelIdentityId, projectId: claimed.projectId } },
          })
        : null;
      if (channelIdentityId && reachabilityErrorCode)
        await transaction.channelIdentity.updateMany({
          data: {
            whatsAppLastErrorCode: reachabilityErrorCode,
            ...(reachabilityErrorCode === 'GRAPH_API_INVALID_RECIPIENT'
              ? { whatsAppReachability: 'UNAVAILABLE' as const }
              : {}),
            whatsAppReachabilityCheckedAt: new Date(),
          },
          where: { id: channelIdentityId, projectId: claimed.projectId },
        });
      if (channelIdentity && reachabilityErrorCode)
        await this.queueCrmEligibilitySync(
          transaction,
          claimed.projectId,
          channelIdentity.contactId,
          claimed.connectionId,
          resolvedMessageId,
          reachabilityErrorCode,
        );
      await this.queueCrmMessageStatus(
        transaction,
        claimed.projectId,
        resolvedMessageId,
        'FAILED',
        undefined,
        (reachabilityErrorCode ?? code.toUpperCase()).slice(0, 80),
      );
      await transaction.broadcastRecipient.updateMany({
        data: { completedAt: new Date(), lastError: code, status: 'FAILED' },
        where: { messageId: resolvedMessageId, projectId: claimed.projectId },
      });
      await transaction.scheduledMessage.updateMany({
        data: { completedAt: new Date(), status: 'FAILED' },
        where: {
          messageId: resolvedMessageId,
          projectId: claimed.projectId,
          status: { in: ['QUEUED', 'PROCESSING'] },
        },
      });
      await this.completeBroadcastForMessage(transaction, claimed.projectId, resolvedMessageId);
    });
  }

  private async retry(
    claimed: ClaimedOutboxRecord,
    code: string,
    retryAfterSeconds?: number,
    outboxOnly = false,
  ): Promise<void> {
    if (claimed.attempts >= claimed.maxAttempts) {
      await (outboxOnly ? this.failOutboxOnly(claimed, code) : this.fail(claimed, code));
      return;
    }
    const delay = retryAfterSeconds
      ? Math.min(24 * 60 * 60_000, retryAfterSeconds * 1_000)
      : Math.min(60_000, 1_000 * 2 ** Math.max(0, claimed.attempts - 1));
    const updated = await this.database.client.outboxRecord.updateMany({
      data: {
        lastError: code,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: new Date(Date.now() + delay),
        status: 'RETRY',
      },
      where: {
        id: claimed.id,
        lockedBy: claimed.leaseToken,
        projectId: claimed.projectId,
        status: 'PROCESSING',
      },
    });
    if (updated.count !== 1) throw new WhatsAppOutboundLeaseConflictError();
  }

  private async queueCrmEligibilitySync(
    transaction: Prisma.TransactionClient,
    projectId: string,
    contactId: string,
    connectionId: string,
    messageId: string,
    errorCode: string,
  ): Promise<void> {
    const crm = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId },
    });
    if (!crm?.enabled || crm.status !== 'ACTIVE') return;
    const idempotencyKey = `crm-whatsapp-eligibility-${messageId}-${errorCode}`;
    await transaction.outboxRecord.createMany({
      data: [{ idempotencyKey, kind: 'CRM', payload: {}, projectId }],
      skipDuplicates: true,
    });
    const outbox = await transaction.outboxRecord.findUnique({
      include: { crmOperation: { select: { id: true } } },
      where: { projectId_idempotencyKey: { idempotencyKey, projectId } },
    });
    if (!outbox || outbox.crmOperation) return;
    const operation = await transaction.crmOperation.create({
      data: {
        contactId,
        inputSafe: { connectionId, errorCode, source: 'whatsapp_recipient_failure' },
        outboxRecordId: outbox.id,
        projectId,
        type: 'CREATE_OR_UPDATE_LEAD',
      },
    });
    await transaction.outboxRecord.update({
      data: { payload: { crmOperationId: operation.id } },
      where: { projectId_id: { id: outbox.id, projectId } },
    });
  }

  private async unknown(
    claimed: ClaimedOutboxRecord,
    messageId: string,
    code: string,
    providerMessageId?: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const updated = await transaction.outboxRecord.updateMany({
        data: {
          completedAt: new Date(),
          lastError: code,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
          status: 'UNKNOWN',
          ...(providerMessageId
            ? {
                payload: {
                  ...(object(claimed.payload) ?? {}),
                  providerMessageId,
                },
              }
            : {}),
        },
        where: {
          id: claimed.id,
          lockedBy: claimed.leaseToken,
          projectId: claimed.projectId,
          status: 'PROCESSING',
        },
      });
      if (updated.count !== 1) throw new WhatsAppOutboundLeaseConflictError();
      await transaction.message.updateMany({
        data: {
          ...(providerMessageId ? { externalMessageId: providerMessageId } : {}),
          status: 'UNKNOWN',
        },
        where: { id: messageId, projectId: claimed.projectId },
      });
      await transaction.broadcastRecipient.updateMany({
        data: { completedAt: new Date(), lastError: code, status: 'UNKNOWN' },
        where: { messageId, projectId: claimed.projectId },
      });
      await transaction.scheduledMessage.updateMany({
        data: { completedAt: new Date(), status: 'UNKNOWN' },
        where: {
          messageId,
          projectId: claimed.projectId,
          status: { in: ['QUEUED', 'PROCESSING'] },
        },
      });
      await this.queueCrmMessageStatus(
        transaction,
        claimed.projectId,
        messageId,
        'UNKNOWN',
        providerMessageId,
        'WHATSAPP_RECONCILIATION_REQUIRED',
      );
      await this.completeBroadcastForMessage(transaction, claimed.projectId, messageId);
    });
  }

  private async deferBroadcastRecipient(claimed: ClaimedOutboxRecord): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const updated = await transaction.outboxRecord.updateMany({
        data: {
          lastError: 'broadcast_paused',
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: new Date(Date.now() + 30_000),
          status: 'RETRY',
        },
        where: {
          id: claimed.id,
          lockedBy: claimed.leaseToken,
          projectId: claimed.projectId,
          status: 'PROCESSING',
        },
      });
      if (updated.count !== 1) throw new WhatsAppOutboundLeaseConflictError();
      await transaction.broadcastRecipient.updateMany({
        data: { lastError: 'broadcast_paused', status: 'QUEUED' },
        where: { outboxRecordId: claimed.id, projectId: claimed.projectId },
      });
    });
  }

  private async cancelBroadcastRecipient(
    claimed: ClaimedOutboxRecord,
    recipientId: string,
    messageId: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const updated = await transaction.outboxRecord.updateMany({
        data: {
          completedAt: new Date(),
          lastError: 'broadcast_cancelled',
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
          status: 'FAILED',
        },
        where: {
          id: claimed.id,
          lockedBy: claimed.leaseToken,
          projectId: claimed.projectId,
          status: 'PROCESSING',
        },
      });
      if (updated.count !== 1) throw new WhatsAppOutboundLeaseConflictError();
      await transaction.message.updateMany({
        data: { failedAt: new Date(), status: 'FAILED' },
        where: { id: messageId, projectId: claimed.projectId, status: 'QUEUED' },
      });
      await transaction.broadcastRecipient.updateMany({
        data: {
          completedAt: new Date(),
          lastError: 'broadcast_cancelled',
          status: 'CANCELLED',
        },
        where: {
          id: recipientId,
          projectId: claimed.projectId,
          status: { in: ['QUEUED', 'PROCESSING'] },
        },
      });
    });
  }

  private async completeBroadcastForMessage(
    transaction: Prisma.TransactionClient,
    projectId: string,
    messageId: string,
  ): Promise<void> {
    const recipient = await transaction.broadcastRecipient.findFirst({
      select: { broadcastId: true },
      where: { messageId, projectId },
    });
    if (recipient)
      await this.completeBroadcastIfTerminal(transaction, projectId, recipient.broadcastId);
  }

  private async completeBroadcastIfTerminal(
    transaction: Prisma.TransactionClient,
    projectId: string,
    broadcastId: string,
  ): Promise<void> {
    const nonTerminal = await transaction.broadcastRecipient.count({
      where: {
        broadcastId,
        projectId,
        status: { in: ['PENDING', 'QUEUED', 'PROCESSING'] },
      },
    });
    if (nonTerminal === 0)
      await transaction.broadcast.updateMany({
        data: { completedAt: new Date(), status: 'COMPLETED' },
        where: { id: broadcastId, projectId, status: 'RUNNING' },
      });
  }
}
