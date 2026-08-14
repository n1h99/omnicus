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
  assertWhatsAppReactionEmoji,
  normalizeWhatsAppWebhookItem,
  WHATSAPP_INBOUND_JOB_NAME,
  WHATSAPP_INBOUND_QUEUE_NAME,
  type WhatsAppInboundJob,
} from '@omnicus/channel-whatsapp';
import type { WorkerEnvironment } from '@omnicus/config/server';
import type { Prisma } from '@omnicus/database';
import { Worker, type Job } from 'bullmq';

import { AutomationRuntimeService } from '../automation/automation-runtime.service';
import { DatabaseService } from '../database/database.service';
import { redisConnectionFromUrl } from '../queue/redis-connection';

export const WHATSAPP_INBOUND_PROCESSOR_CLIENT = Symbol('WHATSAPP_INBOUND_PROCESSOR_CLIENT');

export interface WhatsAppInboundProcessorClient {
  close(force?: boolean): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  waitUntilReady(): Promise<unknown>;
}

interface ClaimedInboxRecord {
  attempts: number;
  connectionId: string;
  externalUpdateId: string;
  id: string;
  leaseToken: string;
  maxAttempts: number;
  projectId: string;
  rawWebhookEvent: { payload: unknown; receivedAt: Date };
}

type JsonObject = Record<string, unknown>;

class WhatsAppInboundPermanentError extends Error {}
class WhatsAppInboundPendingError extends Error {}
class WhatsAppInboundLeaseConflictError extends Error {}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  const result = string(value);
  if (result && result.length > maximumLength)
    throw new WhatsAppInboundPermanentError('whatsapp_field_too_long');
  return result;
}

export function isWhatsAppAutomationEligibleMessageType(type: string): boolean {
  return type !== 'UNSUPPORTED';
}

function occurredAt(value: unknown, receivedAt: Date): Date {
  const seconds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  const date = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1_000) : undefined;
  const earliest = receivedAt.getTime() - 30 * 24 * 60 * 60 * 1_000;
  const latest = receivedAt.getTime() + 5 * 60 * 1_000;
  if (!date || Number.isNaN(date.getTime()) || date.getTime() < earliest || date.getTime() > latest)
    throw new WhatsAppInboundPermanentError('whatsapp_timestamp_invalid');
  return date;
}

function messageProjectionStatus(
  current: string,
  incoming: 'DELETED' | 'DELIVERED' | 'FAILED' | 'READ' | 'SENT',
): 'DELETED' | 'DELIVERED' | 'FAILED' | 'READ' | 'SENT' | undefined {
  if (current === 'DELETED') return undefined;
  if (incoming === 'DELETED') return 'DELETED';
  if (incoming === 'FAILED')
    return ['QUEUED', 'PROCESSING', 'UNKNOWN', 'SENT'].includes(current) ? 'FAILED' : undefined;
  const rank: Record<string, number> = {
    FAILED: 0,
    UNKNOWN: 0,
    QUEUED: 0,
    PROCESSING: 0,
    SENT: 1,
    DELIVERED: 2,
    READ: 3,
  };
  const incomingRank = rank[incoming] ?? 0;
  const currentRank = rank[current] ?? 0;
  return incomingRank > currentRank ? incoming : undefined;
}

