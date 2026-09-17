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
  TelegramAdapter,
  TelegramApiError,
  TelegramHttpTransport,
  TELEGRAM_OUTBOUND_JOB_NAME,
  TELEGRAM_OUTBOUND_QUEUE_NAME,
  type TelegramInlineKeyboard,
  type TelegramLinkPreviewOptions,
  type TelegramMediaKind,
  type TelegramMessageEntity,
  type TelegramMediaGroupItem as TelegramAdapterMediaGroupItem,
  type TelegramOutboundJob,
  type TelegramReaction,
  type TelegramReplyMarkup,
  type TelegramRichMessage,
} from '@omnicus/channel-telegram';
import type { WorkerEnvironment } from '@omnicus/config/server';
import type { Prisma } from '@omnicus/database';
import {
  MediaValidationError,
  prepareMediaForTelegram,
  S3MediaStorage,
  type MediaKind,
} from '@omnicus/media-core';
import { Worker, type Job } from 'bullmq';
import { DatabaseService } from '../database/database.service';
import { redisConnectionFromUrl } from '../queue/redis-connection';
import { ensureCrmOutboundHistoryIntent } from '../crm/crm-outbound-history';

export const TELEGRAM_OUTBOUND_PROCESSOR_CLIENT = Symbol('TELEGRAM_OUTBOUND_PROCESSOR_CLIENT');
export interface TelegramOutboundProcessorClient {
  close(force?: boolean): Promise<void>;
  waitUntilReady(): Promise<unknown>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
type MessageActionPayload = {
  action: 'DELETE_MESSAGE' | 'EDIT_MESSAGE' | 'PIN_MESSAGE' | 'SET_REACTION';
  channelIdentityId: string;
  messageId: string;
  mutation: Record<string, unknown>;
  providerMessageId: string;
};

type Claimed = {
  id: string;
  projectId: string;
  connectionId: string;
  attempts: number;
  maxAttempts: number;
  lease: string;
  payload:
    | {
        action: 'ANSWER_CALLBACK';
        callbackQueryId: string;
      }
    | {
        action?: 'SEND_MESSAGE';
        messageId: string;
        channelIdentityId: string;
      }
    | {
        action: 'SEND_MEDIA_GROUP';
        channelIdentityId: string;
        mediaGroupId: string;
      }
    | {
        action: 'CONFIGURE_BOT_INTERFACE';
        botInterfaceId: string;
      }
    | MessageActionPayload;
};

function isMessageActionPayload(payload: Claimed['payload']): payload is MessageActionPayload {
  return ['DELETE_MESSAGE', 'EDIT_MESSAGE', 'PIN_MESSAGE', 'SET_REACTION'].includes(
    payload.action ?? '',
  );
}

class TelegramOutboundPermanentError extends Error {
  constructor(readonly code: string) {
    super('Telegram outbound request cannot be retried');
    this.name = 'TelegramOutboundPermanentError';
  }
}

@Injectable()
export class TelegramOutboundProcessorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(TelegramOutboundProcessorService.name);
  private client: TelegramOutboundProcessorClient | undefined;
  private readonly workerId = `telegram-outbound-${process.pid}-${randomUUID()}`;
  private readonly secrets: ChannelSecretsService;
  private readonly storage: S3MediaStorage | undefined;
  private readonly maximumMediaBytes: number;
  private readonly adapter = new TelegramAdapter(new TelegramHttpTransport());
  constructor(
    @Inject(ConfigService) config: ConfigService<WorkerEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional()
    @Inject(TELEGRAM_OUTBOUND_PROCESSOR_CLIENT)
    client?: TelegramOutboundProcessorClient,
  ) {
    this.config = config;
    this.client = client;
    this.maximumMediaBytes = config.get('MEDIA_MAX_UPLOAD_BYTES', { infer: true });
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
  private readonly config: ConfigService<WorkerEnvironment, true>;
  async onApplicationBootstrap(): Promise<void> {
    if (!this.client)
      this.client = new Worker(
        TELEGRAM_OUTBOUND_QUEUE_NAME,
        async (job: Job<TelegramOutboundJob>) => {
          if (job.name !== TELEGRAM_OUTBOUND_JOB_NAME)
            throw new Error('Unsupported Telegram outbound job');
          await this.process(job.data);
        },
        {
          connection: {
            ...redisConnectionFromUrl(this.config.get('REDIS_URL', { infer: true })),
            maxRetriesPerRequest: null,
          },
          concurrency: 4,
        },
      );
    this.client.on('error', () => this.logger.error({ message: 'Telegram outbound worker error' }));
    await this.client.waitUntilReady();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.client?.close(true);
  }
  async process(job: TelegramOutboundJob): Promise<void> {
    const claimed = await this.claim(job.outboxRecordId);
    if (!claimed) return;
    try {
      const connection = await this.database.client.channelConnection.findUnique({
        where: {
          projectId_id: {
            projectId: claimed.projectId,
            id: claimed.connectionId,
          },
        },
      });
      if (!connection)
        return await this.finish(claimed, 'FAILED', 'telegram_outbound_connection_missing');
      const token = this.secrets.decryptSecret({
        projectId: connection.projectId,
        channelConnectionId: connection.id,
        channelType: 'telegram',
        field: 'botToken',
        envelope: connection.credentialsEncrypted as unknown as EncryptedSecretEnvelope,
      });
      if (claimed.payload.action === 'ANSWER_CALLBACK') {
        await this.adapter.answerCallbackQuery(token, {
          callbackQueryId: claimed.payload.callbackQueryId,
        });
        await this.finish(claimed, 'SUCCEEDED');
        return;
      }
      if (claimed.payload.action === 'SEND_MEDIA_GROUP') {
        await this.executeMediaGroup(token, claimed, claimed.payload);
        return;
      }
      if (claimed.payload.action === 'CONFIGURE_BOT_INTERFACE') {
        await this.executeBotInterface(token, claimed, claimed.payload.botInterfaceId);
        return;
      }

      const [message, identity, recipient, scheduled] = await Promise.all([
        this.database.client.message.findUnique({
          include: { mediaAsset: true },
          where: { projectId_id: { projectId: claimed.projectId, id: claimed.payload.messageId } },
        }),
        this.database.client.channelIdentity.findUnique({
          where: { id: claimed.payload.channelIdentityId },
        }),
        this.database.client.broadcastRecipient.findFirst({
          where: { outboxRecordId: claimed.id, projectId: claimed.projectId },
          include: { broadcast: { select: { status: true } } },
        }),
        this.database.client.scheduledMessage.findUnique({
          where: { outboxRecordId: claimed.id },
        }),
      ]);
      if (
        !message ||
        !connection ||
        !identity ||
        identity.projectId !== claimed.projectId ||
        identity.connectionId !== claimed.connectionId
      )
        return await this.finish(claimed, 'FAILED', 'telegram_outbound_invalid_relation');
      if (isMessageActionPayload(claimed.payload)) {
        if (message.externalMessageId !== claimed.payload.providerMessageId)
          return await this.finish(claimed, 'FAILED', 'telegram_outbound_message_mismatch');
        await this.executeMessageAction(
          token,
          { ...claimed, payload: claimed.payload },
          message,
          identity.externalUserId,
        );
        return;
      }
      if (recipient?.broadcast.status === 'CANCELLED')
        return await this.cancelBroadcastRecipient(claimed, recipient.id);
      if (recipient?.broadcast.status === 'PAUSED')
        return await this.deferBroadcastRecipient(claimed);
      if (message.status === 'SENT') return await this.finish(claimed, 'SUCCEEDED');
      if (recipient)
        await this.database.client.broadcastRecipient.updateMany({
          where: { id: recipient.id, projectId: claimed.projectId, status: 'QUEUED' },
          data: { status: 'PROCESSING' },
        });
      if (scheduled)
        await this.database.client.scheduledMessage.updateMany({
          data: { status: 'PROCESSING' },
          where: { id: scheduled.id, projectId: claimed.projectId, status: 'QUEUED' },
        });
      const metadata = message.metadata as {
        disableNotification?: boolean;
        durationSeconds?: number;
        entities?: TelegramMessageEntity[];
        hasSpoiler?: boolean;
        inlineKeyboard?: TelegramInlineKeyboard;
        linkPreviewOptions?: TelegramLinkPreviewOptions;
        messageEffectId?: string;
        protectContent?: boolean;
        quote?: string;
        quotePosition?: number;
        replyMarkup?: TelegramReplyMarkup;
        replyToMessageId?: string;
      } | null;
      const content = message.content as {
        caption?: string;
        inlineKeyboard?: TelegramInlineKeyboard;
        structured?:
          | {
              firstName: string;
              lastName?: string;
              phoneNumber: string;
              type: 'contact';
              vcard?: string;
            }
          | {
              horizontalAccuracy?: number;
              latitude: number;
              longitude: number;
              type: 'location';
            }
          | {
              allowsMultipleAnswers?: boolean;
              isAnonymous?: boolean;
              options: string[];
              question: string;
              type: 'poll';
            };
        richMessage?: Omit<TelegramRichMessage, 'media'> & {
          media?: {
            id: string;
            kind: 'ANIMATION' | 'AUDIO' | 'PHOTO' | 'VIDEO' | 'VOICE';
          };
        };
        text?: string;
      };
      const sendOptions = {
        chatId: identity.externalUserId,
        ...(metadata?.disableNotification ? { disableNotification: true } : {}),
        ...((metadata?.inlineKeyboard ?? content.inlineKeyboard)
          ? { inlineKeyboard: metadata?.inlineKeyboard ?? content.inlineKeyboard }
          : {}),
        ...(metadata?.protectContent ? { protectContent: true } : {}),
        ...(metadata?.replyMarkup ? { replyMarkup: metadata.replyMarkup } : {}),
        ...(metadata?.replyToMessageId
          ? {
              reply: {
                messageId: metadata.replyToMessageId,
                ...(metadata.quote ? { quote: metadata.quote } : {}),
                ...(metadata.quotePosition === undefined
                  ? {}
                  : { quotePosition: metadata.quotePosition }),
              },
            }
          : {}),
      };
      let sent: { messageId: string };
      if (message.type === 'RICH' && content.richMessage) {
        const richMedia = content.richMessage.media;
        sent = await this.adapter.sendRichMessage(token, {
          ...sendOptions,
          richMessage: {
            ...(content.richMessage.isRtl ? { isRtl: true } : {}),
            markdown: content.richMessage.markdown,
            ...(richMedia && message.mediaAsset
              ? {
                  media: {
                    id: richMedia.id,
                    kind: richMedia.kind,
                    media: await this.mediaReference(
                      message.mediaAsset,
                      claimed.connectionId,
                      richMedia.kind,
                    ),
                  },
                }
              : {}),
            ...(content.richMessage.skipEntityDetection ? { skipEntityDetection: true } : {}),
          },
        });
      } else if (['CONTACT', 'LOCATION', 'POLL'].includes(message.type) && content.structured) {
        sent = await this.adapter.sendStructuredMessage(token, {
          chatId: identity.externalUserId,
          ...(metadata?.disableNotification === undefined
            ? {}
            : { disableNotification: metadata.disableNotification }),
          ...(metadata?.protectContent === undefined
            ? {}
            : { protectContent: metadata.protectContent }),
          structured: content.structured,
        });
      } else if (
        [
          'PHOTO',
          'DOCUMENT',
          'VIDEO',
          'AUDIO',
          'VOICE',
          'VIDEO_NOTE',
          'ANIMATION',
          'STICKER',
        ].includes(message.type) &&
        message.mediaAsset
      ) {
        try {
          sent = await this.adapter.sendMedia(token, {
            ...sendOptions,
            ...(content.caption ? { caption: content.caption } : {}),
            ...(metadata?.entities ? { captionEntities: metadata.entities } : {}),
            ...(metadata?.hasSpoiler ? { hasSpoiler: true } : {}),
            ...(metadata?.durationSeconds === undefined
              ? {}
              : { duration: metadata.durationSeconds }),
            kind: message.type as TelegramMediaKind,
            media: await this.mediaReference(
              message.mediaAsset,
              claimed.connectionId,
              message.type as MediaKind,
            ),
          });
        } catch (error) {
          if (error instanceof TelegramApiError && error.errorCode === 400)
            throw new TelegramOutboundPermanentError('telegram_outbound_media_rejected');
          throw error;
        }
      } else {
        sent = await this.adapter.sendMessage(token, {
          ...sendOptions,
          ...(metadata?.entities ? { entities: metadata.entities } : {}),
          ...(metadata?.linkPreviewOptions
            ? { linkPreviewOptions: metadata.linkPreviewOptions }
            : {}),
          ...(metadata?.messageEffectId ? { messageEffectId: metadata.messageEffectId } : {}),
          text: content.text ?? '',
        });
      }
      await this.database.client.$transaction(async (tx) => {
        const done = await tx.outboxRecord.updateMany({
          where: {
            id: claimed.id,
            projectId: claimed.projectId,
            lockedBy: claimed.lease,
            status: 'PROCESSING',
          },
          data: {
            status: 'SUCCEEDED',
            completedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
            lastError: null,
          },
        });
        if (done.count !== 1) return;
        await tx.message.update({
          where: { projectId_id: { projectId: claimed.projectId, id: message.id } },
          data: { status: 'SENT', sentAt: new Date(), externalMessageId: sent.messageId },
        });
        if (scheduled)
          await tx.scheduledMessage.updateMany({
            data: { completedAt: new Date(), status: 'SENT' },
            where: {
              id: scheduled.id,
              projectId: claimed.projectId,
              status: { in: ['QUEUED', 'PROCESSING'] },
            },
          });
        if (scheduled) await this.createNextScheduledOccurrence(tx, scheduled, message);
        await ensureCrmOutboundHistoryIntent(tx, claimed.projectId, message.id);
        if (recipient) {
          await tx.broadcastRecipient.updateMany({
            where: { id: recipient.id, projectId: claimed.projectId, status: 'PROCESSING' },
            data: { status: 'SENT', completedAt: new Date(), lastError: null },
          });
          await this.completeBroadcastIfTerminal(tx, claimed.projectId, recipient.broadcastId);
        }
      });
    } catch (error) {
      await this.fail(claimed, error);
      if (this.retryable(error)) throw error;
    }
  }
  private async executeMediaGroup(
    token: string,
    claimed: Claimed,
    payload: { channelIdentityId: string; mediaGroupId: string },
  ): Promise<void> {
    const [group, identity] = await Promise.all([
      this.database.client.telegramMediaGroup.findUnique({
        include: { items: { include: { mediaAsset: true }, orderBy: { position: 'asc' } } },
        where: { projectId_id: { id: payload.mediaGroupId, projectId: claimed.projectId } },
      }),
      this.database.client.channelIdentity.findUnique({
        where: { projectId_id: { id: payload.channelIdentityId, projectId: claimed.projectId } },
      }),
    ]);
    if (
      !group ||
      !identity ||
      group.outboxRecordId !== claimed.id ||
      group.connectionId !== claimed.connectionId ||
      group.channelIdentityId !== identity.id ||
      group.contactId !== identity.contactId ||
      identity.connectionId !== claimed.connectionId
    )
      throw new TelegramOutboundPermanentError('telegram_media_group_scope_invalid');
    if (group.status === 'SENT') return await this.finish(claimed, 'SUCCEEDED');
    await this.database.client.telegramMediaGroup.updateMany({
      data: { status: 'PROCESSING' },
      where: { id: group.id, projectId: claimed.projectId, status: 'QUEUED' },
    });
    const items: TelegramAdapterMediaGroupItem[] = [];
    for (const item of group.items) {
      const entities = Array.isArray(item.entities)
        ? (item.entities as unknown as TelegramMessageEntity[])
        : undefined;
      items.push({
        ...(item.caption === null ? {} : { caption: item.caption }),
        ...(entities ? { captionEntities: entities } : {}),
        ...(item.hasSpoiler ? { hasSpoiler: true } : {}),
        kind: item.kind as 'AUDIO' | 'DOCUMENT' | 'PHOTO' | 'VIDEO',
        media: await this.mediaReference(
          item.mediaAsset,
          claimed.connectionId,
          item.kind as MediaKind,
        ),
      });
    }
    const sent = await this.adapter.sendMediaGroup(token, {
      chatId: identity.externalUserId,
      disableNotification: group.disableNotification,
      items,
      protectContent: group.protectContent,
    });
    await this.database.client.$transaction(async (transaction) => {
      const done = await transaction.outboxRecord.updateMany({
        data: {
          completedAt: new Date(),
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          status: 'SUCCEEDED',
        },
        where: {
          id: claimed.id,
          lockedBy: claimed.lease,
          projectId: claimed.projectId,
          status: 'PROCESSING',
        },
      });
      if (done.count !== 1) return;
      await transaction.telegramMediaGroup.update({
        data: {
          completedAt: new Date(),
          providerMessageIds: sent.messageIds,
          status: 'SENT',
        },
        where: { projectId_id: { id: group.id, projectId: claimed.projectId } },
      });
      for (const [position, providerMessageId] of sent.messageIds.entries()) {
        await transaction.telegramMediaGroupItem.updateMany({
          data: { providerMessageId },
          where: { mediaGroupId: group.id, position, projectId: claimed.projectId },
        });
        await transaction.message.updateMany({
          where: {
            projectId: claimed.projectId,
            connectionId: claimed.connectionId,
            direction: 'OUTBOUND',
            AND: [
              { metadata: { path: ['mediaGroupId'], equals: group.id } },
              { metadata: { path: ['mediaGroupPosition'], equals: position } },
            ],
          },
          data: { status: 'SENT', externalMessageId: providerMessageId, sentAt: new Date() },
        });
      }
    });
  }
  private async executeBotInterface(
    token: string,
    claimed: Claimed,
    botInterfaceId: string,
  ): Promise<void> {
    const config = await this.database.client.telegramBotInterface.findUnique({
      where: { projectId_id: { id: botInterfaceId, projectId: claimed.projectId } },
    });
    if (
      !config ||
      config.connectionId !== claimed.connectionId ||
      config.outboxRecordId !== claimed.id
    )
      throw new TelegramOutboundPermanentError('telegram_bot_interface_scope_invalid');
    const commands = Array.isArray(config.commands)
      ? (config.commands as Array<{ command: string; description: string }>)
      : [];
    const scope = config.commandScope as Record<string, unknown>;
    const menuButton = config.menuButton as Record<string, unknown>;
    let chatId: string | undefined;
    if (scope.type === 'chat' && typeof scope.channelIdentityId === 'string') {
      const identity = await this.database.client.channelIdentity.findUnique({
        where: {
          projectId_id: { id: scope.channelIdentityId, projectId: claimed.projectId },
        },
      });
      if (!identity || identity.connectionId !== claimed.connectionId)
        throw new TelegramOutboundPermanentError('telegram_bot_interface_scope_invalid');
      chatId = identity.externalUserId;
    }
    await this.adapter.configureBotInterface(token, {
      commands,
      languageCode: config.languageCode,
      menuButton: menuButton as {
        text?: string;
        type: 'commands' | 'default' | 'web_app';
        url?: string;
      },
      scope: {
        ...(chatId ? { chatId } : {}),
        type: scope.type as 'all_private_chats' | 'chat' | 'default',
      },
    });
    await this.finish(claimed, 'SUCCEEDED');
  }
  private async executeMessageAction(
    token: string,
    claimed: Omit<Claimed, 'payload'> & { payload: MessageActionPayload },
    message: {
      content: unknown;
      id: string;
      metadata: unknown;
      type: string;
    },
    chatId: string,
  ): Promise<void> {
    const mutation = claimed.payload.mutation;
    if (claimed.payload.action === 'DELETE_MESSAGE')
      await this.adapter.deleteMessage(token, {
        chatId,
        messageId: claimed.payload.providerMessageId,
      });
    else if (claimed.payload.action === 'SET_REACTION')
      await this.adapter.setMessageReaction(token, {
        chatId,
        ...((mutation.reaction as TelegramReaction | undefined)
          ? { reaction: mutation.reaction as TelegramReaction }
          : {}),
        ...(mutation.isBig === true ? { isBig: true } : {}),
        messageId: claimed.payload.providerMessageId,
      });
    else if (claimed.payload.action === 'PIN_MESSAGE')
      await this.adapter.setMessagePinned(token, {
        chatId,
        ...(mutation.disableNotification === true ? { disableNotification: true } : {}),
        messageId: claimed.payload.providerMessageId,
        pinned: mutation.pinned === true,
      });
    else if (typeof mutation.text === 'string')
      await this.adapter.editMessageText(token, {
        chatId,
        ...(Array.isArray(mutation.entities)
          ? { entities: mutation.entities as TelegramMessageEntity[] }
          : {}),
        ...(Array.isArray(mutation.inlineKeyboard)
          ? { inlineKeyboard: mutation.inlineKeyboard as TelegramInlineKeyboard }
          : {}),
        ...(mutation.linkPreviewOptions
          ? { linkPreviewOptions: mutation.linkPreviewOptions as TelegramLinkPreviewOptions }
          : {}),
        messageId: claimed.payload.providerMessageId,
        text: mutation.text,
      });
    else
      await this.adapter.editMessageCaption(token, {
        caption: typeof mutation.caption === 'string' ? mutation.caption : '',
        chatId,
        ...(Array.isArray(mutation.entities)
          ? { entities: mutation.entities as TelegramMessageEntity[] }
          : {}),
        ...(Array.isArray(mutation.inlineKeyboard)
          ? { inlineKeyboard: mutation.inlineKeyboard as TelegramInlineKeyboard }
          : {}),
        messageId: claimed.payload.providerMessageId,
      });

    await this.database.client.$transaction(async (tx) => {
      const done = await tx.outboxRecord.updateMany({
        where: {
          id: claimed.id,
          lockedBy: claimed.lease,
          projectId: claimed.projectId,
          status: 'PROCESSING',
        },
        data: {
          completedAt: new Date(),
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          status: 'SUCCEEDED',
        },
      });
      if (done.count !== 1) return;
      const content = (message.content ?? {}) as Record<string, unknown>;
      const metadata = (message.metadata ?? {}) as Record<string, unknown>;
      await tx.message.updateMany({
        where: { id: message.id, projectId: claimed.projectId },
        data: {
          content:
            claimed.payload.action === 'EDIT_MESSAGE'
              ? ({
                  ...content,
                  ...(typeof mutation.caption === 'string' ? { caption: mutation.caption } : {}),
                  ...(typeof mutation.text === 'string' ? { text: mutation.text } : {}),
                  ...(Array.isArray(mutation.inlineKeyboard)
                    ? { inlineKeyboard: mutation.inlineKeyboard }
                    : {}),
                } as Prisma.InputJsonValue)
              : (content as Prisma.InputJsonValue),
          metadata: {
            ...metadata,
            ...(claimed.payload.action === 'DELETE_MESSAGE' ? { deleted: true } : {}),
            ...(claimed.payload.action === 'EDIT_MESSAGE'
              ? {
                  editedAt: new Date().toISOString(),
                  ...(typeof mutation.text === 'string' || typeof mutation.caption === 'string'
                    ? {
                        entities: mutation.entities ?? [],
                        linkPreviewOptions: mutation.linkPreviewOptions ?? {},
                      }
                    : {}),
                }
              : {}),
            ...(claimed.payload.action === 'PIN_MESSAGE'
              ? { pinned: mutation.pinned === true }
              : {}),
            ...(claimed.payload.action === 'SET_REACTION'
              ? { managerReaction: mutation.reaction ?? null }
              : {}),
          } as Prisma.InputJsonValue,
        },
      });
    });
  }
  private async mediaReference(
    asset: {
      bucketKey: string | null;
      connectionId: string | null;
      detectedMimeType: string | null;
      extension: string | null;
      originalFilename: string | null;
      providerMediaId: string | null;
      status: string;
    },
    connectionId: string,
    kind: MediaKind,
  ): Promise<
    | string
    | {
        bytes: Uint8Array;
        contentType: string;
        filename: string;
      }
  > {
    if (
      asset.providerMediaId &&
      asset.connectionId === connectionId &&
      asset.status !== 'REJECTED' &&
      asset.status !== 'UNAVAILABLE'
    )
      return asset.providerMediaId;
    if (asset.status !== 'AVAILABLE' || !asset.bucketKey || !this.storage)
      throw new TelegramOutboundPermanentError('telegram_outbound_media_unavailable');
    const object = await this.storage.getObject(asset.bucketKey);
    const originalStem = asset.originalFilename?.replace(/\.[^.]+$/, '') || 'telegram-media';
    const normalizedFilename = asset.extension
      ? `${originalStem}.${asset.extension}`
      : asset.originalFilename;
    let prepared;
    try {
      prepared = await prepareMediaForTelegram({
        bytes: object.bytes,
        ...((asset.detectedMimeType ?? object.contentType)
          ? { declaredMimeType: asset.detectedMimeType ?? object.contentType }
          : {}),
        ...(normalizedFilename ? { filename: normalizedFilename } : {}),
        kind,
        maximumBytes: this.maximumMediaBytes,
      });
    } catch (error) {
      throw new TelegramOutboundPermanentError(
        error instanceof MediaValidationError
          ? `telegram_outbound_${error.code}`
          : 'telegram_outbound_media_rejected',
      );
    }
    return {
      bytes: prepared.bytes,
      contentType: prepared.mimeType,
      filename: `${originalStem}.${prepared.extension}`,
    };
  }
  private async createNextScheduledOccurrence(
    transaction: Prisma.TransactionClient,
    scheduled: {
      channelIdentityId: string;
      connectionId: string;
      contactId: string;
      occurrence: number;
      projectId: string;
      recurrence: Prisma.JsonValue | null;
      request: Prisma.JsonValue;
      scheduledAt: Date;
      seriesId: string;
      timezone: string;
    },
    message: {
      connectionId: string;
      contactId: string;
      content: Prisma.JsonValue;
      conversationId: string;
      mediaAssetId: string | null;
      metadata: Prisma.JsonValue | null;
      projectId: string;
      type: string;
    },
  ): Promise<void> {
    const recurrence = this.recurrenceRule(scheduled.recurrence);
    if (!recurrence || (recurrence.count && scheduled.occurrence >= recurrence.count)) return;
    const nextAt = this.addZonedDays(
      scheduled.scheduledAt,
      recurrence.frequency === 'WEEKLY' ? recurrence.interval * 7 : recurrence.interval,
      scheduled.timezone,
    );
    if (recurrence.until && nextAt.getTime() > recurrence.until.getTime()) return;
    const occurrence = scheduled.occurrence + 1;
    const existing = await transaction.scheduledMessage.findUnique({
      where: {
        projectId_seriesId_occurrence: {
          occurrence,
          projectId: scheduled.projectId,
          seriesId: scheduled.seriesId,
        },
      },
    });
    if (existing) return;
    const metadata =
      message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? (message.metadata as Prisma.JsonObject)
        : {};
    const nextMessage = await transaction.message.create({
      data: {
        connectionId: message.connectionId,
        contactId: message.contactId,
        content: message.content as Prisma.InputJsonValue,
        conversationId: message.conversationId,
        direction: 'OUTBOUND',
        mediaAssetId: message.mediaAssetId,
        metadata: {
          ...metadata,
          scheduleOccurrence: occurrence,
          scheduleSeriesId: scheduled.seriesId,
          source: 'system',
        } as Prisma.InputJsonValue,
        projectId: message.projectId,
        status: 'QUEUED',
        type: message.type as never,
      },
    });
    const outbox = await transaction.outboxRecord.create({
      data: {
        connectionId: scheduled.connectionId,
        idempotencyKey: `scheduled-series-${scheduled.seriesId}-${occurrence}`,
        kind: 'TELEGRAM',
        nextAttemptAt: nextAt,
        payload: {
          channelIdentityId: scheduled.channelIdentityId,
          messageId: nextMessage.id,
        },
        projectId: scheduled.projectId,
      },
    });
    await transaction.scheduledMessage.create({
      data: {
        channelIdentityId: scheduled.channelIdentityId,
        connectionId: scheduled.connectionId,
        contactId: scheduled.contactId,
        messageId: nextMessage.id,
        occurrence,
        outboxRecordId: outbox.id,
        projectId: scheduled.projectId,
        recurrence: scheduled.recurrence as Prisma.InputJsonValue,
        request: scheduled.request as Prisma.InputJsonValue,
        scheduledAt: nextAt,
        seriesId: scheduled.seriesId,
        timezone: scheduled.timezone,
      },
    });
  }

  private recurrenceRule(value: Prisma.JsonValue | null):
    | {
        count?: number;
        frequency: 'DAILY' | 'WEEKLY';
        interval: number;
        until?: Date;
      }
    | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const rule = value as Prisma.JsonObject;
    if (
      !['DAILY', 'WEEKLY'].includes(String(rule.frequency)) ||
      typeof rule.interval !== 'number' ||
      !Number.isInteger(rule.interval) ||
      rule.interval < 1 ||
      rule.interval > 30
    )
      return undefined;
    const until = typeof rule.until === 'string' ? new Date(rule.until) : undefined;
    return {
      ...(typeof rule.count === 'number' ? { count: rule.count } : {}),
      frequency: rule.frequency as 'DAILY' | 'WEEKLY',
      interval: rule.interval,
      ...(until && !Number.isNaN(until.getTime()) ? { until } : {}),
    };
  }

