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
import {
  normalizeTelegramUpdate,
  TELEGRAM_INBOUND_JOB_NAME,
  TELEGRAM_INBOUND_QUEUE_NAME,
} from '@omnicus/channel-telegram';
import type {
  TelegramInboundEvent,
  TelegramInboundJob,
  TelegramUpdate,
} from '@omnicus/channel-telegram';
import type { Prisma } from '@omnicus/database';
import type { WorkerEnvironment } from '@omnicus/config/server';
import { Worker, type Job } from 'bullmq';

import { DatabaseService } from '../database/database.service';
import { AutomationRuntimeService } from '../automation/automation-runtime.service';
import { redisConnectionFromUrl } from '../queue/redis-connection';
import {
  classifyTelegramInboundFailure,
  TelegramInboundLeaseConflictError,
  TelegramInboundReactionIdentityMismatchError,
  TelegramInboundReactionTargetPendingError,
  telegramInboundRetryDelayMilliseconds,
} from './telegram-inbound-failure';

export const TELEGRAM_INBOUND_PROCESSOR_CLIENT = Symbol('TELEGRAM_INBOUND_PROCESSOR_CLIENT');

export interface TelegramInboundProcessorClient {
  close(force?: boolean): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  waitUntilReady(): Promise<unknown>;
}

interface ClaimedInboxRecord {
  attempts: number;
  connectionId: string;
  id: string;
  leaseToken: string;
  maxAttempts: number;
  projectId: string;
  rawWebhookEvent: {
    payload: unknown;
    receivedAt: Date;
  };
}

function contactProfile(event: TelegramInboundEvent): {
  displayName: string;
  firstName?: string;
  languageCode?: string;
  lastName?: string;
  username?: string;
} {
  const user = event.user;
  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  return {
    displayName: displayName || user?.username || event.externalUserId || 'Telegram user',
    ...(user?.first_name ? { firstName: user.first_name } : {}),
    ...(user?.language_code ? { languageCode: user.language_code } : {}),
    ...(user?.last_name ? { lastName: user.last_name } : {}),
    ...(user?.username ? { username: user.username } : {}),
  };
}

function messageTypeFor(
  event: TelegramInboundEvent,
):
  | 'ANIMATION'
  | 'AUDIO'
  | 'CALLBACK_QUERY'
  | 'COMMAND'
  | 'CONTACT'
  | 'DOCUMENT'
  | 'PHOTO'
  | 'STICKER'
  | 'TEXT'
  | 'VIDEO'
  | 'VIDEO_NOTE'
  | 'VOICE' {
  switch (event.type) {
    case 'MESSAGE':
      return 'TEXT';
    case 'COMMAND':
    case 'CONTACT_SHARED':
    case 'DOCUMENT':
    case 'PHOTO':
    case 'STICKER':
    case 'CALLBACK_QUERY':
    case 'VIDEO':
    case 'AUDIO':
    case 'VOICE':
    case 'VIDEO_NOTE':
    case 'ANIMATION':
      return event.type === 'CONTACT_SHARED' ? 'CONTACT' : event.type;
    default:
      throw new Error('Telegram event does not have an inbound message representation');
  }
}

