import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type TelegramInlineKeyboard,
  type TelegramLinkPreviewOptions,
  type TelegramMessageEntity,
  type TelegramReplyMarkup,
  validateTelegramInlineKeyboard,
  validateTelegramLinkPreviewOptions,
  validateTelegramMessageEntities,
  validateTelegramReplyMarkup,
} from '@omnicus/channel-telegram';
import { Prisma } from '@omnicus/database';

import { DatabaseService } from '../database/database.service';
import { TelegramOutboundQueueService } from '../channels/telegram-outbound-queue.service';
import type {
  CrmOutboundMessageDto,
  CrmScheduledMessageDto,
  CrmScheduledMessageQueryDto,
  CrmScheduledMessageUpdateDto,
} from './dto';

export interface CrmOutboundQueuedResult {
  channelIdentityId?: string;
  connectionId?: string;
  crmLeadId?: string | null;
  messageId: string;
  omnicusContactId?: string;
  operationId: string;
  replayed: boolean;
  status: 'QUEUED';
  scheduleId?: string;
}

export interface CrmOutboundStatusResult {
  errorCode?: string;
  messageId: string;
  operationId: string;
  status: 'FAILED' | 'PROCESSING' | 'QUEUED' | 'SENT' | 'SUCCEEDED' | 'UNKNOWN';
}

export interface OutboundRequestContext {
  actorEmail?: string;
  actorUserId?: string;
  source?: 'crm' | 'omnicus';
}