  private addZonedDays(date: Date, days: number, timezone: string): Date {
    const parts = this.zonedParts(date, timezone);
    const wanted = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days,
      parts.hour,
      parts.minute,
      parts.second,
      date.getUTCMilliseconds(),
    );
    let guess = wanted;
    for (let index = 0; index < 4; index += 1) {
      const actual = this.zonedParts(new Date(guess), timezone);
      const actualWall = Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second,
        date.getUTCMilliseconds(),
      );
      const correction = wanted - actualWall;
      guess += correction;
      if (correction === 0) break;
    }
    return new Date(guess);
  }

  private zonedParts(date: Date, timezone: string) {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
        minute: '2-digit',
        month: '2-digit',
        second: '2-digit',
        timeZone: timezone,
        year: 'numeric',
      })
        .formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    return {
      day: values.day!,
      hour: values.hour!,
      minute: values.minute!,
      month: values.month!,
      second: values.second!,
      year: values.year!,
    };
  }
  private async claim(id: string): Promise<Claimed | undefined> {
    const now = new Date();
    const lease = `${this.workerId}-${randomUUID()}`;
    const row = await this.database.client.outboxRecord.findUnique({ where: { id } });
    if (
      !row ||
      row.kind !== 'TELEGRAM' ||
      !row.connectionId ||
      !['PENDING', 'RETRY', 'PROCESSING'].includes(row.status)
    )
      return undefined;
    const expiry = new Date(
      now.getTime() - this.config.get('TELEGRAM_OUTBOUND_LEASE_MS', { infer: true }),
    );
    const updated = await this.database.client.outboxRecord.updateMany({
      where: {
        id,
        status: { in: ['PENDING', 'RETRY', 'PROCESSING'] },
        OR: [
          {
            status: { in: ['PENDING', 'RETRY'] },
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          { status: 'PROCESSING', lockedAt: { lt: expiry } },
        ],
      },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        lockedAt: now,
        lockedBy: lease,
        lastError: null,
      },
    });
    if (!updated.count) return undefined;
    return {
      id: row.id,
      projectId: row.projectId,
      connectionId: row.connectionId,
      attempts: row.attempts + 1,
      maxAttempts: row.maxAttempts,
      lease,
      payload: row.payload as Claimed['payload'],
    };
  }
  private retryable(error: unknown): boolean {
    if (error instanceof TelegramOutboundPermanentError) return false;
    return error instanceof TelegramApiError
      ? error.errorCode === 429 || (error.errorCode !== undefined && error.errorCode >= 500)
      : !(error instanceof Error && error.name === 'AbortError');
  }
  private async finish(
    claimed: Claimed,
    status: 'FAILED' | 'SUCCEEDED',
    error?: string,
  ): Promise<void> {
    await this.database.client.outboxRecord.updateMany({
      where: {
        id: claimed.id,
        projectId: claimed.projectId,
        lockedBy: claimed.lease,
        status: 'PROCESSING',
      },
      data: {
        status,
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        ...(error ? { lastError: error } : { lastError: null }),
      },
    });
  }
  private async deferBroadcastRecipient(claimed: Claimed): Promise<void> {
    await this.database.client.$transaction(async (tx) => {
      await tx.outboxRecord.updateMany({
        where: {
          id: claimed.id,
          projectId: claimed.projectId,
          lockedBy: claimed.lease,
          status: 'PROCESSING',
        },
        data: {
          status: 'RETRY',
          lockedAt: null,
          lockedBy: null,
          lastError: 'broadcast_paused',
          nextAttemptAt: new Date(Date.now() + 30_000),
        },
      });
      await tx.broadcastRecipient.updateMany({
        where: { projectId: claimed.projectId, outboxRecordId: claimed.id, status: 'QUEUED' },
        data: { lastError: 'broadcast_paused' },
      });
    });
  }
  private async cancelBroadcastRecipient(claimed: Claimed, recipientId: string): Promise<void> {
    await this.database.client.$transaction(async (tx) => {
      await tx.outboxRecord.updateMany({
        where: {
          id: claimed.id,
          projectId: claimed.projectId,
          lockedBy: claimed.lease,
          status: 'PROCESSING',
        },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: 'broadcast_cancelled',
        },
      });
      if (!claimed.payload.action || claimed.payload.action === 'SEND_MESSAGE')
        await tx.message.updateMany({
          where: {
            id: claimed.payload.messageId,
            projectId: claimed.projectId,
            status: 'QUEUED',
          },
          data: { status: 'FAILED', failedAt: new Date() },
        });
      await tx.broadcastRecipient.updateMany({
        where: {
          id: recipientId,
          projectId: claimed.projectId,
          status: { in: ['QUEUED', 'PROCESSING'] },
        },
        data: { status: 'CANCELLED', completedAt: new Date(), lastError: 'broadcast_cancelled' },
      });
    });
  }
  private async fail(claimed: Claimed, error: unknown): Promise<void> {
    const api = error instanceof TelegramApiError ? error : undefined;
    const unknown = error instanceof Error && error.name === 'AbortError';
    const retry = this.retryable(error) && !unknown && claimed.attempts < claimed.maxAttempts;
    const delay =
      api?.errorCode === 429 && api.retryAfterSeconds
        ? api.retryAfterSeconds * 1_000
        : Math.min(300_000, 1_000 * 2 ** Math.min(claimed.attempts, 8));
    const code = unknown
      ? 'telegram_outbound_unknown'
      : error instanceof TelegramOutboundPermanentError
        ? error.code
        : api?.errorCode === 401
          ? 'telegram_outbound_invalid_token'
          : api?.errorCode === 403 || api?.errorCode === 400
            ? 'telegram_outbound_recipient_unavailable'
            : retry
              ? 'telegram_outbound_retryable'
              : 'telegram_outbound_failed';
    await this.database.client.$transaction(async (tx) => {
      await tx.outboxRecord.updateMany({
        where: {
          id: claimed.id,
          projectId: claimed.projectId,
          lockedBy: claimed.lease,
          status: 'PROCESSING',
        },
        data: {
          status: unknown ? 'UNKNOWN' : retry ? 'RETRY' : 'FAILED',
          lockedAt: null,
          lockedBy: null,
          lastError: code,
          ...(retry
            ? { nextAttemptAt: new Date(Date.now() + delay) }
            : { completedAt: new Date(), nextAttemptAt: null }),
        },
      });
      if (!claimed.payload.action || claimed.payload.action === 'SEND_MESSAGE')
        await tx.message.updateMany({
          where: {
            id: claimed.payload.messageId,
            projectId: claimed.projectId,
          },
          data: {
            status: unknown ? 'UNKNOWN' : retry ? 'QUEUED' : 'FAILED',
            ...(retry ? {} : { failedAt: new Date() }),
          },
        });
      if (api?.errorCode === 401)
        await tx.channelConnection.updateMany({
          where: { id: claimed.connectionId, projectId: claimed.projectId },
          data: { status: 'ERROR', lastErrorAt: new Date() },
        });
      if (
        api?.errorCode === 403 &&
        claimed.payload.action !== 'ANSWER_CALLBACK' &&
        'channelIdentityId' in claimed.payload
      )
        await tx.channelIdentity.updateMany({
          where: { id: claimed.payload.channelIdentityId, projectId: claimed.projectId },
          data: { status: 'BLOCKED' },
        });
      const recipient = await tx.broadcastRecipient.findFirst({
        where: { projectId: claimed.projectId, outboxRecordId: claimed.id },
      });
      if (recipient) {
        await tx.broadcastRecipient.updateMany({
          where: {
            id: recipient.id,
            projectId: claimed.projectId,
            status: { in: ['QUEUED', 'PROCESSING'] },
          },
          data: {
            status: unknown ? 'UNKNOWN' : retry ? 'QUEUED' : 'FAILED',
            ...(retry ? { lastError: code } : { completedAt: new Date(), lastError: code }),
          },
        });
        if (!retry)
          await this.completeBroadcastIfTerminal(tx, claimed.projectId, recipient.broadcastId);
      }
      const scheduled = await tx.scheduledMessage.findUnique({
        where: { outboxRecordId: claimed.id },
      });
      if (scheduled)
        await tx.scheduledMessage.updateMany({
          data: {
            status: unknown ? 'UNKNOWN' : retry ? 'QUEUED' : 'FAILED',
            ...(retry ? {} : { completedAt: new Date() }),
          },
          where: {
            id: scheduled.id,
            projectId: claimed.projectId,
            status: { in: ['QUEUED', 'PROCESSING'] },
          },
        });
      if (claimed.payload.action === 'SEND_MEDIA_GROUP') {
        await tx.telegramMediaGroup.updateMany({
          data: {
            status: unknown ? 'UNKNOWN' : retry ? 'QUEUED' : 'FAILED',
            ...(retry ? {} : { completedAt: new Date() }),
          },
          where: {
            id: claimed.payload.mediaGroupId,
            projectId: claimed.projectId,
            status: { in: ['QUEUED', 'PROCESSING'] },
          },
        });
        await tx.message.updateMany({
          where: {
            projectId: claimed.projectId,
            connectionId: claimed.connectionId,
            direction: 'OUTBOUND',
            status: { in: ['QUEUED', 'PROCESSING'] },
            metadata: { path: ['mediaGroupId'], equals: claimed.payload.mediaGroupId },
          },
          data: {
            status: unknown ? 'UNKNOWN' : retry ? 'QUEUED' : 'FAILED',
            ...(retry ? {} : { failedAt: new Date() }),
          },
        });
      }
    });
  }
  private async completeBroadcastIfTerminal(
    transaction: {
      broadcast: { updateMany(args: unknown): Promise<unknown> };
      broadcastRecipient: { count(args: unknown): Promise<number> };
    },
    projectId: string,
    broadcastId: string,
  ): Promise<void> {
    const nonTerminal = await transaction.broadcastRecipient.count({
      where: { projectId, broadcastId, status: { in: ['PENDING', 'QUEUED', 'PROCESSING'] } },
    });
    if (nonTerminal === 0)
      await transaction.broadcast.updateMany({
        where: { id: broadcastId, projectId, status: 'RUNNING' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
  }
}