@Injectable()
export class TelegramInboundProcessorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(TelegramInboundProcessorService.name);
  private readonly workerId = `telegram-inbound:${process.pid}:${randomUUID()}`;
  private processor: TelegramInboundProcessorClient | undefined;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(AutomationRuntimeService)
    private readonly automation?: AutomationRuntimeService,
    @Optional()
    @Inject(TELEGRAM_INBOUND_PROCESSOR_CLIENT)
    processor?: TelegramInboundProcessorClient,
  ) {
    this.processor = processor;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.processor) {
      this.processor = new Worker(
        TELEGRAM_INBOUND_QUEUE_NAME,
        async (job: Job<TelegramInboundJob, void, string>) => {
          if (job.name !== TELEGRAM_INBOUND_JOB_NAME) {
            throw new Error('Unsupported Telegram inbound job');
          }
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
    }
    this.processor.on('error', () => {
      this.logger.error({ message: 'Telegram inbound BullMQ consumer failed' });
    });
    await this.processor.waitUntilReady();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.processor?.close();
  }

  async process(job: TelegramInboundJob): Promise<void> {
    const claimed = await this.claim(job.inboxRecordId);
    if (!claimed) return;

    try {
      const event = normalizeTelegramUpdate(claimed.rawWebhookEvent.payload as TelegramUpdate);
      await this.persist(claimed, event);
    } catch (error) {
      const failure = classifyTelegramInboundFailure(error);
      await this.markFailure(claimed, failure);
      this.logger.warn({
        errorCode: failure.code,
        inboxRecordId: claimed.id,
        message:
          failure.kind === 'PERMANENT' || claimed.attempts >= claimed.maxAttempts
            ? 'Telegram inbound processing dead-lettered an inbox record'
            : 'Telegram inbound processing scheduled an inbox retry',
        projectId: claimed.projectId,
      });
      throw error;
    }
  }

  private async claim(inboxRecordId: string): Promise<ClaimedInboxRecord | undefined> {
    const existing = await this.database.client.inboxRecord.findUnique({
      include: { rawWebhookEvent: { select: { payload: true, receivedAt: true } } },
      where: { id: inboxRecordId },
    });
    if (!existing || ['COMPLETED', 'FAILED', 'DEAD_LETTER'].includes(existing.status)) {
      return undefined;
    }

    const now = new Date();
    const leaseExpiry = new Date(
      now.getTime() - this.config.get('TELEGRAM_INBOUND_LEASE_MS', { infer: true }),
    );
    const leaseToken = `${this.workerId}:${randomUUID()}`;
    const claimed = await this.database.client.inboxRecord.updateMany({
      data: {
        attempts: { increment: 1 },
        lastError: null,
        lockedAt: now,
        lockedBy: leaseToken,
        status: 'PROCESSING',
      },
      where: {
        id: existing.id,
        projectId: existing.projectId,
        OR: [
          { nextAttemptAt: { lte: now }, status: { in: ['PENDING', 'RETRY'] } },
          { lockedAt: null, status: 'PROCESSING' },
          { lockedAt: { lt: leaseExpiry }, status: 'PROCESSING' },
        ],
      },
    });
    if (claimed.count !== 1) return undefined;

    return {
      attempts: existing.attempts + 1,
      connectionId: existing.connectionId,
      id: existing.id,
      leaseToken,
      maxAttempts: existing.maxAttempts,
      projectId: existing.projectId,
      rawWebhookEvent: existing.rawWebhookEvent,
    };
  }

  private async persist(claimed: ClaimedInboxRecord, event: TelegramInboundEvent): Promise<void> {
    const occurredAt =
      typeof event.content.occurredAt === 'string'
        ? new Date(event.content.occurredAt)
        : claimed.rawWebhookEvent.receivedAt;
    const eventAt = Number.isNaN(occurredAt.getTime())
      ? claimed.rawWebhookEvent.receivedAt
      : occurredAt;
    await this.database.client.$transaction(async (transaction) => {
      const reactionTarget =
        event.type === 'REACTION'
          ? await this.resolveReactionTarget(transaction, claimed, event)
          : undefined;
      const editTarget =
        event.type === 'MESSAGE_EDITED'
          ? await this.resolveEditTarget(transaction, claimed, event)
          : undefined;
      const normalized = await transaction.normalizedEvent.upsert({
        create: {
          connectionId: claimed.connectionId,
          inboxRecordId: claimed.id,
          payload: {
            ...(event.chatId ? { chatId: event.chatId } : {}),
            content: reactionTarget
              ? { ...event.content, messageId: reactionTarget.messageId }
              : editTarget
                ? { ...event.content, messageId: editTarget.messageId }
                : event.content,
            ...(event.externalUserId ? { externalUserId: event.externalUserId } : {}),
            metadata: event.metadata,
          } as Prisma.InputJsonValue,
          projectId: claimed.projectId,
          type: event.type,
        },
        update: {},
        where: {
          projectId_inboxRecordId: { inboxRecordId: claimed.id, projectId: claimed.projectId },
        },
      });

      if (event.type === 'CALLBACK_QUERY' && typeof event.content.id === 'string')
        await transaction.outboxRecord.upsert({
          create: {
            connectionId: claimed.connectionId,
            idempotencyKey: `callback-answer-${normalized.id}`,
            kind: 'TELEGRAM',
            nextAttemptAt: new Date(),
            payload: {
              action: 'ANSWER_CALLBACK',
              callbackQueryId: event.content.id,
            },
            projectId: claimed.projectId,
          },
          update: {},
          where: {
            projectId_idempotencyKey: {
              idempotencyKey: `callback-answer-${normalized.id}`,
              projectId: claimed.projectId,
            },
          },
        });

      if (reactionTarget)
        await this.queueReactionForCrm(
          transaction,
          claimed,
          normalized.id,
          reactionTarget.contactId,
          reactionTarget.messageId,
        );

      if (editTarget) {
        await transaction.message.updateMany({
          data: {
            content: {
              ...editTarget.content,
              ...(typeof event.content.text === 'string' ? { text: event.content.text } : {}),
              ...(typeof event.content.caption === 'string'
                ? { caption: event.content.caption }
                : {}),
            } as Prisma.InputJsonValue,
            metadata: {
              ...editTarget.metadata,
              ...(Array.isArray(event.content.entities)
                ? { entities: event.content.entities }
                : {}),
              editedAt: event.content.occurredAt,
            } as Prisma.InputJsonValue,
          },
          where: { id: editTarget.messageId, projectId: claimed.projectId },
        });
        await this.queueNormalizedEventForCrm(
          transaction,
          claimed,
          normalized.id,
          editTarget.contactId,
          'FORWARD_MESSAGE_EDIT',
          `crm-message-edit-${normalized.id}`,
          { targetMessageId: editTarget.messageId },
        );
      }

      const contact =
        !['REACTION', 'MESSAGE_EDITED'].includes(event.type) && event.externalUserId
          ? await this.resolveContact(transaction, claimed, event, eventAt)
          : undefined;

      let conversationId: string | undefined;
      if (
        contact &&
        event.chatId &&
        [
          'MESSAGE',
          'COMMAND',
          'PHOTO',
          'DOCUMENT',
          'VIDEO',
          'AUDIO',
          'VOICE',
          'VIDEO_NOTE',
          'ANIMATION',
          'STICKER',
          'CALLBACK_QUERY',
          'CONTACT_SHARED',
        ].includes(event.type)
      ) {
        const conversation = await transaction.conversation.upsert({
          create: {
            connectionId: claimed.connectionId,
            contactId: contact.id,
            externalChatId: event.chatId,
            projectId: claimed.projectId,
          },
          update: {
            lastMessageAt: eventAt,
          },
          where: {
            projectId_connectionId_externalChatId: {
              connectionId: claimed.connectionId,
              externalChatId: event.chatId,
              projectId: claimed.projectId,
            },
          },
        });
        conversationId = conversation.id;
        const replyToMessageId = await this.resolveReplyTarget(
          transaction,
          claimed,
          event,
          contact.id,
        );
        const message = await transaction.message.upsert({
          create: {
            connectionId: claimed.connectionId,
            contactId: contact.id,
            content: event.content as Prisma.InputJsonValue,
            conversationId: conversation.id,
            direction: 'INBOUND',
            externalMessageId: event.externalMessageId ?? `event:${claimed.id}`,
            metadata: {
              ...event.metadata,
              ...(replyToMessageId ? { replyToMessageId } : {}),
            } as Prisma.InputJsonValue,
            normalizedEventId: normalized.id,
            projectId: claimed.projectId,
            status: 'RECEIVED',
            type: messageTypeFor(event),
          },
          update: {},
          where: {
            projectId_normalizedEventId: {
              normalizedEventId: normalized.id,
              projectId: claimed.projectId,
            },
          },
        });
        if (event.type === 'CONTACT_SHARED')
          await this.queueNormalizedEventForCrm(
            transaction,
            claimed,
            normalized.id,
            contact.id,
            'FORWARD_CONTACT_SHARE',
            `crm-contact-share-${normalized.id}`,
            { messageId: message.id },
          );
        if (
          [
            'PHOTO',
            'DOCUMENT',
            'VIDEO',
            'AUDIO',
            'VOICE',
            'VIDEO_NOTE',
            'ANIMATION',
            'STICKER',
          ].includes(event.type)
        ) {
          const providerMediaId =
            typeof event.content.fileId === 'string' ? event.content.fileId : undefined;
          if (providerMediaId) {
            const mediaAsset = await transaction.mediaAsset.upsert({
              create: {
                connectionId: claimed.connectionId,
                declaredMimeType:
                  typeof event.content.mimeType === 'string' ? event.content.mimeType : null,
                kind: event.type as
                  | 'ANIMATION'
                  | 'AUDIO'
                  | 'DOCUMENT'
                  | 'PHOTO'
                  | 'STICKER'
                  | 'VIDEO'
                  | 'VIDEO_NOTE'
                  | 'VOICE',
                originalFilename:
                  typeof event.content.fileName === 'string' ? event.content.fileName : null,
                projectId: claimed.projectId,
                providerMediaId,
                providerMediaUniqueId:
                  typeof event.content.fileUniqueId === 'string'
                    ? event.content.fileUniqueId
                    : null,
                providerMetadata: event.content as Prisma.InputJsonValue,
                sizeBytes:
                  typeof event.content.fileSize === 'number'
                    ? BigInt(event.content.fileSize)
                    : null,
                source: 'TELEGRAM',
                status: 'PROVIDER_REFERENCE',
              },
              update: {
                providerMetadata: event.content as Prisma.InputJsonValue,
              },
              where: {
                projectId_connectionId_providerMediaId: {
                  connectionId: claimed.connectionId,
                  projectId: claimed.projectId,
                  providerMediaId,
                },
              },
            });
            await transaction.message.update({
              data: { mediaAssetId: mediaAsset.id },
              where: { projectId_id: { id: message.id, projectId: claimed.projectId } },
            });
          }
        }
        if (event.type !== 'CONTACT_SHARED')
          await this.queueInboundMessageForCrm(
            transaction,
            claimed,
            normalized.id,
            contact,
            message.id,
          );
      }

      if (contact && conversationId) {
        const triggerInput = {
          connectionId: claimed.connectionId,
          contactId: contact.id,
          conversationId,
          normalizedEventId: normalized.id,
          projectId: claimed.projectId,
        };
        const consumed =
          (await this.automation?.resolveWaitsInTransaction(transaction, triggerInput)) ?? false;
        if (!consumed) await this.automation?.triggerInTransaction(transaction, triggerInput);
      }

      const completed = await transaction.inboxRecord.updateMany({
        data: {
          completedAt: new Date(),
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          status: 'COMPLETED',
        },
        where: {
          id: claimed.id,
          lockedBy: claimed.leaseToken,
          projectId: claimed.projectId,
          status: 'PROCESSING',
        },
      });
      if (completed.count !== 1) throw new TelegramInboundLeaseConflictError();
    });
  }

  private async resolveEditTarget(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    event: TelegramInboundEvent,
  ): Promise<{
    contactId: string;
    content: Record<string, unknown>;
    messageId: string;
    metadata: Record<string, unknown>;
  }> {
    const targetExternalMessageId = event.content.targetExternalMessageId;
    if (typeof targetExternalMessageId !== 'string' || !event.externalUserId || !event.chatId)
      throw new TelegramInboundReactionIdentityMismatchError();
    const target = await transaction.message.findFirst({
      select: { contactId: true, content: true, id: true, metadata: true },
      where: {
        connectionId: claimed.connectionId,
        conversation: { externalChatId: event.chatId },
        externalMessageId: targetExternalMessageId,
        projectId: claimed.projectId,
      },
    });
    if (!target) throw new TelegramInboundReactionTargetPendingError();
    const identity = await transaction.channelIdentity.findUnique({
      select: { contactId: true },
      where: {
        projectId_connectionId_externalUserId: {
          connectionId: claimed.connectionId,
          externalUserId: event.externalUserId,
          projectId: claimed.projectId,
        },
      },
    });
    if (!identity || identity.contactId !== target.contactId)
      throw new TelegramInboundReactionIdentityMismatchError();
    const record = (value: Prisma.JsonValue | null) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return {
      contactId: target.contactId,
      content: record(target.content),
      messageId: target.id,
      metadata: record(target.metadata),
    };
  }

  private async resolveReplyTarget(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    event: TelegramInboundEvent,
    contactId: string,
  ): Promise<string | undefined> {
    const targetExternalMessageId = event.metadata.replyToExternalMessageId;
    if (typeof targetExternalMessageId !== 'string' || !event.chatId || !targetExternalMessageId)
      return undefined;
    const target = await transaction.message.findFirst({
      select: { contactId: true, id: true },
      where: {
        connectionId: claimed.connectionId,
        conversation: { externalChatId: event.chatId },
        externalMessageId: targetExternalMessageId,
        projectId: claimed.projectId,
      },
    });
    return target?.contactId === contactId ? target.id : undefined;
  }

  private async queueInboundMessageForCrm(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    normalizedEventId: string,
    contact: { crmLeadId?: string | null; id: string },
    messageId: string,
  ): Promise<void> {
    if (!this.config.get('CRM_INTEGRATION_ENABLED', { infer: true })) return;
    const crmConfig = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId: claimed.projectId },
    });
    if (!crmConfig?.enabled || crmConfig.status !== 'ACTIVE') return;

    const forwardInbound = Boolean(contact.crmLeadId);
    const idempotencyKey = forwardInbound
      ? `crm-history-${messageId}`
      : `crm-contact-bootstrap-${contact.id}`;
    await transaction.outboxRecord.createMany({
      data: [{ idempotencyKey, kind: 'CRM', payload: {}, projectId: claimed.projectId }],
      skipDuplicates: true,
    });
    const outbox = await transaction.outboxRecord.findUnique({
      include: { crmOperation: { select: { id: true } } },
      where: {
        projectId_idempotencyKey: { idempotencyKey, projectId: claimed.projectId },
      },
    });
    if (!outbox || outbox.crmOperation) return;
    const operation = await transaction.crmOperation.create({
      data: {
        contactId: contact.id,
        inputSafe: {
          source: forwardInbound ? 'telegram_inbound' : 'telegram_contact_bootstrap',
        },
        normalizedEventId,
        outboxRecordId: outbox.id,
        projectId: claimed.projectId,
        ...(forwardInbound ? { messageId } : {}),
        type: forwardInbound ? 'FORWARD_INBOUND_MESSAGE' : 'CREATE_OR_UPDATE_LEAD',
      },
    });
    await transaction.outboxRecord.update({
      data: { payload: { crmOperationId: operation.id } },
      where: { projectId_id: { id: outbox.id, projectId: claimed.projectId } },
    });
  }

  private async queueNormalizedEventForCrm(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    normalizedEventId: string,
    contactId: string,
    type: 'FORWARD_CONTACT_SHARE' | 'FORWARD_MESSAGE_EDIT',
    idempotencyKey: string,
    inputSafe: Prisma.InputJsonObject,
  ): Promise<void> {
    const crmConfig = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId: claimed.projectId },
    });
    if (!crmConfig?.enabled || crmConfig.status !== 'ACTIVE') return;
    await transaction.outboxRecord.createMany({
      data: [{ idempotencyKey, kind: 'CRM', payload: {}, projectId: claimed.projectId }],
      skipDuplicates: true,
    });
    const outbox = await transaction.outboxRecord.findUnique({
      include: { crmOperation: { select: { id: true } } },
      where: {
        projectId_idempotencyKey: { idempotencyKey, projectId: claimed.projectId },
      },
    });
    if (!outbox || outbox.crmOperation) return;
    const operation = await transaction.crmOperation.create({
      data: {
        contactId,
        inputSafe,
        normalizedEventId,
        outboxRecordId: outbox.id,
        projectId: claimed.projectId,
        type,
      },
    });
    await transaction.outboxRecord.update({
      data: { payload: { crmOperationId: operation.id } },
      where: { projectId_id: { id: outbox.id, projectId: claimed.projectId } },
    });
  }

  private async resolveReactionTarget(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    event: TelegramInboundEvent,
  ): Promise<{ contactId: string; messageId: string }> {
    const targetExternalMessageId = event.content.targetExternalMessageId;
    if (typeof targetExternalMessageId !== 'string' || !event.externalUserId || !event.chatId)
      throw new TelegramInboundReactionIdentityMismatchError();
    const target = await transaction.message.findFirst({
      select: { contactId: true, id: true },
      where: {
        connectionId: claimed.connectionId,
        conversation: { externalChatId: event.chatId },
        externalMessageId: targetExternalMessageId,
        projectId: claimed.projectId,
      },
    });
    if (!target) throw new TelegramInboundReactionTargetPendingError();
    const actorIdentity = await transaction.channelIdentity.findUnique({
      select: { contactId: true },
      where: {
        projectId_connectionId_externalUserId: {
          connectionId: claimed.connectionId,
          externalUserId: event.externalUserId,
          projectId: claimed.projectId,
        },
      },
    });
    if (!actorIdentity || actorIdentity.contactId !== target.contactId)
      throw new TelegramInboundReactionIdentityMismatchError();
    return { contactId: target.contactId, messageId: target.id };
  }

  private async queueReactionForCrm(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    normalizedEventId: string,
    contactId: string,
    messageId: string,
  ): Promise<void> {
    const crmConfig = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId: claimed.projectId },
    });
    if (!crmConfig?.enabled || crmConfig.status !== 'ACTIVE') return;
    const idempotencyKey = `crm-reaction-${normalizedEventId}`;
    await transaction.outboxRecord.createMany({
      data: [
        {
          idempotencyKey,
          kind: 'CRM',
          payload: {},
          projectId: claimed.projectId,
        },
      ],
      skipDuplicates: true,
    });
    const outbox = await transaction.outboxRecord.findUnique({
      include: { crmOperation: { select: { id: true } } },
      where: {
        projectId_idempotencyKey: { idempotencyKey, projectId: claimed.projectId },
      },
    });
    if (!outbox || outbox.crmOperation) return;
    const operation = await transaction.crmOperation.create({
      data: {
        contactId,
        inputSafe: { source: 'telegram_reaction', targetMessageId: messageId },
        normalizedEventId,
        outboxRecordId: outbox.id,
        projectId: claimed.projectId,
        type: 'FORWARD_REACTION_EVENT',
      },
    });
    await transaction.outboxRecord.update({
      data: { payload: { crmOperationId: operation.id } },
      where: { projectId_id: { id: outbox.id, projectId: claimed.projectId } },
    });
  }

  private async resolveContact(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    event: TelegramInboundEvent,
    eventAt: Date,
  ): Promise<{ crmLeadId?: string | null; id: string }> {
    const externalUserId = event.externalUserId;
    if (!externalUserId) throw new Error('Telegram identity subject is missing');
    const profile = contactProfile(event);
    const identity = await transaction.channelIdentity.findUnique({
      select: { contact: { select: { crmLeadId: true } }, contactId: true },
      where: {
        projectId_connectionId_externalUserId: {
          connectionId: claimed.connectionId,
          externalUserId,
          projectId: claimed.projectId,
        },
      },
    });

    if (!identity) {
      const contact = await transaction.contact.create({
        data: {
          displayName: profile.displayName,
          firstInteractionAt: eventAt,
          ...(profile.firstName ? { firstName: profile.firstName } : {}),
          ...(profile.lastName ? { lastName: profile.lastName } : {}),
          lastInteractionAt: eventAt,
          ...(profile.username ? { username: profile.username } : {}),
          projectId: claimed.projectId,
        },
        select: { crmLeadId: true, id: true },
      });
      await transaction.channelIdentity.create({
        data: {
          channel: 'TELEGRAM',
          connectionId: claimed.connectionId,
          contactId: contact.id,
          displayName: profile.displayName,
          externalUserId,
          ...(profile.languageCode ? { languageCode: profile.languageCode } : {}),
          metadata: { source: 'telegram_inbound' },
          projectId: claimed.projectId,
          status: event.identityStatus ?? 'ACTIVE',
          ...(profile.username ? { username: profile.username } : {}),
        },
      });
      return contact;
    }

    await transaction.contact.update({
      data: {
        displayName: profile.displayName,
        ...(profile.firstName ? { firstName: profile.firstName } : {}),
        ...(profile.lastName ? { lastName: profile.lastName } : {}),
        ...(profile.username ? { username: profile.username } : {}),
      },
      where: { projectId_id: { id: identity.contactId, projectId: claimed.projectId } },
    });
    await transaction.contact.updateMany({
      data: { lastInteractionAt: eventAt },
      where: {
        id: identity.contactId,
        projectId: claimed.projectId,
        OR: [{ lastInteractionAt: null }, { lastInteractionAt: { lt: eventAt } }],
      },
    });
    await transaction.channelIdentity.update({
      data: {
        displayName: profile.displayName,
        ...(profile.languageCode ? { languageCode: profile.languageCode } : {}),
        status: event.identityStatus ?? 'ACTIVE',
        ...(profile.username ? { username: profile.username } : {}),
      },
      where: {
        projectId_connectionId_externalUserId: {
          connectionId: claimed.connectionId,
          externalUserId,
          projectId: claimed.projectId,
        },
      },
    });
    return { crmLeadId: identity.contact.crmLeadId, id: identity.contactId };
  }

  private async markFailure(
    claimed: ClaimedInboxRecord,
    failure: ReturnType<typeof classifyTelegramInboundFailure>,
  ): Promise<void> {
    const shouldDeadLetter =
      failure.kind === 'PERMANENT' || claimed.attempts >= claimed.maxAttempts;
    await this.database.client.inboxRecord.updateMany({
      data: {
        lastError: failure.code,
        lockedAt: null,
        lockedBy: null,
        ...(shouldDeadLetter
          ? { nextAttemptAt: null, status: 'DEAD_LETTER' as const }
          : {
              nextAttemptAt: new Date(
                Date.now() + telegramInboundRetryDelayMilliseconds(claimed.attempts),
              ),
              status: 'RETRY' as const,
            }),
      },
      where: {
        id: claimed.id,
        lockedBy: claimed.leaseToken,
        projectId: claimed.projectId,
        status: 'PROCESSING',
      },
    });
  }
}