@Injectable()
export class CrmOutboundService {
  private readonly logger = new Logger(CrmOutboundService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TelegramOutboundQueueService)
    private readonly outboundQueue: TelegramOutboundQueueService,
  ) {}

  async connectionStatus(authenticatedProjectId?: string) {
    if (!authenticatedProjectId) return { mode: 'legacy', status: 'ACTIVE' as const };
    const connection = await this.database.client.crmProjectConfig.findUnique({
      select: {
        crmProjectId: true,
        projectId: true,
        provider: true,
        status: true,
      },
      where: { projectId: authenticatedProjectId },
    });
    if (!connection || connection.status !== 'ACTIVE')
      throw new NotFoundException({ code: 'CRM_CONNECTION_NOT_FOUND' });
    return connection;
  }

  async assertProjectRoute(
    crmProjectId: string,
    omnicusProjectId: string,
    authenticatedProjectId?: string,
  ): Promise<void> {
    const project = await this.database.client.project.findUnique({
      include: { crmConfig: true },
      where: { id: omnicusProjectId },
    });
    if (
      (authenticatedProjectId !== undefined && authenticatedProjectId !== omnicusProjectId) ||
      !project ||
      project.status !== 'ACTIVE' ||
      !project.crmConfig?.enabled ||
      project.crmConfig.crmProjectId !== crmProjectId
    )
      throw new NotFoundException({
        code: 'CRM_PROJECT_ROUTE_NOT_FOUND',
        message: 'CRM project route was not found',
      });
  }

  async queue(
    dto: CrmOutboundMessageDto | CrmScheduledMessageDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: string,
    requestContext: OutboundRequestContext = {},
  ): Promise<CrmOutboundQueuedResult> {
    const source = requestContext.source ?? 'crm';
    const structured = this.structured(dto.structured);
    const richMessage = this.richMessage(dto.richMessage);
    const providerKind = dto.identity.channel === 'whatsapp' ? 'WHATSAPP' : 'TELEGRAM';
    if (
      (structured &&
        (dto.text !== undefined || dto.media !== undefined || richMessage !== undefined)) ||
      (richMessage && (dto.text !== undefined || dto.media !== undefined))
    )
      throw new ConflictException({ code: 'CRM_STRUCTURED_MESSAGE_CONFLICT' });
    if (dto.inlineKeyboard !== undefined && dto.replyMarkup !== undefined)
      throw new ConflictException({ code: 'CRM_REPLY_MARKUP_CONFLICT' });
    const schedule =
      'scheduledAt' in dto
        ? {
            recurrence: this.recurrence(dto.recurrence),
            scheduledAt: new Date(dto.scheduledAt),
            timezone: dto.timezone,
          }
        : undefined;
    if (schedule) {
      if (
        Number.isNaN(schedule.scheduledAt.getTime()) ||
        schedule.scheduledAt.getTime() <= Date.now()
      )
        throw new ConflictException({ code: 'CRM_SCHEDULE_TIME_INVALID' });
      try {
        new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format(schedule.scheduledAt);
      } catch {
        throw new ConflictException({ code: 'CRM_SCHEDULE_TIMEZONE_INVALID' });
      }
      if (
        typeof schedule.recurrence?.until === 'string' &&
        Date.parse(schedule.recurrence.until) <= schedule.scheduledAt.getTime()
      )
        throw new ConflictException({ code: 'CRM_RECURRENCE_END_INVALID' });
      if (providerKind === 'WHATSAPP') {
        if (schedule.recurrence)
          throw new ConflictException({ code: 'WHATSAPP_RECURRING_SCHEDULE_UNSUPPORTED' });
        if (
          !dto.text?.trim() ||
          dto.media ||
          structured ||
          richMessage ||
          dto.inlineKeyboard ||
          dto.replyMarkup ||
          dto.entities ||
          dto.linkPreviewOptions ||
          dto.quote ||
          dto.quotePosition !== undefined ||
          dto.protectContent ||
          dto.messageEffectId ||
          dto.disableNotification ||
          dto.hasSpoiler
        )
          throw new ConflictException({ code: 'WHATSAPP_SCHEDULE_CONTENT_UNSUPPORTED' });
      }
    }
    if (
      dto.media?.kind === 'STICKER' &&
      (dto.text !== undefined || dto.entities !== undefined || dto.linkPreviewOptions !== undefined)
    )
      throw new ConflictException({
        code: 'CRM_STICKER_CAPTION_UNSUPPORTED',
        message: 'Sticker messages cannot have a caption',
      });
    if (dto.hasSpoiler && !['ANIMATION', 'PHOTO', 'VIDEO'].includes(dto.media?.kind ?? ''))
      throw new ConflictException({
        code: 'CRM_MEDIA_SPOILER_UNSUPPORTED',
        message: 'Media spoiler is unavailable for this media kind',
      });
    const project = await this.database.client.project.findUnique({
      include: { crmConfig: true },
      where: { id: dto.omnicusProjectId },
    });
    if (
      (authenticatedProjectId !== undefined && authenticatedProjectId !== dto.omnicusProjectId) ||
      !project ||
      project.status !== 'ACTIVE' ||
      (source === 'crm' &&
        (!project.crmConfig?.enabled || project.crmConfig.crmProjectId !== dto.crmProjectId))
    )
      throw new NotFoundException({
        code: 'CRM_PROJECT_ROUTE_NOT_FOUND',
        message: 'CRM project route was not found',
      });

    const identity = await this.database.client.channelIdentity.findUnique({
      include: { connection: { select: { status: true, type: true } } },
      where: {
        projectId_id: {
          id: dto.identity.channelIdentityId,
          projectId: dto.omnicusProjectId,
        },
      },
    });
    if (
      !identity ||
      identity.contactId !== dto.omnicusContactId ||
      identity.connectionId !== dto.identity.connectionId ||
      identity.channel !== providerKind ||
      identity.connection.type !== providerKind
    )
      throw new NotFoundException({
        code: 'CRM_CHANNEL_IDENTITY_NOT_FOUND',
        message: 'CRM channel identity route was not found',
      });
    if (identity.status !== 'ACTIVE' || identity.connection.status !== 'ACTIVE')
      throw new ConflictException({
        code: 'CRM_CHANNEL_IDENTITY_UNAVAILABLE',
        message: 'CRM channel identity is unavailable',
      });

    const contact = await this.database.client.contact.findUnique({
      select: { crmLeadId: true, displayName: true },
      where: {
        projectId_id: {
          id: dto.omnicusContactId,
          projectId: dto.omnicusProjectId,
        },
      },
    });
    if (!contact)
      throw new NotFoundException({
        code: 'CRM_CONTACT_NOT_FOUND',
        message: 'CRM contact route was not found',
      });
    if (dto.crmLeadId && contact.crmLeadId && dto.crmLeadId !== contact.crmLeadId)
      throw new ConflictException({
        code: 'CRM_LEAD_MAPPING_CONFLICT',
        message: 'CRM lead mapping does not match',
      });

    const idempotencyScope =
      source === 'omnicus'
        ? schedule
          ? 'omnicus-scheduled'
          : 'omnicus-to-telegram'
        : schedule
          ? providerKind === 'WHATSAPP'
            ? 'crm-scheduled-whatsapp'
            : 'crm-scheduled'
          : 'crm-to-telegram';
    const storedKey = `${idempotencyScope}-${idempotencyKey}`;
    const existing = await this.existing(dto.omnicusProjectId, storedKey);
    if (existing) return { ...existing, replayed: true };

    let result: Omit<CrmOutboundQueuedResult, 'replayed'>;
    try {
      result = await this.database.client.$transaction(async (transaction) => {
        const conversation = await transaction.conversation.upsert({
          create: {
            connectionId: identity.connectionId,
            contactId: identity.contactId,
            externalChatId: identity.externalUserId,
            projectId: dto.omnicusProjectId,
          },
          update: {},
          where: {
            projectId_connectionId_externalChatId: {
              connectionId: identity.connectionId,
              externalChatId: identity.externalUserId,
              projectId: dto.omnicusProjectId,
            },
          },
        });
        const richMedia = richMessage?.media;
        const requestedMedia =
          dto.media ??
          (richMedia ? { kind: richMedia.kind, mediaAssetId: richMedia.mediaAssetId } : undefined);
        const mediaAsset = requestedMedia
          ? await transaction.mediaAsset.findFirst({
              select: { id: true, kind: true },
              where: {
                id: requestedMedia.mediaAssetId,
                kind: requestedMedia.kind,
                projectId: dto.omnicusProjectId,
                status: 'AVAILABLE',
              },
            })
          : undefined;
        if (requestedMedia && !mediaAsset)
          throw new NotFoundException({
            code: 'CRM_MEDIA_ASSET_NOT_FOUND',
            message: 'CRM media asset was not found',
          });
        if (!dto.text && !mediaAsset && !structured && !richMessage)
          throw new ConflictException({
            code: 'CRM_OUTBOUND_CONTENT_REQUIRED',
            message: 'Text or media is required',
          });
        let inlineKeyboard: TelegramInlineKeyboard | undefined;
        if (dto.inlineKeyboard !== undefined)
          try {
            inlineKeyboard = validateTelegramInlineKeyboard(dto.inlineKeyboard);
          } catch {
            throw new ConflictException({
              code: 'CRM_INLINE_KEYBOARD_INVALID',
              message: 'Inline keyboard is invalid',
            });
          }
        let replyMarkup: TelegramReplyMarkup | undefined;
        if (dto.replyMarkup !== undefined)
          try {
            replyMarkup = validateTelegramReplyMarkup(dto.replyMarkup);
          } catch {
            throw new ConflictException({
              code: 'CRM_REPLY_MARKUP_INVALID',
              message: 'Reply markup is invalid',
            });
          }
        let entities: TelegramMessageEntity[] | undefined;
        if (dto.entities !== undefined)
          try {
            entities = validateTelegramMessageEntities(
              dto.entities,
              dto.text ?? (dto.media ? '' : ''),
            );
          } catch {
            throw new ConflictException({
              code: 'CRM_MESSAGE_ENTITIES_INVALID',
              message: 'Message entities are invalid',
            });
          }
        let linkPreviewOptions: TelegramLinkPreviewOptions | undefined;
        if (dto.linkPreviewOptions !== undefined)
          try {
            linkPreviewOptions = validateTelegramLinkPreviewOptions(dto.linkPreviewOptions);
          } catch {
            throw new ConflictException({
              code: 'CRM_LINK_PREVIEW_OPTIONS_INVALID',
              message: 'Link preview options are invalid',
            });
          }
        let providerReplyMessageId: string | undefined;
        if (dto.replyToMessageId) {
          const reply = await transaction.message.findFirst({
            select: { externalMessageId: true },
            where: {
              connectionId: identity.connectionId,
              conversationId: conversation.id,
              externalMessageId: { not: null },
              id: dto.replyToMessageId,
              projectId: dto.omnicusProjectId,
            },
          });
          if (!reply?.externalMessageId)
            throw new NotFoundException({
              code: 'CRM_REPLY_MESSAGE_NOT_FOUND',
              message: 'Reply target was not found',
            });
          providerReplyMessageId = reply.externalMessageId;
        }
        const message = await transaction.message.create({
          data: {
            connectionId: identity.connectionId,
            contactId: identity.contactId,
            content: (richMessage
              ? {
                  richMessage: {
                    ...(richMessage.isRtl ? { isRtl: true } : {}),
                    markdown: richMessage.markdown,
                    ...(richMedia ? { media: { id: richMedia.id, kind: richMedia.kind } } : {}),
                    ...(richMessage.skipEntityDetection ? { skipEntityDetection: true } : {}),
                  },
                }
              : structured
                ? { structured }
                : mediaAsset
                  ? {
                      caption: ['STICKER', 'VIDEO_NOTE'].includes(dto.media?.kind ?? '')
                        ? ''
                        : (dto.text ?? ''),
                      ...(inlineKeyboard ? { inlineKeyboard } : {}),
                    }
                  : {
                      text: dto.text!,
                      ...(inlineKeyboard ? { inlineKeyboard } : {}),
                    }) as unknown as Prisma.InputJsonValue,
            conversationId: conversation.id,
            direction: 'OUTBOUND',
            mediaAssetId: mediaAsset?.id ?? null,
            metadata: {
              channel: dto.identity.channel,
              disableNotification: dto.disableNotification ?? false,
              ...(dto.media?.durationSeconds === undefined
                ? {}
                : { durationSeconds: dto.media.durationSeconds }),
              ...(entities ? { entities } : {}),
              ...(dto.hasSpoiler ? { hasSpoiler: true } : {}),
              ...(inlineKeyboard ? { inlineKeyboard } : {}),
              ...(replyMarkup ? { replyMarkup } : {}),
              ...(linkPreviewOptions ? { linkPreviewOptions } : {}),
              ...(dto.messageEffectId ? { messageEffectId: dto.messageEffectId } : {}),
              protectContent: dto.protectContent ?? false,
              ...(dto.replyToMessageId ? { replyToOmnicusMessageId: dto.replyToMessageId } : {}),
              replyToMessageId: providerReplyMessageId ?? null,
              ...(dto.quote ? { quote: dto.quote } : {}),
              ...(dto.quotePosition === undefined ? {} : { quotePosition: dto.quotePosition }),
              ...(requestContext.actorUserId ? { actorUserId: requestContext.actorUserId } : {}),
              source,
            } as unknown as Prisma.InputJsonValue,
            projectId: dto.omnicusProjectId,
            status: 'QUEUED',
            type:
              structured?.type === 'contact'
                ? 'CONTACT'
                : structured?.type === 'location'
                  ? 'LOCATION'
                  : structured?.type === 'poll'
                    ? 'POLL'
                    : richMessage
                      ? 'RICH'
                      : (dto.media?.kind ?? 'TEXT'),
          },
        });
        const outbox = await transaction.outboxRecord.create({
          data: {
            connectionId: identity.connectionId,
            idempotencyKey: storedKey,
            kind: providerKind,
            nextAttemptAt: schedule?.scheduledAt ?? new Date(),
            payload: { channelIdentityId: identity.id, messageId: message.id },
            projectId: dto.omnicusProjectId,
          },
        });
        const scheduledMessage = schedule
          ? await transaction.scheduledMessage.create({
              data: {
                channelIdentityId: identity.id,
                connectionId: identity.connectionId,
                contactId: identity.contactId,
                messageId: message.id,
                occurrence: 1,
                outboxRecordId: outbox.id,
                projectId: dto.omnicusProjectId,
                request: {
                  kind: richMessage ? 'RICH' : (dto.media?.kind ?? 'TEXT'),
                  ...(dto.text ? { text: dto.text } : {}),
                },
                ...(schedule.recurrence ? { recurrence: schedule.recurrence } : {}),
                scheduledAt: schedule.scheduledAt,
                seriesId: outbox.id,
                timezone: schedule.timezone,
              },
            })
          : undefined;
        await transaction.idempotencyRecord.create({
          data: {
            key: idempotencyKey,
            projectId: dto.omnicusProjectId,
            scope: idempotencyScope,
          },
        });
        await transaction.auditLog.create({
          data: {
            action:
              source === 'omnicus'
                ? 'communications.outbound_message.queued'
                : 'crm.outbound_message.queued',
            actorEmailSnapshot: requestContext.actorEmail ?? null,
            actorType: source === 'omnicus' ? 'USER' : 'SERVICE',
            actorUserId: requestContext.actorUserId ?? null,
            afterSafeJson: {
              connectionId: identity.connectionId,
              ...(source === 'crm' ? { crmProjectId: dto.crmProjectId } : { source }),
            },
            correlationId,
            entityId: outbox.id,
            entityType: 'OutboxRecord',
            projectId: dto.omnicusProjectId,
            projectNameSnapshot: project.name,
            projectSlugSnapshot: project.slug,
            purgeAfter: new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000),
          },
        });
        return {
          ...(scheduledMessage
            ? {
                channelIdentityId: identity.id,
                connectionId: identity.connectionId,
                crmLeadId: contact.crmLeadId,
                omnicusContactId: identity.contactId,
              }
            : {}),
          messageId: message.id,
          operationId: outbox.id,
          ...(scheduledMessage ? { scheduleId: scheduledMessage.id } : {}),
          status: 'QUEUED' as const,
        };
      });
    } catch (error) {
      if (!this.isUniqueConstraint(error)) throw error;
      const replay = await this.existing(dto.omnicusProjectId, storedKey);
      if (!replay) throw error;
      return { ...replay, replayed: true };
    }

    try {
      if (!schedule) await this.outboundQueue.enqueue(result.operationId);
    } catch {
      this.logger.warn({
        message: 'crm_outbound_enqueue_failed',
        operationId: result.operationId,
        projectId: dto.omnicusProjectId,
      });
    }
    return { ...result, replayed: false };
  }

  async scheduled(
    scheduleId: string,
    query: CrmScheduledMessageQueryDto,
    authenticatedProjectId?: string,
  ) {
    await this.assertProjectRoute(
      query.crmProjectId,
      query.omnicusProjectId,
      authenticatedProjectId,
    );
    const schedule = await this.database.client.scheduledMessage.findFirst({
      select: {
        cancelledAt: true,
        channelIdentityId: true,
        completedAt: true,
        connectionId: true,
        contact: { select: { crmLeadId: true } },
        contactId: true,
        id: true,
        messageId: true,
        occurrence: true,
        outboxRecordId: true,
        recurrence: true,
        revision: true,
        scheduledAt: true,
        seriesId: true,
        status: true,
        timezone: true,
      },
      where: { id: scheduleId, ...this.scheduleScope(query) },
    });
    if (!schedule) throw new NotFoundException({ code: 'CRM_SCHEDULE_NOT_FOUND' });
    return this.scheduleResponse(schedule);
  }

  async scheduledList(query: CrmScheduledMessageQueryDto, authenticatedProjectId?: string) {
    await this.assertProjectRoute(
      query.crmProjectId,
      query.omnicusProjectId,
      authenticatedProjectId,
    );
    const schedules = await this.database.client.scheduledMessage.findMany({
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
      select: {
        cancelledAt: true,
        channelIdentityId: true,
        completedAt: true,
        connectionId: true,
        contact: { select: { crmLeadId: true } },
        contactId: true,
        id: true,
        messageId: true,
        occurrence: true,
        outboxRecordId: true,
        recurrence: true,
        revision: true,
        scheduledAt: true,
        seriesId: true,
        status: true,
        timezone: true,
      },
      take: 100,
      where: this.scheduleScope(query),
    });
    return schedules.map((schedule) => this.scheduleResponse(schedule));
  }

  async updateScheduled(
    scheduleId: string,
    dto: CrmScheduledMessageUpdateDto,
    query: CrmScheduledMessageQueryDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: string,
  ) {
    await this.assertProjectRoute(
      query.crmProjectId,
      query.omnicusProjectId,
      authenticatedProjectId,
    );
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;
    if (scheduledAt && (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()))
      throw new ConflictException({ code: 'CRM_SCHEDULE_TIME_INVALID' });
    const recurrence =
      dto.recurrence === undefined
        ? undefined
        : dto.recurrence === null
          ? null
          : this.recurrence(dto.recurrence);
    const request = {
      expectedRevision: dto.expectedRevision,
      recurrence: recurrence ?? null,
      recurrenceMode: recurrence === undefined ? 'PRESERVE' : recurrence === null ? 'CLEAR' : 'SET',
      scheduleId,
      scheduledAt: scheduledAt?.toISOString() ?? null,
    };
    const existing = await this.database.client.idempotencyRecord.findUnique({
      where: {
        projectId_scope_key: {
          key: idempotencyKey,
          projectId: query.omnicusProjectId,
          scope: 'crm-scheduled-update',
        },
      },
    });
    if (existing) {
      const replay = this.scheduledUpdateReplay(existing.resultSafe);
      if (!replay || JSON.stringify(replay.request) !== JSON.stringify(request))
        throw new ConflictException({ code: 'CRM_SCHEDULE_IDEMPOTENCY_CONFLICT' });
      return { ...replay.response, replayed: true };
    }
    return this.database.client.$transaction(async (transaction) => {
      const schedule = await transaction.scheduledMessage.findFirst({
        include: { contact: { select: { crmLeadId: true } } },
        where: { id: scheduleId, ...this.scheduleScope(query) },
      });
      if (!schedule) throw new NotFoundException({ code: 'CRM_SCHEDULE_NOT_FOUND' });
      if (schedule.status !== 'QUEUED')
        throw new ConflictException({ code: 'CRM_SCHEDULE_ALREADY_PROCESSING' });
      if (schedule.revision !== dto.expectedRevision)
        throw new ConflictException({ code: 'CRM_SCHEDULE_REVISION_CONFLICT' });
      const nextAt = scheduledAt ?? schedule.scheduledAt;
      const effectiveRecurrence = recurrence === undefined ? schedule.recurrence : recurrence;
      const outbox = await transaction.outboxRecord.findUnique({
        select: { kind: true },
        where: {
          projectId_id: {
            id: schedule.outboxRecordId,
            projectId: query.omnicusProjectId,
          },
        },
      });
      if (outbox?.kind === 'WHATSAPP' && effectiveRecurrence)
        throw new ConflictException({ code: 'WHATSAPP_RECURRING_SCHEDULE_UNSUPPORTED' });
      if (
        effectiveRecurrence &&
        typeof effectiveRecurrence === 'object' &&
        !Array.isArray(effectiveRecurrence)
      ) {
        const rule = effectiveRecurrence as Prisma.JsonObject;
        if (
          (typeof rule.until === 'string' && Date.parse(rule.until) <= nextAt.getTime()) ||
          (typeof rule.count === 'number' && rule.count < schedule.occurrence)
        )
          throw new ConflictException({ code: 'CRM_RECURRENCE_END_INVALID' });
      }
      const changed = await transaction.scheduledMessage.updateMany({
        data: {
          ...(recurrence === undefined
            ? {}
            : { recurrence: recurrence === null ? Prisma.DbNull : recurrence }),
          ...(scheduledAt ? { scheduledAt } : {}),
          revision: { increment: 1 },
        },
        where: {
          id: schedule.id,
          projectId: query.omnicusProjectId,
          revision: dto.expectedRevision,
          status: 'QUEUED',
        },
      });
      if (changed.count !== 1)
        throw new ConflictException({ code: 'CRM_SCHEDULE_REVISION_CONFLICT' });
      await transaction.outboxRecord.updateMany({
        data: { nextAttemptAt: nextAt },
        where: {
          id: schedule.outboxRecordId,
          projectId: query.omnicusProjectId,
          status: 'PENDING',
        },
      });
      const updated = await transaction.scheduledMessage.findUniqueOrThrow({
        include: { contact: { select: { crmLeadId: true } } },
        where: {
          projectId_id: { id: schedule.id, projectId: query.omnicusProjectId },
        },
      });
      const response = this.scheduleResponse(updated);
      const storedResponse = JSON.parse(JSON.stringify(response)) as Prisma.InputJsonObject;
      await transaction.idempotencyRecord.create({
        data: {
          key: idempotencyKey,
          projectId: query.omnicusProjectId,
          resultSafe: { request, response: storedResponse },
          scope: 'crm-scheduled-update',
        },
      });
      await transaction.auditLog.create({
        data: {
          action: 'crm.scheduled_message.updated',
          actorType: 'SERVICE',
          afterSafeJson: {
            recurrence: recurrence ?? null,
            revision: response.revision,
            scheduledAt: response.scheduledAt,
          },
          correlationId,
          entityId: schedule.id,
          entityType: 'ScheduledMessage',
          projectId: query.omnicusProjectId,
          projectNameSnapshot: null,
          projectSlugSnapshot: null,
          purgeAfter: new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000),
        },
      });
      return { ...response, replayed: false };
    });
  }

  async cancelScheduled(
    scheduleId: string,
    query: CrmScheduledMessageQueryDto,
    authenticatedProjectId?: string,
  ) {
    await this.assertProjectRoute(
      query.crmProjectId,
      query.omnicusProjectId,
      authenticatedProjectId,
    );
    return this.database.client.$transaction(async (transaction) => {
      const schedule = await transaction.scheduledMessage.findFirst({
        include: { contact: { select: { crmLeadId: true } } },
        where: { id: scheduleId, ...this.scheduleScope(query) },
      });
      if (!schedule) throw new NotFoundException({ code: 'CRM_SCHEDULE_NOT_FOUND' });
      if (schedule.status === 'CANCELLED')
        return {
          ...this.scheduleRouting(schedule),
          id: schedule.id,
          replayed: true,
          status: 'CANCELLED' as const,
        };
      if (schedule.status !== 'QUEUED')
        throw new ConflictException({ code: 'CRM_SCHEDULE_NOT_CANCELLABLE' });
      const cancelled = await transaction.scheduledMessage.updateMany({
        data: { cancelledAt: new Date(), status: 'CANCELLED' },
        where: { id: schedule.id, projectId: query.omnicusProjectId, status: 'QUEUED' },
      });
      if (cancelled.count !== 1)
        throw new ConflictException({ code: 'CRM_SCHEDULE_NOT_CANCELLABLE' });
      await transaction.outboxRecord.updateMany({
        data: {
          completedAt: new Date(),
          lastError: 'scheduled_message_cancelled',
          nextAttemptAt: null,
          status: 'FAILED',
        },
        where: {
          id: schedule.outboxRecordId,
          projectId: query.omnicusProjectId,
          status: 'PENDING',
        },
      });
      await transaction.message.updateMany({
        data: { failedAt: new Date(), status: 'FAILED' },
        where: { id: schedule.messageId, projectId: query.omnicusProjectId, status: 'QUEUED' },
      });
      return {
        ...this.scheduleRouting(schedule),
        id: schedule.id,
        replayed: false,
        status: 'CANCELLED' as const,
      };
    });
  }

  async status(
    operationId: string,
    crmProjectId: string,
    omnicusProjectId: string,
    authenticatedProjectId?: string,
  ): Promise<CrmOutboundStatusResult> {
    const project = await this.database.client.project.findUnique({
      include: { crmConfig: true },
      where: { id: omnicusProjectId },
    });
    if (
      (authenticatedProjectId !== undefined && authenticatedProjectId !== omnicusProjectId) ||
      !project?.crmConfig?.enabled ||
      project.crmConfig.crmProjectId !== crmProjectId
    )
      throw new NotFoundException({
        code: 'CRM_PROJECT_ROUTE_NOT_FOUND',
        message: 'CRM project route was not found',
      });
    const outbox = await this.database.client.outboxRecord.findUnique({
      where: { projectId_id: { id: operationId, projectId: omnicusProjectId } },
    });
    if (!outbox || !['TELEGRAM', 'WHATSAPP'].includes(outbox.kind))
      throw new NotFoundException({
        code: 'CRM_OUTBOUND_OPERATION_NOT_FOUND',
        message: 'CRM outbound operation was not found',
      });
    const mediaGroupId = (outbox.payload as { mediaGroupId?: unknown }).mediaGroupId;
    if (typeof mediaGroupId === 'string') {
      const group = await this.database.client.telegramMediaGroup.findUnique({
        where: { projectId_id: { id: mediaGroupId, projectId: omnicusProjectId } },
      });
      if (!group) throw new NotFoundException({ code: 'CRM_MEDIA_GROUP_NOT_FOUND' });
      return {
        ...(outbox.lastError ? { errorCode: outbox.lastError } : {}),
        messageId: group.id,
        operationId,
        status:
          group.status === 'SENT'
            ? 'SENT'
            : group.status === 'PROCESSING'
              ? 'PROCESSING'
              : group.status,
      } as CrmOutboundStatusResult;
    }
    const messageId = (outbox.payload as { messageId?: unknown }).messageId;
    if (typeof messageId !== 'string')
      throw new NotFoundException({
        code: 'CRM_OUTBOUND_OPERATION_NOT_FOUND',
        message: 'CRM outbound operation was not found',
      });
    const message = await this.database.client.message.findUnique({
      select: { status: true },
      where: { projectId_id: { id: messageId, projectId: omnicusProjectId } },
    });
    if (!message)
      throw new NotFoundException({
        code: 'CRM_OUTBOUND_MESSAGE_NOT_FOUND',
        message: 'CRM outbound message was not found',
      });
    const action = (outbox.payload as { action?: unknown }).action;
    const isRetry =
      typeof (outbox.payload as { retryOfOperationId?: unknown }).retryOfOperationId === 'string';
    const isMessageMutation =
      typeof action === 'string' &&
      ['DELETE_MESSAGE', 'EDIT_MESSAGE', 'MARK_READ', 'PIN_MESSAGE', 'SET_REACTION'].includes(
        action,
      );
    const status =
      outbox.status === 'FAILED' || (!isRetry && !isMessageMutation && message.status === 'FAILED')
        ? 'FAILED'
        : outbox.status === 'UNKNOWN' ||
            (!isRetry && !isMessageMutation && message.status === 'UNKNOWN')
          ? 'UNKNOWN'
          : outbox.status === 'SUCCEEDED' && isMessageMutation
            ? 'SUCCEEDED'
            : outbox.status === 'SUCCEEDED' &&
                ['SENT', 'DELIVERED', 'READ', 'DELETED'].includes(message.status)
              ? 'SENT'
              : outbox.status === 'PROCESSING' ||
                  (!isRetry && !isMessageMutation && message.status === 'PROCESSING')
                ? 'PROCESSING'
                : 'QUEUED';
    return {
      ...(outbox.lastError ? { errorCode: outbox.lastError } : {}),
      messageId,
      operationId,
      status,
    };
  }

  async operationKind(
    operationId: string,
    crmProjectId: string,
    omnicusProjectId: string,
    authenticatedProjectId?: string,
  ): Promise<'TELEGRAM' | 'WHATSAPP'> {
    await this.assertProjectRoute(crmProjectId, omnicusProjectId, authenticatedProjectId);
    const outbox = await this.database.client.outboxRecord.findUnique({
      select: { kind: true },
      where: { projectId_id: { id: operationId, projectId: omnicusProjectId } },
    });
    if (!outbox || !['TELEGRAM', 'WHATSAPP'].includes(outbox.kind))
      throw new NotFoundException({
        code: 'CRM_OUTBOUND_OPERATION_NOT_FOUND',
        message: 'CRM outbound operation was not found',
      });
    return outbox.kind as 'TELEGRAM' | 'WHATSAPP';
  }

  private async existing(
    projectId: string,
    storedKey: string,
  ): Promise<Omit<CrmOutboundQueuedResult, 'replayed'> | undefined> {
    const record = await this.database.client.outboxRecord.findUnique({
      where: { projectId_idempotencyKey: { idempotencyKey: storedKey, projectId } },
    });
    if (!record) return undefined;
    const messageId = (record.payload as { messageId?: unknown }).messageId;
    if (typeof messageId !== 'string')
      throw new ConflictException({
        code: 'CRM_IDEMPOTENCY_RECORD_INVALID',
        message: 'CRM idempotency record is invalid',
      });
    const schedule = await this.database.client.scheduledMessage.findUnique({
      select: {
        channelIdentityId: true,
        connectionId: true,
        contact: { select: { crmLeadId: true } },
        contactId: true,
        id: true,
      },
      where: {
        projectId_outboxRecordId: { outboxRecordId: record.id, projectId },
      },
    });
    return {
      ...(schedule ? this.scheduleRouting(schedule) : {}),
      messageId,
      operationId: record.id,
      ...(schedule ? { scheduleId: schedule.id } : {}),
      status: 'QUEUED',
    };
  }

  private scheduleScope(query: CrmScheduledMessageQueryDto): Prisma.ScheduledMessageWhereInput {
    return {
      connectionId: query.connectionId,
      contactId: query.omnicusContactId,
      projectId: query.omnicusProjectId,
      ...(query.channelIdentityId ? { channelIdentityId: query.channelIdentityId } : {}),
      ...(query.crmLeadId ? { contact: { crmLeadId: query.crmLeadId } } : {}),
    };
  }

  private scheduledUpdateReplay(value: Prisma.JsonValue | null | undefined):
    | {
        request: {
          expectedRevision: number;
          recurrence: Prisma.JsonValue;
          recurrenceMode: 'CLEAR' | 'PRESERVE' | 'SET';
          scheduleId: string;
          scheduledAt: string | null;
        };
        response: Record<string, unknown>;
      }
    | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const stored = value as Prisma.JsonObject;
    if (
      !stored.request ||
      typeof stored.request !== 'object' ||
      Array.isArray(stored.request) ||
      !stored.response ||
      typeof stored.response !== 'object' ||
      Array.isArray(stored.response)
    )
      return undefined;
    return stored as unknown as {
      request: {
        expectedRevision: number;
        recurrence: Prisma.JsonValue;
        recurrenceMode: 'CLEAR' | 'PRESERVE' | 'SET';
        scheduleId: string;
        scheduledAt: string | null;
      };
      response: Record<string, unknown>;
    };
  }

  private scheduleRouting(schedule: {
    channelIdentityId: string;
    connectionId: string;
    contact: { crmLeadId: string | null };
    contactId: string;
  }) {
    return {
      channelIdentityId: schedule.channelIdentityId,
      connectionId: schedule.connectionId,
      crmLeadId: schedule.contact.crmLeadId,
      omnicusContactId: schedule.contactId,
    };
  }

  private scheduleResponse<T extends Parameters<CrmOutboundService['scheduleRouting']>[0]>(
    schedule: T,
  ) {
    const safe = { ...schedule };
    Reflect.deleteProperty(safe, 'contact');
    Reflect.deleteProperty(safe, 'contactId');
    return { ...safe, ...this.scheduleRouting(schedule) };
  }

  private isUniqueConstraint(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private recurrence(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject | undefined {
    if (!value) return undefined;
    if (
      Object.keys(value).some(
        (key) => !['count', 'frequency', 'interval', 'until'].includes(key),
      ) ||
      !['DAILY', 'WEEKLY'].includes(String(value.frequency)) ||
      !Number.isInteger(value.interval) ||
      Number(value.interval) < 1 ||
      Number(value.interval) > 30 ||
      (value.count !== undefined &&
        (!Number.isInteger(value.count) ||
          Number(value.count) < 2 ||
          Number(value.count) > 1_000)) ||
      (value.until !== undefined &&
        (typeof value.until !== 'string' ||
          Number.isNaN(Date.parse(value.until)) ||
          Date.parse(value.until) <= Date.now())) ||
      (value.count === undefined && value.until === undefined)
    )
      throw new ConflictException({ code: 'CRM_RECURRENCE_INVALID' });
    return {
      ...(typeof value.count === 'number' ? { count: value.count } : {}),
      frequency: String(value.frequency),
      interval: Number(value.interval),
      ...(typeof value.until === 'string' ? { until: new Date(value.until).toISOString() } : {}),
    };
  }

  private richMessage(value: Record<string, unknown> | undefined):
    | {
        isRtl?: boolean;
        markdown: string;
        media?: {
          id: string;
          kind: 'ANIMATION' | 'AUDIO' | 'PHOTO' | 'VIDEO' | 'VOICE';
          mediaAssetId: string;
        };
        skipEntityDetection?: boolean;
      }
    | undefined {
    if (!value) return undefined;
    if (
      Object.keys(value).some(
        (key) => !['isRtl', 'markdown', 'media', 'skipEntityDetection'].includes(key),
      ) ||
      typeof value.markdown !== 'string' ||
      value.markdown.length < 1 ||
      Buffer.byteLength(value.markdown, 'utf8') > 32_768 ||
      (value.isRtl !== undefined && typeof value.isRtl !== 'boolean') ||
      (value.skipEntityDetection !== undefined && typeof value.skipEntityDetection !== 'boolean') ||
      /!\[[^\]]*\]\(https?:\/\//i.test(value.markdown) ||
      /<(?:audio|img|video)\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(value.markdown)
    )
      throw new ConflictException({ code: 'CRM_RICH_MESSAGE_INVALID' });
    let media:
      | {
          id: string;
          kind: 'ANIMATION' | 'AUDIO' | 'PHOTO' | 'VIDEO' | 'VOICE';
          mediaAssetId: string;
        }
      | undefined;
    if (value.media !== undefined) {
      if (!value.media || typeof value.media !== 'object' || Array.isArray(value.media))
        throw new ConflictException({ code: 'CRM_RICH_MESSAGE_MEDIA_INVALID' });
      const candidate = value.media as Record<string, unknown>;
      if (
        Object.keys(candidate).some((key) => !['id', 'kind', 'mediaAssetId'].includes(key)) ||
        typeof candidate.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(candidate.id) ||
        typeof candidate.kind !== 'string' ||
        !['ANIMATION', 'AUDIO', 'PHOTO', 'VIDEO', 'VOICE'].includes(candidate.kind) ||
        typeof candidate.mediaAssetId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          candidate.mediaAssetId,
        )
      )
        throw new ConflictException({ code: 'CRM_RICH_MESSAGE_MEDIA_INVALID' });
      const scheme =
        candidate.kind === 'PHOTO'
          ? 'photo'
          : candidate.kind === 'VIDEO' || candidate.kind === 'ANIMATION'
            ? 'video'
            : 'audio';
      if (!value.markdown.includes(`tg://${scheme}?id=${candidate.id}`))
        throw new ConflictException({ code: 'CRM_RICH_MESSAGE_MEDIA_REFERENCE_MISSING' });
      media = candidate as typeof media;
    }
    return {
      ...(value.isRtl === true ? { isRtl: true } : {}),
      markdown: value.markdown,
      ...(media ? { media } : {}),
      ...(value.skipEntityDetection === true ? { skipEntityDetection: true } : {}),
    };
  }

  private structured(value: Record<string, unknown> | undefined):
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
      }
    | undefined {
    if (!value) return undefined;
    if (
      value.type === 'contact' &&
      typeof value.firstName === 'string' &&
      value.firstName.length > 0 &&
      value.firstName.length <= 64 &&
      typeof value.phoneNumber === 'string' &&
      value.phoneNumber.length > 0 &&
      value.phoneNumber.length <= 64
    )
      return {
        firstName: value.firstName,
        phoneNumber: value.phoneNumber,
        type: 'contact',
        ...(typeof value.lastName === 'string' ? { lastName: value.lastName } : {}),
        ...(typeof value.vcard === 'string' ? { vcard: value.vcard } : {}),
      };
    if (
      value.type === 'location' &&
      typeof value.latitude === 'number' &&
      value.latitude >= -90 &&
      value.latitude <= 90 &&
      typeof value.longitude === 'number' &&
      value.longitude >= -180 &&
      value.longitude <= 180
    )
      return {
        latitude: value.latitude,
        longitude: value.longitude,
        type: 'location',
        ...(typeof value.horizontalAccuracy === 'number'
          ? { horizontalAccuracy: value.horizontalAccuracy }
          : {}),
      };
    if (
      value.type === 'poll' &&
      typeof value.question === 'string' &&
      value.question.length > 0 &&
      value.question.length <= 300 &&
      Array.isArray(value.options) &&
      value.options.length >= 2 &&
      value.options.length <= 12 &&
      value.options.every(
        (option) => typeof option === 'string' && option.length > 0 && option.length <= 100,
      )
    )
      return {
        options: value.options as string[],
        question: value.question,
        type: 'poll',
        ...(typeof value.allowsMultipleAnswers === 'boolean'
          ? { allowsMultipleAnswers: value.allowsMultipleAnswers }
          : {}),
        ...(typeof value.isAnonymous === 'boolean' ? { isAnonymous: value.isAnonymous } : {}),
      };
    throw new ConflictException({ code: 'CRM_STRUCTURED_MESSAGE_INVALID' });
  }
}