@Injectable()
export class WhatsAppInboundProcessorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WhatsAppInboundProcessorService.name);
  private readonly workerId = `whatsapp-inbound:${process.pid}:${randomUUID()}`;
  private processor: WhatsAppInboundProcessorClient | undefined;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(AutomationRuntimeService)
    private readonly automation?: AutomationRuntimeService,
    @Optional()
    @Inject(WHATSAPP_INBOUND_PROCESSOR_CLIENT)
    processor?: WhatsAppInboundProcessorClient,
  ) {
    this.processor = processor;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.processor)
      this.processor = new Worker(
        WHATSAPP_INBOUND_QUEUE_NAME,
        async (job: Job<WhatsAppInboundJob>) => {
          if (job.name !== WHATSAPP_INBOUND_JOB_NAME)
            throw new Error('Unsupported WhatsApp inbound job');
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
      this.logger.error({ message: 'WhatsApp inbound BullMQ consumer failed' }),
    );
    await this.processor.waitUntilReady();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.processor?.close();
  }

  async process(job: WhatsAppInboundJob): Promise<void> {
    const claimed = await this.claim(job.inboxRecordId);
    if (!claimed) return;
    try {
      const event = normalizeWhatsAppWebhookItem(claimed.rawWebhookEvent.payload);
      if (event.kind === 'status') await this.persistStatus(claimed, event.status);
      else await this.persistMessage(claimed, event.message, event.senderId, event.profileName);
    } catch (error) {
      if (error instanceof WhatsAppInboundLeaseConflictError) throw error;
      const permanent =
        error instanceof WhatsAppInboundPermanentError ||
        (error instanceof Error &&
          error.message.startsWith('whatsapp_') &&
          !(error instanceof WhatsAppInboundPendingError));
      await this.fail(claimed, permanent, error);
      throw error;
    }
  }

  private async claim(inboxRecordId: string): Promise<ClaimedInboxRecord | undefined> {
    const existing = await this.database.client.inboxRecord.findUnique({
      include: {
        rawWebhookEvent: {
          select: { externalUpdateId: true, payload: true, receivedAt: true },
        },
      },
      where: { id: inboxRecordId },
    });
    if (!existing || ['COMPLETED', 'FAILED', 'DEAD_LETTER'].includes(existing.status)) return;
    const now = new Date();
    const leaseExpiry = new Date(
      now.getTime() - this.config.get('WHATSAPP_INBOUND_LEASE_MS', { infer: true }),
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
    if (claimed.count !== 1) return;
    return {
      attempts: existing.attempts + 1,
      connectionId: existing.connectionId,
      externalUpdateId: existing.rawWebhookEvent.externalUpdateId,
      id: existing.id,
      leaseToken,
      maxAttempts: existing.maxAttempts,
      projectId: existing.projectId,
      rawWebhookEvent: existing.rawWebhookEvent,
    };
  }

  private async persistMessage(
    claimed: ClaimedInboxRecord,
    providerMessage: JsonObject,
    senderId: string,
    profileName?: string,
  ): Promise<void> {
    const eventAt = occurredAt(providerMessage.timestamp, claimed.rawWebhookEvent.receivedAt);
    const providerMessageId = boundedString(providerMessage.id, 512);
    const providerType = boundedString(providerMessage.type, 64);
    const safeSenderId = boundedString(senderId, 128);
    const safeProfileName = boundedString(profileName, 256);
    if (!providerMessageId || !providerType || !safeSenderId)
      throw new WhatsAppInboundPermanentError();
    await this.database.client.$transaction(async (transaction) => {
      await this.assertConnection(transaction, claimed);
      const normalizedMessage = this.normalizeMessage(providerMessage, providerType, eventAt);
      const normalized = await transaction.normalizedEvent.create({
        data: {
          connectionId: claimed.connectionId,
          inboxRecordId: claimed.id,
          payload: normalizedMessage.normalizedPayload,
          projectId: claimed.projectId,
          type: normalizedMessage.normalizedType,
        },
      });

      if (providerType === 'reaction') {
        await this.persistReaction(
          transaction,
          claimed,
          normalized.id,
          providerMessage,
          safeSenderId,
          eventAt,
        );
        await this.complete(transaction, claimed);
        return;
      }

      const contact = await this.resolveContact(
        transaction,
        claimed,
        safeSenderId,
        safeProfileName,
        eventAt,
      );
      const serviceWindowExpiresAt = new Date(eventAt.getTime() + 24 * 60 * 60 * 1_000);
      const conversation = await transaction.conversation.upsert({
        create: {
          connectionId: claimed.connectionId,
          contactId: contact.id,
          externalChatId: safeSenderId,
          lastInboundAt: eventAt,
          lastMessageAt: eventAt,
          projectId: claimed.projectId,
          serviceWindowExpiresAt,
        },
        update: {},
        where: {
          projectId_connectionId_externalChatId: {
            connectionId: claimed.connectionId,
            externalChatId: safeSenderId,
            projectId: claimed.projectId,
          },
        },
      });
      await transaction.conversation.updateMany({
        data: { lastInboundAt: eventAt, serviceWindowExpiresAt },
        where: {
          id: conversation.id,
          projectId: claimed.projectId,
          OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: eventAt } }],
        },
      });
      await transaction.conversation.updateMany({
        data: { lastMessageAt: eventAt },
        where: {
          id: conversation.id,
          projectId: claimed.projectId,
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: eventAt } }],
        },
      });
      const replyToMessageId = await this.replyTarget(
        transaction,
        claimed,
        contact.id,
        object(providerMessage.context),
      );
      const media = normalizedMessage.media
        ? await transaction.mediaAsset.upsert({
            create: {
              connectionId: claimed.connectionId,
              declaredMimeType: normalizedMessage.media.mimeType ?? null,
              kind: normalizedMessage.media.kind,
              originalFilename: normalizedMessage.media.filename ?? null,
              projectId: claimed.projectId,
              providerMediaId: normalizedMessage.media.id,
              providerMediaUniqueId: normalizedMessage.media.sha256 ?? null,
              providerMetadata: {
                ...(normalizedMessage.media.sha256
                  ? { sha256: normalizedMessage.media.sha256 }
                  : {}),
                ...(normalizedMessage.media.voice !== undefined
                  ? { voice: normalizedMessage.media.voice }
                  : {}),
              },
              source: 'WHATSAPP',
              status: 'PROVIDER_REFERENCE',
            },
            update: {},
            where: {
              projectId_connectionId_providerMediaId: {
                connectionId: claimed.connectionId,
                projectId: claimed.projectId,
                providerMediaId: normalizedMessage.media.id,
              },
            },
          })
        : undefined;
      const message = await transaction.message.create({
        data: {
          connectionId: claimed.connectionId,
          contactId: contact.id,
          content: normalizedMessage.content,
          conversationId: conversation.id,
          direction: 'INBOUND',
          externalMessageId: providerMessageId,
          ...(media ? { mediaAssetId: media.id } : {}),
          metadata: {
            channel: 'whatsapp',
            ...(replyToMessageId ? { replyToMessageId } : {}),
          },
          normalizedEventId: normalized.id,
          projectId: claimed.projectId,
          status: 'RECEIVED',
          type: normalizedMessage.messageType,
        },
      });
      await this.queueInboundForCrm(transaction, claimed, normalized.id, contact, message.id);
      if (isWhatsAppAutomationEligibleMessageType(normalizedMessage.messageType)) {
        await this.automation?.resolveWaitsInTransaction(transaction, {
          connectionId: claimed.connectionId,
          contactId: contact.id,
          conversationId: conversation.id,
          normalizedEventId: normalized.id,
          projectId: claimed.projectId,
        });
        await this.automation?.triggerInTransaction(transaction, {
          connectionId: claimed.connectionId,
          contactId: contact.id,
          conversationId: conversation.id,
          normalizedEventId: normalized.id,
          projectId: claimed.projectId,
        });
      }
      void message;
      await this.complete(transaction, claimed);
    });
  }

  private async persistStatus(claimed: ClaimedInboxRecord, status: JsonObject): Promise<void> {
    const providerMessageId = boundedString(status.id, 512);
    const providerStatus = boundedString(status.status, 32)?.toLowerCase();
    if (!providerMessageId || !providerStatus) throw new WhatsAppInboundPermanentError();
    const mapped = {
      deleted: 'DELETED',
      delivered: 'DELIVERED',
      failed: 'FAILED',
      read: 'READ',
      sent: 'SENT',
    }[providerStatus] as 'DELETED' | 'DELIVERED' | 'FAILED' | 'READ' | 'SENT' | undefined;
    if (!mapped) throw new WhatsAppInboundPermanentError();
    const eventAt = occurredAt(status.timestamp, claimed.rawWebhookEvent.receivedAt);
    await this.database.client.$transaction(async (transaction) => {
      await this.assertConnection(transaction, claimed);
      const target = await transaction.message.findFirst({
        select: {
          contactId: true,
          content: true,
          conversation: { select: { externalChatId: true } },
          id: true,
          metadata: true,
          status: true,
        },
        where: {
          connectionId: claimed.connectionId,
          direction: 'OUTBOUND',
          externalMessageId: providerMessageId,
          projectId: claimed.projectId,
        },
      });
      if (!target) throw new WhatsAppInboundPendingError('whatsapp_status_source_pending');
      const errorCode = this.statusErrorCode(status);
      const normalized = await transaction.normalizedEvent.create({
        data: {
          connectionId: claimed.connectionId,
          inboxRecordId: claimed.id,
          payload: {
            ...(errorCode ? { errorCode } : {}),
            messageId: target.id,
            occurredAt: eventAt.toISOString(),
            providerMessageId,
            status: mapped,
          },
          projectId: claimed.projectId,
          type: 'MESSAGE_STATUS',
        },
      });
      await transaction.messageStatusEvent.create({
        data: {
          connectionId: claimed.connectionId,
          ...(errorCode ? { errorCode } : {}),
          messageId: target.id,
          normalizedEventId: normalized.id,
          occurredAt: eventAt,
          projectId: claimed.projectId,
          providerEventId: claimed.externalUpdateId,
          providerMessageId,
          status: mapped,
        },
      });
      await this.queueCrmOperation(
        transaction,
        claimed,
        `crm-local-message-status-${target.id}-${mapped}`,
        'FORWARD_MESSAGE_STATUS',
        {
          ...(errorCode ? { errorCode } : {}),
          messageId: target.id,
          occurredAt: eventAt.toISOString(),
          providerMessageId,
          status: mapped,
        },
        target.contactId,
        normalized.id,
      );
      const projection = messageProjectionStatus(target.status, mapped);
      if (projection)
        await transaction.message.update({
          data: {
            ...(projection === 'DELETED'
              ? {
                  content: { deleted: true },
                  metadata: {
                    ...(object(target.metadata) ?? {}),
                    channel: 'whatsapp',
                    deletedAt: eventAt.toISOString(),
                  },
                }
              : {}),
            ...(projection === 'FAILED' ? { failedAt: eventAt } : {}),
            ...(projection === 'SENT' ? { sentAt: eventAt } : {}),
            status: projection,
          },
          where: { projectId_id: { id: target.id, projectId: claimed.projectId } },
        });
      const recipientStatus = projection === 'DELETED' ? undefined : projection;
      if (recipientStatus)
        await transaction.broadcastRecipient.updateMany({
          data: {
            ...(recipientStatus === 'FAILED' ? { lastError: errorCode ?? 'WHATSAPP_FAILED' } : {}),
            status: recipientStatus,
          },
          where: { messageId: target.id, projectId: claimed.projectId },
        });
      const reachesRecipient = mapped === 'DELIVERED' || mapped === 'READ';
      const isUndeliverable = mapped === 'FAILED' && errorCode === '131026';
      await transaction.channelIdentity.updateMany({
        data: {
          ...(reachesRecipient
            ? {
                whatsAppLastErrorCode: null,
                whatsAppReachability: 'AVAILABLE' as const,
              }
            : isUndeliverable
              ? { whatsAppLastErrorCode: errorCode, whatsAppReachability: 'UNAVAILABLE' as const }
              : errorCode
                ? { whatsAppLastErrorCode: errorCode }
                : {}),
          whatsAppReachabilityCheckedAt: eventAt,
        },
        where: {
          channel: 'WHATSAPP',
          connectionId: claimed.connectionId,
          contactId: target.contactId,
          externalUserId: target.conversation.externalChatId,
          projectId: claimed.projectId,
        },
      });
      await this.queueCrmOperation(
        transaction,
        claimed,
        `crm-whatsapp-eligibility-${normalized.id}`,
        'CREATE_OR_UPDATE_LEAD',
        { connectionId: claimed.connectionId, source: 'whatsapp_delivery_status' },
        target.contactId,
        normalized.id,
      );
      await this.complete(transaction, claimed);
    });
  }

  private normalizeMessage(
    providerMessage: JsonObject,
    providerType: string,
    eventAt: Date,
  ): {
    content: Prisma.InputJsonValue;
    media?: {
      filename?: string;
      id: string;
      kind: 'AUDIO' | 'DOCUMENT' | 'PHOTO' | 'STICKER' | 'VIDEO' | 'VOICE';
      mimeType?: string;
      sha256?: string;
      voice?: boolean;
    };
    messageType:
      | 'AUDIO'
      | 'CONTACT'
      | 'DOCUMENT'
      | 'INTERACTIVE'
      | 'LOCATION'
      | 'PHOTO'
      | 'STICKER'
      | 'TEXT'
      | 'UNSUPPORTED'
      | 'VIDEO'
      | 'VOICE';
    normalizedPayload: Prisma.InputJsonValue;
    normalizedType:
      | 'AUDIO'
      | 'CONTACT_SHARED'
      | 'DOCUMENT'
      | 'INTERACTIVE'
      | 'MESSAGE'
      | 'PHOTO'
      | 'REACTION'
      | 'STICKER'
      | 'UNSUPPORTED'
      | 'VIDEO'
      | 'VOICE';
  } {
    const base = { occurredAt: eventAt.toISOString() };
    if (providerType === 'text') {
      const text = boundedString(object(providerMessage.text)?.body, 4_096);
      if (!text) throw new WhatsAppInboundPermanentError();
      const content = { ...base, text };
      return {
        content,
        messageType: 'TEXT',
        normalizedPayload: content,
        normalizedType: 'MESSAGE',
      };
    }
    if (['image', 'video', 'audio', 'document', 'sticker'].includes(providerType)) {
      const source = object(providerMessage[providerType]);
      const id = boundedString(source?.id, 512);
      if (!source || !id) throw new WhatsAppInboundPermanentError();
      const voice = providerType === 'audio' && source.voice === true;
      const kind =
        providerType === 'image'
          ? 'PHOTO'
          : providerType === 'audio'
            ? voice
              ? 'VOICE'
              : 'AUDIO'
            : (providerType.toUpperCase() as 'DOCUMENT' | 'STICKER' | 'VIDEO');
      const caption = boundedString(source.caption, 1_024);
      const filename = boundedString(source.filename, 240);
      const mimeType = boundedString(source.mime_type, 128);
      const sha256 = boundedString(source.sha256, 256);
      const content = {
        ...base,
        ...(caption ? { caption } : {}),
        ...(filename ? { fileName: filename } : {}),
        ...(mimeType ? { mimeType } : {}),
      };
      return {
        content,
        media: {
          ...(filename ? { filename } : {}),
          id,
          kind,
          ...(mimeType ? { mimeType } : {}),
          ...(sha256 ? { sha256 } : {}),
          ...(providerType === 'audio' ? { voice } : {}),
        },
        messageType: kind,
        normalizedPayload: content,
        normalizedType: kind,
      };
    }
    if (providerType === 'location') {
      const source = object(providerMessage.location);
      if (
        !source ||
        typeof source.latitude !== 'number' ||
        typeof source.longitude !== 'number' ||
        !Number.isFinite(source.latitude) ||
        !Number.isFinite(source.longitude) ||
        source.latitude < -90 ||
        source.latitude > 90 ||
        source.longitude < -180 ||
        source.longitude > 180
      )
        throw new WhatsAppInboundPermanentError();
      const address = boundedString(source.address, 512);
      const name = boundedString(source.name, 256);
      const content = {
        ...base,
        latitude: source.latitude,
        longitude: source.longitude,
        ...(address ? { address } : {}),
        ...(name ? { name } : {}),
      };
      return {
        content,
        messageType: 'LOCATION',
        normalizedPayload: content,
        normalizedType: 'MESSAGE',
      };
    }
    if (providerType === 'contacts') {
      const contacts = Array.isArray(providerMessage.contacts)
        ? providerMessage.contacts.slice(0, 20).flatMap((value) => {
            const source = object(value);
            const name = object(source?.name);
            const formattedName = boundedString(name?.formatted_name, 256);
            if (!source || !formattedName) return [];
            const firstName = boundedString(name?.first_name, 128);
            const lastName = boundedString(name?.last_name, 128);
            return [
              {
                emails: Array.isArray(source.emails)
                  ? source.emails.slice(0, 20).flatMap((email) => {
                      const row = object(email);
                      const emailValue = boundedString(row?.email, 320);
                      const emailType = boundedString(row?.type, 64);
                      return emailValue
                        ? [{ email: emailValue, ...(emailType ? { type: emailType } : {}) }]
                        : [];
                    })
                  : [],
                name: {
                  formattedName,
                  ...(firstName ? { firstName } : {}),
                  ...(lastName ? { lastName } : {}),
                },
                phones: Array.isArray(source.phones)
                  ? source.phones.slice(0, 20).flatMap((phone) => {
                      const row = object(phone);
                      const number = boundedString(row?.phone, 64);
                      const phoneType = boundedString(row?.type, 64);
                      const waId = boundedString(row?.wa_id, 128);
                      return number
                        ? [
                            {
                              phone: number,
                              ...(phoneType ? { type: phoneType } : {}),
                              ...(waId ? { waId } : {}),
                            },
                          ]
                        : [];
                    })
                  : [],
              },
            ];
          })
        : [];
      if (contacts.length === 0) throw new WhatsAppInboundPermanentError();
      const content = { ...base, contacts };
      return {
        content,
        messageType: 'CONTACT',
        normalizedPayload: content,
        normalizedType: 'CONTACT_SHARED',
      };
    }
    if (providerType === 'interactive') {
      const interactive = object(providerMessage.interactive);
      const type = boundedString(interactive?.type, 32);
      const reply = type ? object(interactive?.[type]) : undefined;
      const id = boundedString(reply?.id, 256);
      const title = boundedString(reply?.title, 256);
      if (!type || !['button_reply', 'list_reply'].includes(type) || !id || !title)
        throw new WhatsAppInboundPermanentError();
      const content = {
        ...base,
        interactive: {
          ...(boundedString(reply?.description, 512)
            ? { description: boundedString(reply?.description, 512) }
            : {}),
          id,
          title,
          type,
        },
      };
      return {
        content,
        messageType: 'INTERACTIVE',
        normalizedPayload: content,
        normalizedType: 'INTERACTIVE',
      };
    }
    if (providerType === 'button') {
      const button = object(providerMessage.button);
      const id = boundedString(button?.payload, 256);
      const title = boundedString(button?.text, 256);
      if (!button || !id || !title) throw new WhatsAppInboundPermanentError();
      const content = {
        ...base,
        interactive: { id, title, type: 'button_reply' },
      };
      return {
        content,
        messageType: 'INTERACTIVE',
        normalizedPayload: content,
        normalizedType: 'INTERACTIVE',
      };
    }
    if (providerType === 'reaction') {
      const source = object(providerMessage.reaction);
      if (!source || !boundedString(source.message_id, 512) || typeof source.emoji !== 'string')
        throw new WhatsAppInboundPermanentError();
      try {
        assertWhatsAppReactionEmoji(source.emoji);
      } catch {
        throw new WhatsAppInboundPermanentError('whatsapp_reaction_emoji_invalid');
      }
      const providerTargetMessageId = boundedString(source.message_id, 512)!;
      const content = {
        ...base,
        emoji: source.emoji,
        providerTargetMessageId,
      };
      return {
        content,
        messageType: 'UNSUPPORTED',
        normalizedPayload: content,
        normalizedType: 'REACTION',
      };
    }
    const content = { ...base, providerType: boundedString(providerType, 64)! };
    return {
      content,
      messageType: 'UNSUPPORTED',
      normalizedPayload: content,
      normalizedType: 'UNSUPPORTED',
    };
  }

  private async persistReaction(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    normalizedEventId: string,
    providerMessage: JsonObject,
    senderId: string,
    eventAt: Date,
  ): Promise<void> {
    const reaction = object(providerMessage.reaction);
    const targetProviderMessageId = boundedString(reaction?.message_id, 512);
    const emoji = typeof reaction?.emoji === 'string' ? reaction.emoji : undefined;
    if (!targetProviderMessageId || emoji === undefined) throw new WhatsAppInboundPermanentError();
    try {
      assertWhatsAppReactionEmoji(emoji);
    } catch {
      throw new WhatsAppInboundPermanentError('whatsapp_reaction_emoji_invalid');
    }
    const target = await transaction.message.findFirst({
      select: { contactId: true, id: true, metadata: true },
      where: {
        connectionId: claimed.connectionId,
        externalMessageId: targetProviderMessageId,
        projectId: claimed.projectId,
      },
    });
    if (!target) throw new WhatsAppInboundPendingError('whatsapp_reaction_source_pending');
    const identity = await transaction.channelIdentity.findUnique({
      where: {
        projectId_connectionId_externalUserId: {
          connectionId: claimed.connectionId,
          externalUserId: senderId,
          projectId: claimed.projectId,
        },
      },
    });
    if (!identity || identity.contactId !== target.contactId)
      throw new WhatsAppInboundPermanentError('whatsapp_reaction_identity_mismatch');
    const metadata = object(target.metadata) ?? {};
    const existingReactions = Array.isArray(metadata.reactions) ? metadata.reactions : [];
    const previous = existingReactions.find((value) => object(value)?.actorExternalId === senderId);
    const reactions = existingReactions.filter(
      (value) => object(value)?.actorExternalId !== senderId,
    );
    if (emoji)
      reactions.push({ actorExternalId: senderId, emoji, occurredAt: eventAt.toISOString() });
    await transaction.message.update({
      data: { metadata: { ...metadata, reactions } },
      where: { projectId_id: { id: target.id, projectId: claimed.projectId } },
    });
    await transaction.normalizedEvent.update({
      data: {
        payload: {
          content: {
            actor: {
              displayName: identity.displayName ?? senderId,
              externalUserId: senderId,
              type: 'user',
            },
            messageId: target.id,
            newReactions: emoji ? [{ emoji, type: 'emoji' }] : [],
            occurredAt: eventAt.toISOString(),
            oldReactions:
              typeof object(previous)?.emoji === 'string'
                ? [{ emoji: object(previous)!.emoji as string, type: 'emoji' }]
                : [],
          },
        },
      },
      where: { projectId_id: { id: normalizedEventId, projectId: claimed.projectId } },
    });
    await this.queueCrmOperation(
      transaction,
      claimed,
      `crm-reaction-${normalizedEventId}`,
      'FORWARD_REACTION_EVENT',
      { source: 'whatsapp_reaction', targetMessageId: target.id },
      target.contactId,
      normalizedEventId,
    );
  }

  private async resolveContact(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    senderId: string,
    profileName: string | undefined,
    eventAt: Date,
  ): Promise<{ crmLeadId: string | null; id: string }> {
    const identity = await transaction.channelIdentity.findUnique({
      include: { contact: { select: { crmLeadId: true, id: true } } },
      where: {
        projectId_connectionId_externalUserId: {
          connectionId: claimed.connectionId,
          externalUserId: senderId,
          projectId: claimed.projectId,
        },
      },
    });
    const displayName = profileName?.trim() || senderId;
    if (identity) {
      await transaction.channelIdentity.update({
        data: {
          displayName,
          status: 'ACTIVE',
          whatsAppLastErrorCode: null,
          whatsAppReachability: 'AVAILABLE',
          whatsAppReachabilityCheckedAt: eventAt,
        },
        where: {
          projectId_connectionId_externalUserId: {
            connectionId: claimed.connectionId,
            externalUserId: senderId,
            projectId: claimed.projectId,
          },
        },
      });
      await transaction.contact.updateMany({
        data: { lastInteractionAt: eventAt, normalizedPhone: senderId, phone: senderId },
        where: {
          id: identity.contactId,
          projectId: claimed.projectId,
          OR: [{ lastInteractionAt: null }, { lastInteractionAt: { lt: eventAt } }],
        },
      });
      return { crmLeadId: identity.contact.crmLeadId, id: identity.contactId };
    }
    const contact = await transaction.contact.create({
      data: {
        displayName,
        firstInteractionAt: eventAt,
        lastInteractionAt: eventAt,
        normalizedPhone: senderId,
        phone: senderId,
        projectId: claimed.projectId,
      },
    });
    await transaction.channelIdentity.create({
      data: {
        channel: 'WHATSAPP',
        connectionId: claimed.connectionId,
        contactId: contact.id,
        displayName,
        externalUserId: senderId,
        metadata: { source: 'whatsapp_inbound' },
        projectId: claimed.projectId,
        whatsAppReachability: 'AVAILABLE',
        whatsAppReachabilityCheckedAt: eventAt,
      },
    });
    return { crmLeadId: contact.crmLeadId, id: contact.id };
  }

  private async replyTarget(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    contactId: string,
    context: JsonObject | undefined,
  ): Promise<string | undefined> {
    const providerMessageId = string(context?.id);
    if (!providerMessageId) return;
    const target = await transaction.message.findFirst({
      select: { id: true },
      where: {
        connectionId: claimed.connectionId,
        contactId,
        externalMessageId: providerMessageId,
        projectId: claimed.projectId,
      },
    });
    return target?.id;
  }

  private async queueInboundForCrm(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    normalizedEventId: string,
    contact: { crmLeadId: string | null; id: string },
    messageId: string,
  ): Promise<void> {
    const forward = Boolean(contact.crmLeadId);
    await this.queueCrmOperation(
      transaction,
      claimed,
      forward ? `crm-history-${messageId}` : `crm-contact-bootstrap-${contact.id}`,
      forward ? 'FORWARD_INBOUND_MESSAGE' : 'CREATE_OR_UPDATE_LEAD',
      { source: forward ? 'whatsapp_inbound' : 'whatsapp_contact_bootstrap' },
      contact.id,
      normalizedEventId,
      forward ? messageId : undefined,
    );
  }

  private async queueCrmOperation(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
    idempotencyKey: string,
    type:
      | 'CREATE_OR_UPDATE_LEAD'
      | 'FORWARD_INBOUND_MESSAGE'
      | 'FORWARD_MESSAGE_STATUS'
      | 'FORWARD_REACTION_EVENT',
    inputSafe: Prisma.InputJsonObject,
    contactId: string,
    normalizedEventId: string,
    messageId?: string,
  ): Promise<void> {
    if (!this.config.get('CRM_INTEGRATION_ENABLED', { infer: true })) return;
    const crm = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId: claimed.projectId },
    });
    if (!crm?.enabled || crm.status !== 'ACTIVE') return;
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
        ...(messageId ? { messageId } : {}),
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

  private async assertConnection(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
  ): Promise<void> {
    const connection = await transaction.channelConnection.findUnique({
      select: { status: true, type: true },
      where: { projectId_id: { id: claimed.connectionId, projectId: claimed.projectId } },
    });
    if (!connection || connection.type !== 'WHATSAPP' || connection.status !== 'ACTIVE')
      throw new WhatsAppInboundPermanentError('whatsapp_connection_not_active');
  }

  private statusErrorCode(status: JsonObject): string | undefined {
    if (!Array.isArray(status.errors)) return;
    const first = object(status.errors[0]);
    const code =
      typeof first?.code === 'number' ? String(first.code) : boundedString(first?.code, 64);
    return code ? `META_${code}`.slice(0, 80) : undefined;
  }

  private async complete(
    transaction: Prisma.TransactionClient,
    claimed: ClaimedInboxRecord,
  ): Promise<void> {
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
    if (completed.count !== 1) throw new WhatsAppInboundLeaseConflictError();
  }

  private async fail(
    claimed: ClaimedInboxRecord,
    permanent: boolean,
    error: unknown,
  ): Promise<void> {
    const terminal = permanent || claimed.attempts >= claimed.maxAttempts;
    const code =
      error instanceof WhatsAppInboundPendingError
        ? error.message
        : error instanceof Error && error.message.startsWith('whatsapp_')
          ? error.message
          : 'whatsapp_inbound_processing_failed';
    const retryDelay = Math.min(60_000, 1_000 * 2 ** Math.max(0, claimed.attempts - 1));
    await this.database.client.inboxRecord.updateMany({
      data: {
        lastError: code,
        lockedAt: null,
        lockedBy: null,
        ...(terminal
          ? { nextAttemptAt: null, status: 'DEAD_LETTER' as const }
          : { nextAttemptAt: new Date(Date.now() + retryDelay), status: 'RETRY' as const }),
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
