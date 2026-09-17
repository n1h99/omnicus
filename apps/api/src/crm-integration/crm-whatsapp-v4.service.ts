import { createHash } from 'node:crypto';

import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assertWhatsAppTemplateComponents,
  whatsAppTemplateDisabledReason,
} from '@omnicus/channel-whatsapp';
import type { ApiEnvironment } from '@omnicus/config/server';
import { Prisma } from '@omnicus/database';

import { WhatsAppOutboundQueueService } from '../channels/whatsapp-outbound-queue.service';
import { DatabaseService } from '../database/database.service';
import type {
  CrmAutomationStateDto,
  CrmAutomationStateQueryDto,
  CrmCapabilitiesQueryDto,
  CrmOutboundMessageDto,
  CrmReactionDto,
  CrmRetryOperationDto,
  CrmTelegramScopeDto,
  CrmWhatsAppTemplateQueryDto,
} from './dto';
import type { OutboundRequestContext } from './crm-outbound.service';

interface WhatsAppRoute {
  connectionId: string;
  contactId: string;
  externalUserId: string;
  graphApiVersion: string;
  identityId: string;
  projectId: string;
}

export interface CrmWhatsAppQueuedResult {
  messageId: string;
  operationId: string;
  replayed: boolean;
  status: 'QUEUED';
}

type JsonObject = Record<string, unknown>;

@Injectable()
export class CrmWhatsAppV4Service {
  private readonly logger = new Logger(CrmWhatsAppV4Service.name);
  private readonly maximumUploadBytes: number;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(WhatsAppOutboundQueueService)
    private readonly outboundQueue: WhatsAppOutboundQueueService,
    @Inject(ConfigService) config: ConfigService<ApiEnvironment, true>,
  ) {
    this.maximumUploadBytes = config.get('MEDIA_MAX_UPLOAD_BYTES', { infer: true });
  }

  async capabilities(
    query: CrmCapabilitiesQueryDto,
    authenticatedProjectId?: string,
    requestContext: OutboundRequestContext = {},
  ) {
    await this.assertProject(
      query.crmProjectId,
      query.omnicusProjectId,
      authenticatedProjectId,
      requestContext,
    );
    const connection = await this.database.client.channelConnection.findUnique({
      where: {
        projectId_id: { id: query.connectionId, projectId: query.omnicusProjectId },
      },
    });
    if (!connection || connection.type !== 'WHATSAPP')
      throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
    const metadata = this.object(connection.webhookMetadata) ?? {};
    const graphApiVersion = this.nonEmptyString(metadata.graphApiVersion);
    if (!graphApiVersion)
      throw new ConflictException({ code: 'WHATSAPP_CONFIGURATION_INCOMPLETE' });

    let lastInboundAt: Date | null = null;
    let expiresAt: Date | null = null;
    if (query.channelIdentityId || query.omnicusContactId) {
      const identity = query.channelIdentityId
        ? await this.database.client.channelIdentity.findUnique({
            where: {
              projectId_id: {
                id: query.channelIdentityId,
                projectId: query.omnicusProjectId,
              },
            },
          })
        : await this.database.client.channelIdentity.findFirst({
            where: {
              channel: 'WHATSAPP',
              connectionId: query.connectionId,
              ...(query.omnicusContactId ? { contactId: query.omnicusContactId } : {}),
              projectId: query.omnicusProjectId,
            },
          });
      if (
        !identity ||
        identity.channel !== 'WHATSAPP' ||
        identity.connectionId !== query.connectionId ||
        (query.omnicusContactId && identity.contactId !== query.omnicusContactId)
      )
        throw new NotFoundException({ code: 'CHANNEL_IDENTITY_NOT_FOUND' });
      const conversation = await this.database.client.conversation.findUnique({
        select: { lastInboundAt: true, serviceWindowExpiresAt: true },
        where: {
          projectId_connectionId_externalChatId: {
            connectionId: identity.connectionId,
            externalChatId: identity.externalUserId,
            projectId: query.omnicusProjectId,
          },
        },
      });
      lastInboundAt = conversation?.lastInboundAt ?? null;
      expiresAt = conversation?.serviceWindowExpiresAt ?? null;
    }

    const unavailable = connection.status !== 'ACTIVE';
    const supported = (limits?: Record<string, unknown>) => ({
      supported: !unavailable,
      ...(unavailable ? { reasonCode: 'CONNECTION_NOT_ACTIVE' } : {}),
      ...(limits ? { limits } : {}),
    });
    const unsupported = (reasonCode: string) => ({ reasonCode, supported: false });
    const crmUploadCeiling = 20 * 1024 * 1024;
    const effectiveDocumentBytes = Math.min(
      this.maximumUploadBytes,
      crmUploadCeiling,
      100 * 1024 * 1024,
    );
    const effectiveAudioVideoBytes = Math.min(
      this.maximumUploadBytes,
      crmUploadCeiling,
      16 * 1024 * 1024,
    );
    const effectiveImageBytes = Math.min(
      this.maximumUploadBytes,
      crmUploadCeiling,
      5 * 1024 * 1024,
    );
    const effectiveStickerBytes = Math.min(this.maximumUploadBytes, crmUploadCeiling, 100 * 1024);
    const state =
      !query.channelIdentityId && !query.omnicusContactId
        ? 'UNKNOWN'
        : expiresAt && expiresAt > new Date()
          ? 'OPEN'
          : 'CLOSED';
    return {
      capabilities: {
        automationManualMode: supported(),
        automationPausedMode: supported({
          optimisticConcurrency: 'revision',
          requiresResumeAt: true,
        }),
        botInterface: unsupported('WHATSAPP_BOT_INTERFACE_UNSUPPORTED'),
        chatActions: unsupported('WHATSAPP_CHAT_ACTIONS_UNSUPPORTED'),
        deleteMessage: unsupported('WHATSAPP_DELETE_UNSUPPORTED'),
        editMessage: unsupported('WHATSAPP_EDIT_UNSUPPORTED'),
        explicitRetry: supported({ statuses: ['FAILED'] }),
        externalActions: unsupported('EXTERNAL_ACTIONS_NOT_RELEASED'),
        externalDeletionEvents: unsupported('WHATSAPP_DELETE_EVENTS_UNSUPPORTED'),
        formattingEntities: unsupported('WHATSAPP_FORMATTING_ENTITIES_UNSUPPORTED'),
        inlineKeyboard: unsupported('WHATSAPP_INLINE_KEYBOARD_UNSUPPORTED'),
        interactiveMessages: supported({
          buttonCount: { maximum: 3, minimum: 1 },
          listRows: { maximum: 10, minimum: 1 },
          types: ['button', 'list'],
        }),
        linkPreviewOptions: supported({ modes: ['enabled', 'disabled'] }),
        markMessageRead: supported({ durable: true, idempotent: true }),
        mediaGroups: unsupported('WHATSAPP_MEDIA_GROUPS_UNSUPPORTED'),
        mediaSpoilers: unsupported('WHATSAPP_MEDIA_SPOILERS_UNSUPPORTED'),
        messageEffects: unsupported('WHATSAPP_MESSAGE_EFFECTS_UNSUPPORTED'),
        messageTemplates: supported({
          approvedOnly: true,
          categories: ['MARKETING', 'UTILITY'],
          parameterStyles: ['positional'],
          providerOwned: true,
        }),
        pinMessage: unsupported('WHATSAPP_PIN_UNSUPPORTED'),
        protectContent: unsupported('WHATSAPP_PROTECT_CONTENT_UNSUPPORTED'),
        quote: unsupported('WHATSAPP_QUOTE_UNSUPPORTED'),
        reactions: supported({ maximumBusinessReactions: 1, standardEmojiOnly: true }),
        replyKeyboard: unsupported('WHATSAPP_REPLY_KEYBOARD_UNSUPPORTED'),
        richMessages: unsupported('WHATSAPP_RICH_MESSAGES_UNSUPPORTED'),
        scheduling: supported({
          applicationOwned: true,
          frequencies: [],
          maximumCount: 1,
          maximumInterval: 1,
          optimisticConcurrency: 'revision',
          recurring: false,
          timezone: 'IANA',
        }),
        stickers: supported({
          animated: false,
          captions: false,
          formats: ['WEBP'],
          height: 512,
          maximumBytes: effectiveStickerBytes,
          width: 512,
        }),
        streamingDraft: unsupported('WHATSAPP_STREAMING_DRAFT_UNSUPPORTED'),
        structuredMessages: supported({ types: ['whatsapp_contact', 'whatsapp_location'] }),
        userReactionEvents: supported({ sameMessageBubble: true }),
      },
      channel: 'whatsapp' as const,
      contractVersion: '4.0.0' as const,
      mediaLimits: {
        audio: { maximumBytes: effectiveAudioVideoBytes },
        document: { maximumBytes: effectiveDocumentBytes },
        image: { maximumBytes: effectiveImageBytes },
        sticker: { maximumBytes: effectiveStickerBytes, staticOnly: true },
        video: { maximumBytes: effectiveAudioVideoBytes },
      },
      providerApiVersion: graphApiVersion,
      serviceWindow: {
        expiresAt: expiresAt?.toISOString() ?? null,
        lastUserMessageAt: lastInboundAt?.toISOString() ?? null,
        state,
      },
    };
  }

  async templates(
    query: CrmWhatsAppTemplateQueryDto,
    authenticatedProjectId?: string,
    requestContext: OutboundRequestContext = {},
  ) {
    await this.resolveIdentity(
      {
        crmProjectId: query.crmProjectId,
        identity: {
          channel: 'whatsapp',
          channelIdentityId: query.channelIdentityId,
          connectionId: query.connectionId,
        },
        omnicusContactId: query.omnicusContactId,
        omnicusProjectId: query.omnicusProjectId,
      },
      authenticatedProjectId,
      requestContext,
    );
    const data = await this.database.client.whatsAppMessageTemplate.findMany({
      orderBy: [{ name: 'asc' }, { languageCode: 'asc' }],
      select: {
        category: true,
        components: true,
        id: true,
        languageCode: true,
        name: true,
        status: true,
      },
      take: 2_000,
      where: {
        connectionId: query.connectionId,
        projectId: query.omnicusProjectId,
        ...(query.status ? { status: query.status } : {}),
      },
    });
    return {
      data: data.map((template) => ({
        ...template,
        components: this.crmTemplateComponents(template.components),
        ...this.templateAvailability(template),
      })),
    };
  }

  async queue(
    dto: CrmOutboundMessageDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: string,
    requestContext: OutboundRequestContext = {},
  ): Promise<CrmWhatsAppQueuedResult> {
    if ('scheduledAt' in dto)
      throw new ConflictException({ code: 'WHATSAPP_SCHEDULING_UNSUPPORTED' });
    this.assertNoTelegramOnlyFields(dto);
    const source = requestContext.source ?? 'crm';
    const route = await this.resolveIdentity(dto, authenticatedProjectId, requestContext);
    const contact = await this.database.client.contact.findUnique({
      select: { crmLeadId: true },
      where: { projectId_id: { id: route.contactId, projectId: route.projectId } },
    });
    if (!contact) throw new NotFoundException({ code: 'CRM_CONTACT_NOT_FOUND' });
    if (dto.crmLeadId && contact.crmLeadId && dto.crmLeadId !== contact.crmLeadId)
      throw new ConflictException({ code: 'CRM_LEAD_MAPPING_CONFLICT' });

    const normalizedTemplate = dto.template
      ? await this.normalizeTemplate(dto.template, route)
      : undefined;
    const normalizedInteractive = dto.interactive
      ? this.normalizeInteractive(dto.interactive)
      : undefined;
    const normalizedStructured = dto.structured
      ? this.normalizeStructured(dto.structured)
      : undefined;
    const contentKinds = [
      Boolean(dto.text || dto.media),
      Boolean(normalizedTemplate),
      Boolean(normalizedInteractive),
      Boolean(normalizedStructured),
    ].filter(Boolean).length;
    if (contentKinds !== 1) throw new ConflictException({ code: 'CRM_WHATSAPP_CONTENT_INVALID' });
    if (
      dto.media &&
      !['AUDIO', 'DOCUMENT', 'PHOTO', 'STICKER', 'VIDEO', 'VOICE'].includes(dto.media.kind)
    )
      throw new ConflictException({ code: 'CRM_WHATSAPP_MEDIA_KIND_UNSUPPORTED' });
    if (dto.media?.kind === 'STICKER' && dto.text)
      throw new ConflictException({ code: 'CRM_STICKER_CAPTION_UNSUPPORTED' });

    const requestHash = this.requestHash(dto);
    const storedKey = `${source === 'omnicus' ? 'omnicus' : 'crm'}-to-whatsapp-${idempotencyKey}`;
    const replay = await this.existing(route.projectId, storedKey, requestHash);
    if (replay) return { ...replay, replayed: true };

    let result: Omit<CrmWhatsAppQueuedResult, 'replayed'>;
    try {
      result = await this.database.client.$transaction(async (transaction) => {
        const conversation = await transaction.conversation.upsert({
          create: {
            connectionId: route.connectionId,
            contactId: route.contactId,
            externalChatId: route.externalUserId,
            projectId: route.projectId,
          },
          update: {},
          where: {
            projectId_connectionId_externalChatId: {
              connectionId: route.connectionId,
              externalChatId: route.externalUserId,
              projectId: route.projectId,
            },
          },
        });
        if (
          !normalizedTemplate &&
          (!conversation.serviceWindowExpiresAt ||
            conversation.serviceWindowExpiresAt <= new Date())
        )
          throw new ConflictException({
            code: 'CRM_WHATSAPP_TEMPLATE_REQUIRED',
            message: 'An approved WhatsApp template is required outside the service window',
          });
        const mediaAsset = dto.media
          ? await transaction.mediaAsset.findFirst({
              where: {
                id: dto.media.mediaAssetId,
                kind: dto.media.kind,
                projectId: route.projectId,
                status: 'AVAILABLE',
              },
            })
          : undefined;
        if (dto.media && !mediaAsset)
          throw new NotFoundException({ code: 'CRM_MEDIA_ASSET_NOT_FOUND' });
        if (mediaAsset && this.mediaValidationChannel(mediaAsset) !== 'whatsapp')
          throw new ConflictException({ code: 'CRM_WHATSAPP_MEDIA_VALIDATION_REQUIRED' });
        if (dto.replyToMessageId) {
          const target = await transaction.message.findFirst({
            select: { externalMessageId: true },
            where: {
              connectionId: route.connectionId,
              contactId: route.contactId,
              conversationId: conversation.id,
              externalMessageId: { not: null },
              id: dto.replyToMessageId,
              projectId: route.projectId,
            },
          });
          if (!target?.externalMessageId)
            throw new NotFoundException({ code: 'CRM_REPLY_MESSAGE_NOT_FOUND' });
        }
        const messageType = normalizedTemplate
          ? 'TEXT'
          : normalizedInteractive
            ? 'INTERACTIVE'
            : normalizedStructured?.type === 'whatsapp_contact'
              ? 'CONTACT'
              : normalizedStructured?.type === 'whatsapp_location'
                ? 'LOCATION'
                : (dto.media?.kind ?? 'TEXT');
        const content = normalizedTemplate
          ? { whatsAppTemplate: normalizedTemplate }
          : normalizedInteractive
            ? { interactive: normalizedInteractive }
            : normalizedStructured?.type === 'whatsapp_contact'
              ? { contact: normalizedStructured.contact }
              : normalizedStructured?.type === 'whatsapp_location'
                ? normalizedStructured.location
                : dto.media
                  ? { ...(dto.text ? { caption: dto.text } : {}) }
                  : { text: dto.text! };
        const message = await transaction.message.create({
          data: {
            connectionId: route.connectionId,
            contactId: route.contactId,
            content: content as Prisma.InputJsonValue,
            conversationId: conversation.id,
            direction: 'OUTBOUND',
            mediaAssetId: mediaAsset?.id ?? null,
            metadata: {
              channel: 'whatsapp',
              previewUrl:
                typeof dto.linkPreviewOptions?.isDisabled === 'boolean'
                  ? !dto.linkPreviewOptions.isDisabled
                  : true,
              ...(dto.replyToMessageId ? { replyToMessageId: dto.replyToMessageId } : {}),
              ...(requestContext.actorUserId ? { actorUserId: requestContext.actorUserId } : {}),
              source,
            },
            projectId: route.projectId,
            status: 'QUEUED',
            type: messageType,
          },
        });
        const outbox = await transaction.outboxRecord.create({
          data: {
            connectionId: route.connectionId,
            idempotencyKey: storedKey,
            kind: 'WHATSAPP',
            nextAttemptAt: new Date(),
            payload: {
              channelIdentityId: route.identityId,
              messageId: message.id,
              requestHash,
            },
            projectId: route.projectId,
          },
        });
        await transaction.idempotencyRecord.create({
          data: {
            key: idempotencyKey,
            projectId: route.projectId,
            scope: source === 'omnicus' ? 'omnicus-to-whatsapp' : 'crm-to-whatsapp',
          },
        });
        await transaction.auditLog.create({
          data: {
            action:
              source === 'omnicus'
                ? 'communications.whatsapp_outbound_message.queued'
                : 'crm.whatsapp_outbound_message.queued',
            actorEmailSnapshot: requestContext.actorEmail ?? null,
            actorType: source === 'omnicus' ? 'USER' : 'SERVICE',
            actorUserId: requestContext.actorUserId ?? null,
            afterSafeJson: {
              connectionId: route.connectionId,
              ...(source === 'crm' ? { crmProjectId: dto.crmProjectId } : { source }),
            },
            correlationId,
            entityId: outbox.id,
            entityType: 'OutboxRecord',
            projectId: route.projectId,
            projectNameSnapshot: null,
            projectSlugSnapshot: null,
            purgeAfter: new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000),
          },
        });
        return { messageId: message.id, operationId: outbox.id, status: 'QUEUED' as const };
      });
    } catch (error) {
      if (!this.isUniqueConstraint(error)) throw error;
      const duplicate = await this.existing(route.projectId, storedKey, requestHash);
      if (!duplicate) throw error;
      return { ...duplicate, replayed: true };
    }
    await this.enqueue(result.operationId, route.projectId);
    return { ...result, replayed: false };
  }

  async markRead(
    messageId: string,
    dto: CrmTelegramScopeDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: string,
  ) {
    const target = await this.resolveMessage(messageId, dto, authenticatedProjectId);
    if (
      target.direction !== 'INBOUND' ||
      !this.isReadableIncomingMessage(
        target.messageType,
        target.status,
        target.content,
        target.metadata,
      )
    )
      throw new ConflictException({ code: 'WHATSAPP_READ_TARGET_INVALID' });
    if (!target.providerMessageId)
      throw new ConflictException({ code: 'WHATSAPP_READ_TARGET_INVALID' });
    if (target.status === 'READ') {
      const existing = await this.findExistingMarkReadAction(target);
      return existing
        ? { ...existing, status: 'QUEUED', replayed: true }
        : {
            messageId: target.messageId,
            operationId: target.messageId,
            replayed: true,
            status: 'QUEUED',
          };
    }
    return this.queueAction('MARK_READ', target, {}, idempotencyKey, correlationId);
  }

  async reaction(
    messageId: string,
    dto: CrmReactionDto | CrmTelegramScopeDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: string,
  ) {
    const target = await this.resolveMessage(messageId, dto, authenticatedProjectId);
    const emoji = 'emoji' in dto ? dto.emoji : undefined;
    if (
      'emoji' in dto &&
      (!emoji || !this.isWhatsAppReactionEmoji(emoji) || dto.type || dto.value || dto.isBig)
    )
      throw new ConflictException({ code: 'WHATSAPP_REACTION_INVALID' });
    return this.queueAction(
      'SET_REACTION',
      target,
      { emoji: emoji ?? '' },
      idempotencyKey,
      correlationId,
    );
  }

  async retry(
    operationId: string,
    dto: CrmRetryOperationDto,
    correlationId: string,
    authenticatedProjectId?: string,
  ): Promise<CrmWhatsAppQueuedResult> {
    await this.assertProject(dto.crmProjectId, dto.omnicusProjectId, authenticatedProjectId);
    const source = await this.database.client.outboxRecord.findUnique({
      where: { projectId_id: { id: operationId, projectId: dto.omnicusProjectId } },
    });
    if (!source || source.kind !== 'WHATSAPP')
      throw new NotFoundException({ code: 'OPERATION_NOT_FOUND' });
    if (source.status === 'UNKNOWN')
      throw new ConflictException({ code: 'UNKNOWN_REQUIRES_RECONCILIATION' });
    if (source.status !== 'FAILED') throw new ConflictException({ code: 'OPERATION_NOT_FAILED' });
    const sourcePayload = this.object(source.payload);
    const messageId = this.nonEmptyString(sourcePayload?.messageId);
    const channelIdentityId = this.nonEmptyString(sourcePayload?.channelIdentityId);
    if (!messageId || !channelIdentityId || !source.connectionId)
      throw new ConflictException({ code: 'OPERATION_PAYLOAD_INVALID' });
    const message = await this.database.client.message.findFirst({
      select: { contactId: true, id: true },
      where: {
        connectionId: source.connectionId,
        id: messageId,
        projectId: source.projectId,
      },
    });
    if (!message) throw new NotFoundException({ code: 'OPERATION_MESSAGE_NOT_FOUND' });
    const identity = await this.database.client.channelIdentity.findUnique({
      where: {
        projectId_id: { id: channelIdentityId, projectId: source.projectId },
      },
    });
    if (
      !identity ||
      identity.channel !== 'WHATSAPP' ||
      identity.connectionId !== source.connectionId ||
      identity.contactId !== message.contactId
    )
      throw new ConflictException({ code: 'OPERATION_ROUTE_INVALID' });

    const storedKey = `crm-retry-${dto.retryRequestId}`;
    const existing = await this.database.client.outboxRecord.findUnique({
      where: {
        projectId_idempotencyKey: {
          idempotencyKey: storedKey,
          projectId: source.projectId,
        },
      },
    });
    if (existing) return this.retryReplay(existing, source, messageId);

    let retry;
    try {
      retry = await this.database.client.$transaction(async (transaction) => {
        const created = await transaction.outboxRecord.create({
          data: {
            connectionId: source.connectionId,
            idempotencyKey: storedKey,
            kind: 'WHATSAPP',
            maxAttempts: source.maxAttempts,
            nextAttemptAt: new Date(),
            payload: {
              ...sourcePayload,
              correlationId,
              retryOfOperationId: source.id,
            } as Prisma.InputJsonObject,
            projectId: source.projectId,
          },
        });
        await transaction.auditLog.create({
          data: {
            action: 'crm.whatsapp_operation.retry_queued',
            actorType: 'SERVICE',
            afterSafeJson: {
              connectionId: source.connectionId,
              retryOfOperationId: source.id,
            },
            correlationId,
            entityId: created.id,
            entityType: 'OutboxRecord',
            projectId: source.projectId,
            projectNameSnapshot: null,
            projectSlugSnapshot: null,
            purgeAfter: new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000),
          },
        });
        return created;
      });
    } catch (error) {
      if (!this.isUniqueConstraint(error)) throw error;
      const raced = await this.database.client.outboxRecord.findUnique({
        where: {
          projectId_idempotencyKey: {
            idempotencyKey: storedKey,
            projectId: source.projectId,
          },
        },
      });
      if (!raced) throw error;
      return this.retryReplay(raced, source, messageId);
    }
    await this.enqueue(retry.id, source.projectId);
    return {
      messageId,
      operationId: retry.id,
      replayed: false,
      status: 'QUEUED',
    };
  }

  async automationState(query: CrmAutomationStateQueryDto, authenticatedProjectId?: string) {
    const route = await this.resolveIdentity(
      {
        crmProjectId: query.crmProjectId,
        identity: {
          channel: 'whatsapp',
          channelIdentityId: query.channelIdentityId,
          connectionId: query.connectionId,
        },
        omnicusContactId: query.omnicusContactId,
        omnicusProjectId: query.omnicusProjectId,
      },
      authenticatedProjectId,
    );
    const conversation = await this.database.client.conversation.findUnique({
      where: {
        projectId_connectionId_externalChatId: {
          connectionId: route.connectionId,
          externalChatId: route.externalUserId,
          projectId: route.projectId,
        },
      },
    });
    return {
      changedAt: conversation?.updatedAt.toISOString() ?? null,
      mode:
        conversation?.automationState ??
        (conversation?.automationModeOverride === 'DISABLED' ? 'MANUAL' : 'AUTO'),
      reasonCode: conversation?.automationReasonCode ?? null,
      resumeAt: conversation?.automationResumeAt?.toISOString() ?? null,
      revision: conversation?.automationRevision ?? 0,
    };
  }

  async setAutomationState(
    dto: CrmAutomationStateDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: string,
  ) {
    const route = await this.resolveIdentity(dto, authenticatedProjectId);
    const request = {
      expectedRevision: dto.expectedRevision,
      mode: dto.mode,
      reasonCode: dto.reasonCode ?? null,
      resumeAt: dto.resumeAt ?? null,
    };
    const existing = await this.database.client.idempotencyRecord.findUnique({
      where: {
        projectId_scope_key: {
          key: idempotencyKey,
          projectId: route.projectId,
          scope: 'crm-whatsapp-automation-state',
        },
      },
    });
    if (existing) {
      const result = this.object(existing.resultSafe);
      if (
        JSON.stringify(result?.request) !== JSON.stringify(request) ||
        !this.object(result?.response)
      )
        throw new ConflictException({ code: 'AUTOMATION_IDEMPOTENCY_CONFLICT' });
      return result!.response;
    }
    const resumeAt = dto.resumeAt ? new Date(dto.resumeAt) : undefined;
    if (dto.mode === 'PAUSED' && (!resumeAt || resumeAt <= new Date()))
      throw new ConflictException({ code: 'AUTOMATION_RESUME_AT_REQUIRED' });
    if (dto.mode !== 'PAUSED' && resumeAt)
      throw new ConflictException({ code: 'AUTOMATION_RESUME_AT_NOT_ALLOWED' });
    return this.database.client.$transaction(async (transaction) => {
      const key = {
        connectionId: route.connectionId,
        externalChatId: route.externalUserId,
        projectId: route.projectId,
      };
      let conversation = await transaction.conversation.findUnique({
        where: { projectId_connectionId_externalChatId: key },
      });
      if (!conversation) {
        if (dto.expectedRevision !== 0)
          throw new ConflictException({ code: 'AUTOMATION_REVISION_CONFLICT' });
        conversation = await transaction.conversation.create({
          data: {
            automationModeOverride: dto.mode === 'AUTO' ? 'ENABLED' : 'DISABLED',
            automationReasonCode: dto.reasonCode ?? null,
            automationResumeAt: resumeAt ?? null,
            automationRevision: 1,
            automationState: dto.mode,
            connectionId: route.connectionId,
            contactId: route.contactId,
            externalChatId: route.externalUserId,
            projectId: route.projectId,
          },
        });
      } else {
        const updated = await transaction.conversation.updateMany({
          data: {
            automationModeOverride: dto.mode === 'AUTO' ? 'ENABLED' : 'DISABLED',
            automationReasonCode: dto.reasonCode ?? null,
            automationResumeAt: resumeAt ?? null,
            automationRevision: { increment: 1 },
            automationState: dto.mode,
          },
          where: {
            automationRevision: dto.expectedRevision,
            id: conversation.id,
            projectId: route.projectId,
          },
        });
        if (updated.count !== 1)
          throw new ConflictException({ code: 'AUTOMATION_REVISION_CONFLICT' });
        conversation = await transaction.conversation.findUniqueOrThrow({
          where: { projectId_id: { id: conversation.id, projectId: route.projectId } },
        });
      }
      const response = {
        changedAt: conversation.updatedAt.toISOString(),
        mode: conversation.automationState,
        reasonCode: conversation.automationReasonCode,
        resumeAt: conversation.automationResumeAt?.toISOString() ?? null,
        revision: conversation.automationRevision,
      };
      await transaction.auditLog.create({
        data: {
          action: 'crm.whatsapp_automation_state.changed',
          actorType: 'SERVICE',
          afterSafeJson: {
            connectionId: route.connectionId,
            mode: response.mode,
            revision: response.revision,
          },
          correlationId,
          entityId: conversation.id,
          entityType: 'Conversation',
          projectId: route.projectId,
          projectNameSnapshot: null,
          projectSlugSnapshot: null,
          purgeAfter: new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000),
        },
      });
      await transaction.idempotencyRecord.create({
        data: {
          key: idempotencyKey,
          projectId: route.projectId,
          resultSafe: { request, response },
          scope: 'crm-whatsapp-automation-state',
        },
      });
      return response;
    });
  }

  private async resolveIdentity(
    dto: CrmTelegramScopeDto,
    authenticatedProjectId?: string,
    requestContext: OutboundRequestContext = {},
  ): Promise<WhatsAppRoute> {
    await this.assertProject(
      dto.crmProjectId,
      dto.omnicusProjectId,
      authenticatedProjectId,
      requestContext,
    );
    if (dto.identity.channel !== 'whatsapp')
      throw new NotFoundException({ code: 'CHANNEL_IDENTITY_NOT_FOUND' });
    const identity = await this.database.client.channelIdentity.findUnique({
      include: { connection: true },
      where: {
        projectId_id: { id: dto.identity.channelIdentityId, projectId: dto.omnicusProjectId },
      },
    });
    const metadata = this.object(identity?.connection.webhookMetadata);
    const graphApiVersion = this.nonEmptyString(metadata?.graphApiVersion);
    if (
      !identity ||
      identity.channel !== 'WHATSAPP' ||
      identity.contactId !== dto.omnicusContactId ||
      identity.connectionId !== dto.identity.connectionId ||
      identity.status !== 'ACTIVE' ||
      identity.connection.type !== 'WHATSAPP' ||
      identity.connection.status !== 'ACTIVE' ||
      !graphApiVersion
    )
      throw new NotFoundException({ code: 'CHANNEL_IDENTITY_NOT_FOUND' });
    return {
      connectionId: identity.connectionId,
      contactId: identity.contactId,
      externalUserId: identity.externalUserId,
      graphApiVersion,
      identityId: identity.id,
      projectId: identity.projectId,
    };
  }

  private async resolveMessage(
    messageId: string,
    dto: CrmTelegramScopeDto,
    authenticatedProjectId?: string,
  ) {
    const route = await this.resolveIdentity(dto, authenticatedProjectId);
    const message = await this.database.client.message.findFirst({
      where: {
        connectionId: route.connectionId,
        contactId: route.contactId,
        conversation: { externalChatId: route.externalUserId },
        id: messageId,
        projectId: route.projectId,
      },
    });
    if (!message?.externalMessageId)
      throw new NotFoundException({ code: 'WHATSAPP_READ_TARGET_INVALID' });
    return {
      channelIdentityId: route.identityId,
      connectionId: route.connectionId,
      direction: message.direction,
      messageId: message.id,
      projectId: route.projectId,
      metadata: message.metadata,
      content: message.content,
      status: message.status,
      messageType: message.type,
      providerMessageId: message.externalMessageId,
    };
  }

  private async queueAction(
    action: 'MARK_READ' | 'SET_REACTION',
    target: Awaited<ReturnType<CrmWhatsAppV4Service['resolveMessage']>>,
    mutation: JsonObject,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CrmWhatsAppQueuedResult> {
    if (action === 'MARK_READ') {
      const existingMarkRead = await this.findExistingMarkReadAction(target);
      if (existingMarkRead) {
        return {
          messageId: existingMarkRead.messageId,
          operationId: existingMarkRead.operationId,
          replayed: true,
          status: 'QUEUED',
        };
      }
    }
    const requestHash = this.requestHash({ action, messageId: target.messageId, mutation });
    const storedKey = `crm-whatsapp-v4-${idempotencyKey}`;
    const existing = await this.database.client.outboxRecord.findUnique({
      where: {
        projectId_idempotencyKey: { idempotencyKey: storedKey, projectId: target.projectId },
      },
    });
    if (existing) {
      const payload = this.object(existing.payload);
      if (
        existing.kind !== 'WHATSAPP' ||
        payload?.messageId !== target.messageId ||
        payload.requestHash !== requestHash
      )
        throw new ConflictException({ code: 'CRM_IDEMPOTENCY_CONFLICT' });
      return {
        messageId: target.messageId,
        operationId: existing.id,
        replayed: true,
        status: 'QUEUED',
      };
    }
    let outbox;
    try {
      outbox = await this.database.client.$transaction(async (transaction) => {
        const created = await transaction.outboxRecord.create({
          data: {
            connectionId: target.connectionId,
            idempotencyKey: storedKey,
            kind: 'WHATSAPP',
            nextAttemptAt: new Date(),
            payload: {
              action,
              channelIdentityId: target.channelIdentityId,
              correlationId,
              messageId: target.messageId,
              ...mutation,
              providerMessageId: target.providerMessageId,
              requestHash,
            },
            projectId: target.projectId,
          },
        });
        await transaction.auditLog.create({
          data: {
            action: 'crm.whatsapp_message_action.queued',
            actorType: 'SERVICE',
            afterSafeJson: { action, connectionId: target.connectionId },
            correlationId,
            entityId: created.id,
            entityType: 'OutboxRecord',
            projectId: target.projectId,
            projectNameSnapshot: null,
            projectSlugSnapshot: null,
            purgeAfter: new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000),
          },
        });
        return created;
      });
    } catch (error) {
      if (!this.isUniqueConstraint(error)) throw error;
      const raced = await this.database.client.outboxRecord.findUnique({
        where: {
          projectId_idempotencyKey: {
            idempotencyKey: storedKey,
            projectId: target.projectId,
          },
        },
      });
      const racedPayload = this.object(raced?.payload);
      if (
        !raced ||
        raced.kind !== 'WHATSAPP' ||
        racedPayload?.messageId !== target.messageId ||
        racedPayload.requestHash !== requestHash
      )
        throw new ConflictException({ code: 'CRM_IDEMPOTENCY_CONFLICT' });
      return {
        messageId: target.messageId,
        operationId: raced.id,
        replayed: true,
        status: 'QUEUED',
      };
    }
    await this.enqueue(outbox.id, target.projectId);
    return {
      messageId: target.messageId,
      operationId: outbox.id,
      replayed: false,
      status: 'QUEUED',
    };
  }

  private async findExistingMarkReadAction(target: {
    connectionId: string;
    messageId: string;
    projectId: string;
    providerMessageId: string;
  }): Promise<{ messageId: string; operationId: string } | undefined> {
    const duplicate = await this.database.client.outboxRecord.findFirst({
      where: {
        connectionId: target.connectionId,
        kind: 'WHATSAPP',
        projectId: target.projectId,
        AND: [
          { payload: { path: ['action'], equals: 'MARK_READ' } },
          { payload: { path: ['messageId'], equals: target.messageId } },
        ],
      },
      select: {
        id: true,
        payload: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    const payload = this.object(duplicate?.payload);
    if (
      !payload ||
      payload.messageId !== target.messageId ||
      payload.providerMessageId !== target.providerMessageId
    )
      return;
    return {
      messageId: target.messageId,
      operationId: duplicate!.id,
    };
  }

  private isReadableIncomingMessage(
    messageType: string | undefined,
    status: string,
    content: unknown,
    metadata: unknown,
  ): boolean {
    if (status === 'READ') return false;
    if (!this.isReadableIncomingMessageType(messageType)) return false;
    if (this.isSyntheticSource(metadata)) return false;
    if (messageType === 'INTERACTIVE' && this.isSyntheticInteractive(content)) return false;
    return true;
  }

  private isSyntheticSource(metadata: unknown): boolean {
    const source = this.nonEmptyString(this.object(metadata)?.source);
    const sourceValue = source?.toLowerCase();
    return sourceValue === 'automation' || sourceValue === 'broadcast' || sourceValue === 'system';
  }

  private isSyntheticInteractive(content: unknown): boolean {
    const interactive = this.object(this.object(content)?.interactive);
    const type = this.nonEmptyString(interactive?.type)?.toLowerCase();
    return type === 'button_reply' || type === 'list_reply';
  }

  private isReadableIncomingMessageType(messageType: string | undefined): boolean {
    return !['SYSTEM', 'CALLBACK_QUERY', 'UNSUPPORTED'].includes(messageType ?? '');
  }

  private retryReplay(
    retry: {
      connectionId: string | null;
      id: string;
      kind: string;
      payload: Prisma.JsonValue;
      projectId: string;
    },
    source: { connectionId: string | null; id: string; projectId: string },
    messageId: string,
  ): CrmWhatsAppQueuedResult {
    const payload = this.object(retry.payload);
    if (
      retry.kind !== 'WHATSAPP' ||
      retry.projectId !== source.projectId ||
      retry.connectionId !== source.connectionId ||
      payload?.messageId !== messageId ||
      payload.retryOfOperationId !== source.id
    )
      throw new ConflictException({ code: 'CRM_RETRY_IDEMPOTENCY_CONFLICT' });
    return {
      messageId,
      operationId: retry.id,
      replayed: true,
      status: 'QUEUED',
    };
  }

  private async existing(
    projectId: string,
    storedKey: string,
    requestHash: string,
  ): Promise<Omit<CrmWhatsAppQueuedResult, 'replayed'> | undefined> {
    const record = await this.database.client.outboxRecord.findUnique({
      where: { projectId_idempotencyKey: { idempotencyKey: storedKey, projectId } },
    });
    if (!record) return;
    const payload = this.object(record.payload);
    if (
      record.kind !== 'WHATSAPP' ||
      typeof payload?.messageId !== 'string' ||
      payload.requestHash !== requestHash
    )
      throw new ConflictException({ code: 'CRM_IDEMPOTENCY_CONFLICT' });
    return { messageId: payload.messageId, operationId: record.id, status: 'QUEUED' };
  }

  private async assertProject(
    crmProjectId: string,
    omnicusProjectId: string,
    authenticatedProjectId?: string,
    requestContext: OutboundRequestContext = {},
  ) {
    const project = await this.database.client.project.findUnique({
      include: { crmConfig: true },
      where: { id: omnicusProjectId },
    });
    if (
      (authenticatedProjectId && authenticatedProjectId !== omnicusProjectId) ||
      !project ||
      project.status !== 'ACTIVE' ||
      ((requestContext.source ?? 'crm') === 'crm' &&
        (!project.crmConfig?.enabled || project.crmConfig.crmProjectId !== crmProjectId))
    )
      throw new NotFoundException({ code: 'CRM_PROJECT_ROUTE_NOT_FOUND' });
  }

  private assertNoTelegramOnlyFields(dto: CrmOutboundMessageDto) {
    const forbidden = [
      dto.disableNotification,
      dto.entities,
      dto.hasSpoiler,
      dto.inlineKeyboard,
      dto.messageEffectId,
      dto.protectContent,
      dto.quote,
      dto.quotePosition,
      dto.replyMarkup,
      dto.richMessage,
    ];
    if (forbidden.some((value) => value !== undefined))
      throw new ConflictException({ code: 'CRM_WHATSAPP_TELEGRAM_FIELDS_UNSUPPORTED' });
  }

  private isWhatsAppReactionEmoji(value: string): boolean {
    if (value.length > 32 || /\s/u.test(value)) return false;
    const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)];
    if (graphemes.length !== 1 || graphemes[0]?.segment !== value) return false;
    return /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(value);
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    );
  }

  private mediaValidationChannel(asset: {
    providerMetadata?: Prisma.JsonValue | null;
    source?: string;
  }): 'telegram' | 'whatsapp' | undefined {
    const metadata = this.object(asset.providerMetadata);
    if (metadata?.validationChannel === 'telegram' || metadata?.validationChannel === 'whatsapp')
      return metadata.validationChannel;
    if (asset.source === 'WHATSAPP') return 'whatsapp';
    if (asset.source === 'TELEGRAM') return 'telegram';
    return undefined;
  }

  private async normalizeTemplate(value: JsonObject, route: WhatsAppRoute) {
    const name = this.nonEmptyString(value.name);
    const languageCode = this.nonEmptyString(value.languageCode);
    if (
      !name ||
      name.length > 512 ||
      !/^[a-z0-9_]+$/.test(name) ||
      !languageCode ||
      languageCode.length > 32
    )
      throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_INVALID' });
    const approved = await this.database.client.whatsAppMessageTemplate.findUnique({
      where: {
        projectId_connectionId_name_languageCode: {
          connectionId: route.connectionId,
          languageCode,
          name,
          projectId: route.projectId,
        },
      },
    });
    if (!approved || approved.status !== 'APPROVED')
      throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_NOT_APPROVED' });
    const availability = this.templateAvailability(approved);
    if (!availability.sendable)
      throw new ConflictException({
        code: 'CRM_WHATSAPP_TEMPLATE_UNSUPPORTED',
        reasonCode: availability.disabledReason,
      });
    const components =
      value.components === undefined
        ? undefined
        : this.normalizeTemplateComponents(value.components);
    try {
      assertWhatsAppTemplateComponents(approved.components, components);
    } catch {
      throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_COMPONENTS_INVALID' });
    }
    if (Object.keys(value).some((key) => !['components', 'languageCode', 'name'].includes(key)))
      throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_INVALID' });
    return { ...(components ? { components } : {}), languageCode, name };
  }

  private normalizeTemplateComponents(value: unknown) {
    if (!Array.isArray(value) || value.length > 20)
      throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_COMPONENTS_INVALID' });
    return value.map((candidate) => {
      const component = this.object(candidate);
      const type = this.nonEmptyString(component?.type);
      if (
        !component ||
        !type ||
        !['header', 'body', 'button'].includes(type) ||
        Object.keys(component).some(
          (key) =>
            !(
              type === 'button'
                ? ['index', 'parameters', 'subType', 'type']
                : ['parameters', 'type']
            ).includes(key),
        ) ||
        (component.parameters !== undefined && !Array.isArray(component.parameters))
      )
        throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_COMPONENTS_INVALID' });
      const parameters = Array.isArray(component.parameters)
        ? component.parameters.map((parameter) => this.normalizeTemplateParameter(parameter))
        : [];
      if (parameters.length > 10)
        throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_COMPONENTS_INVALID' });
      if (type === 'button') {
        const subType = this.nonEmptyString(component.subType);
        const index = component.index;
        if (
          !['quick_reply', 'url'].includes(subType ?? '') ||
          !Number.isInteger(index) ||
          Number(index) < 0 ||
          Number(index) > 9
        )
          throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_COMPONENTS_INVALID' });
        return { index: Number(index), parameters, subType, type };
      }
      return { parameters, type };
    });
  }

  private templateAvailability(template: {
    category: string;
    components: Prisma.JsonValue;
    status: string;
  }): { disabledReason: string | null; sendable: boolean } {
    const disabledReason = whatsAppTemplateDisabledReason(template);
    return {
      disabledReason: disabledReason ?? null,
      sendable: disabledReason === undefined,
    };
  }

  private crmTemplateComponents(value: Prisma.JsonValue): JsonObject[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 32).flatMap((candidate) => {
      const component = this.object(candidate);
      const type = this.nonEmptyString(component?.type);
      if (!component || !type || !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(type)) return [];
      const format = this.nonEmptyString(component.format);
      const parameterStyle = this.nonEmptyString(component.parameterStyle);
      const unsupportedReason = this.nonEmptyString(component.unsupportedReason);
      const text = typeof component.text === 'string' ? component.text : undefined;
      const buttons = Array.isArray(component.buttons)
        ? component.buttons.slice(0, 10).flatMap((candidateButton) => {
            const button = this.object(candidateButton);
            const buttonType = this.nonEmptyString(button?.type);
            const buttonText = this.nonEmptyString(button?.text);
            if (
              !button ||
              !buttonType ||
              !buttonText ||
              !['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(buttonType)
            )
              return [];
            const buttonParameterStyle = this.nonEmptyString(button.parameterStyle);
            const buttonUnsupportedReason = this.nonEmptyString(button.unsupportedReason);
            return [
              {
                ...(typeof button.dynamic === 'boolean' ? { dynamic: button.dynamic } : {}),
                ...(buttonParameterStyle ? { parameterStyle: buttonParameterStyle } : {}),
                ...(buttonUnsupportedReason ? { unsupportedReason: buttonUnsupportedReason } : {}),
                text: buttonText,
                type: buttonType,
              },
            ];
          })
        : undefined;
      return [
        {
          ...(buttons ? { buttons } : {}),
          ...(format ? { format } : {}),
          ...(parameterStyle ? { parameterStyle } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(unsupportedReason ? { unsupportedReason } : {}),
          type,
        },
      ];
    });
  }

  private normalizeTemplateParameter(value: unknown): JsonObject {
    const parameter = this.object(value);
    const type = this.nonEmptyString(parameter?.type);
    if (!parameter || !type)
      throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_PARAMETER_INVALID' });
    if (
      type === 'text' &&
      Object.keys(parameter).every((key) => ['text', 'type'].includes(key)) &&
      typeof parameter.text === 'string' &&
      parameter.text.length >= 1 &&
      parameter.text.length <= 4_096
    )
      return { text: parameter.text, type };
    if (
      type === 'payload' &&
      Object.keys(parameter).every((key) => ['payload', 'type'].includes(key)) &&
      typeof parameter.payload === 'string' &&
      parameter.payload.length >= 1 &&
      parameter.payload.length <= 256
    )
      return { payload: parameter.payload, type };
    if (type === 'currency') {
      const currency = this.object(parameter.currency);
      if (
        !Object.keys(parameter).every((key) => ['currency', 'type'].includes(key)) ||
        !currency ||
        !Object.keys(currency).every((key) =>
          ['amount1000', 'code', 'fallbackValue'].includes(key),
        ) ||
        typeof currency.amount1000 !== 'number' ||
        !Number.isSafeInteger(currency.amount1000) ||
        typeof currency.code !== 'string' ||
        !/^[A-Z]{3}$/.test(currency.code) ||
        typeof currency.fallbackValue !== 'string' ||
        currency.fallbackValue.length < 1 ||
        currency.fallbackValue.length > 64
      )
        throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_PARAMETER_INVALID' });
      return {
        amount1000: currency.amount1000,
        code: currency.code,
        fallbackValue: currency.fallbackValue,
        type,
      };
    }
    if (type === 'date_time') {
      const dateTime = this.object(parameter.dateTime);
      if (
        !Object.keys(parameter).every((key) => ['dateTime', 'type'].includes(key)) ||
        !dateTime ||
        !Object.keys(dateTime).every((key) => key === 'fallbackValue') ||
        typeof dateTime.fallbackValue !== 'string' ||
        dateTime.fallbackValue.length < 1 ||
        dateTime.fallbackValue.length > 128
      )
        throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_PARAMETER_INVALID' });
      return { fallbackValue: dateTime.fallbackValue, type };
    }
    if (['document', 'image', 'video'].includes(type)) {
      const mediaAssetId = this.nonEmptyString(parameter.mediaAssetId);
      if (
        !Object.keys(parameter).every((key) => ['mediaAssetId', 'type'].includes(key)) ||
        !mediaAssetId ||
        !this.isUuid(mediaAssetId)
      )
        throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_PARAMETER_INVALID' });
      return { mediaAssetId, type };
    }
    throw new ConflictException({ code: 'CRM_WHATSAPP_TEMPLATE_PARAMETER_INVALID' });
  }

  private normalizeInteractive(value: JsonObject): Prisma.InputJsonObject {
    if (
      Object.keys(value).some(
        (key) => !['action', 'body', 'footer', 'header', 'type'].includes(key),
      )
    )
      throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
    const type = this.nonEmptyString(value.type);
    const body = this.object(value.body);
    const bodyText = this.nonEmptyString(body?.text);
    if (
      !body ||
      Object.keys(body).some((key) => key !== 'text') ||
      !bodyText ||
      bodyText.length > 1_024 ||
      !['button', 'list'].includes(type ?? '')
    )
      throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
    const footer = this.object(value.footer);
    const footerText = this.nonEmptyString(footer?.text);
    if (
      (footer && Object.keys(footer).some((key) => key !== 'text')) ||
      (footerText && footerText.length > 60)
    )
      throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
    const header = this.normalizeInteractiveHeader(value.header, type!);
    const action = this.object(value.action);
    if (!action) throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
    if (type === 'button') {
      if (
        Object.keys(action).some((key) => key !== 'buttons') ||
        !Array.isArray(action.buttons) ||
        action.buttons.length < 1 ||
        action.buttons.length > 3
      )
        throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
      const ids = new Set<string>();
      const buttons = action.buttons.map((candidate) => {
        const button = this.object(candidate);
        const id = this.nonEmptyString(button?.id);
        const title = this.nonEmptyString(button?.title);
        if (
          !button ||
          Object.keys(button).some((key) => !['id', 'title'].includes(key)) ||
          !id ||
          id.length > 256 ||
          !title ||
          title.length > 20 ||
          ids.has(id)
        )
          throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
        ids.add(id);
        return { id, title };
      });
      return {
        action: { buttons },
        body: { text: bodyText },
        ...(footerText ? { footer: { text: footerText } } : {}),
        ...(header ? { header } : {}),
        type,
      };
    }
    if (header && header.type !== 'text')
      throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
    const button = this.nonEmptyString(action.button);
    if (
      Object.keys(action).some((key) => !['button', 'sections'].includes(key)) ||
      !button ||
      button.length > 20 ||
      !Array.isArray(action.sections) ||
      action.sections.length < 1 ||
      action.sections.length > 10
    )
      throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
    const rowIds = new Set<string>();
    let rowCount = 0;
    const sections = action.sections.map((candidate) => {
      const section = this.object(candidate);
      const title = this.nonEmptyString(section?.title);
      if (
        !section ||
        Object.keys(section).some((key) => !['rows', 'title'].includes(key)) ||
        (title && title.length > 24) ||
        !Array.isArray(section.rows) ||
        section.rows.length < 1
      )
        throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
      const rows = section.rows.map((candidateRow) => {
        const row = this.object(candidateRow);
        const id = this.nonEmptyString(row?.id);
        const rowTitle = this.nonEmptyString(row?.title);
        const description = this.nonEmptyString(row?.description);
        rowCount += 1;
        if (
          !row ||
          Object.keys(row).some((key) => !['description', 'id', 'title'].includes(key)) ||
          !id ||
          id.length > 200 ||
          !rowTitle ||
          rowTitle.length > 24 ||
          (description && description.length > 72) ||
          rowIds.has(id) ||
          rowCount > 10
        )
          throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
        rowIds.add(id);
        return { ...(description ? { description } : {}), id, title: rowTitle };
      });
      return { ...(title ? { title } : {}), rows };
    });
    return {
      action: { button, sections },
      body: { text: bodyText },
      ...(footerText ? { footer: { text: footerText } } : {}),
      ...(header ? { header } : {}),
      type,
    };
  }

  private normalizeInteractiveHeader(value: unknown, interactiveType: string) {
    if (value === undefined) return;
    const header = this.object(value);
    const type = this.nonEmptyString(header?.type);
    if (!header || !type) throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
    if (type === 'text') {
      const text = this.nonEmptyString(header.text);
      if (
        Object.keys(header).some((key) => !['text', 'type'].includes(key)) ||
        !text ||
        text.length > 60
      )
        throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
      return { text, type };
    }
    const mediaAssetId = this.nonEmptyString(header.mediaAssetId);
    if (
      Object.keys(header).some((key) => !['mediaAssetId', 'type'].includes(key)) ||
      interactiveType !== 'button' ||
      !['document', 'image', 'video'].includes(type) ||
      !mediaAssetId ||
      !this.isUuid(mediaAssetId)
    )
      throw new ConflictException({ code: 'CRM_WHATSAPP_INTERACTIVE_INVALID' });
    return { mediaAssetId, type };
  }

  private normalizeStructured(
    value: JsonObject,
  ):
    | { contact: Prisma.InputJsonObject; type: 'whatsapp_contact' }
    | { location: Prisma.InputJsonObject; type: 'whatsapp_location' } {
    if (value.type === 'whatsapp_contact') {
      if (
        Object.keys(value).some(
          (key) =>
            !['emails', 'firstName', 'formattedName', 'lastName', 'phones', 'type'].includes(key),
        )
      )
        throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
      const formattedName = this.nonEmptyString(value.formattedName);
      if (
        !formattedName ||
        formattedName.length > 256 ||
        !Array.isArray(value.phones) ||
        value.phones.length < 1 ||
        value.phones.length > 10
      )
        throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
      const phones = value.phones.map((candidate) => {
        const phone = this.object(candidate);
        if (!phone || Object.keys(phone).some((key) => !['phone', 'type', 'waId'].includes(key)))
          throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
        const number = this.nonEmptyString(phone?.phone);
        if (!number || number.length > 64)
          throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
        const type = this.nonEmptyString(phone?.type);
        const waId = this.nonEmptyString(phone?.waId);
        if ((type && type.length > 32) || (waId && waId.length > 64))
          throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
        return { phone: number, ...(type ? { type } : {}), ...(waId ? { waId } : {}) };
      });
      const emails =
        value.emails === undefined
          ? undefined
          : Array.isArray(value.emails) && value.emails.length <= 10
            ? value.emails.map((candidate) => {
                const email = this.object(candidate);
                if (!email || Object.keys(email).some((key) => !['email', 'type'].includes(key)))
                  throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
                const address = this.nonEmptyString(email?.email);
                if (
                  !address ||
                  address.length > 320 ||
                  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)
                )
                  throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
                const type = this.nonEmptyString(email?.type);
                if (type && type.length > 32)
                  throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
                return { email: address, ...(type ? { type } : {}) };
              })
            : (() => {
                throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
              })();
      const firstName = this.nonEmptyString(value.firstName);
      const lastName = this.nonEmptyString(value.lastName);
      if ((firstName && firstName.length > 128) || (lastName && lastName.length > 128))
        throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
      return {
        contact: {
          ...(emails?.length ? { emails } : {}),
          ...(firstName ? { firstName } : {}),
          formattedName,
          ...(lastName ? { lastName } : {}),
          phones,
        },
        type: 'whatsapp_contact',
      };
    }
    if (
      value.type === 'whatsapp_location' &&
      !Object.keys(value).some(
        (key) => !['address', 'latitude', 'longitude', 'name', 'type'].includes(key),
      ) &&
      typeof value.latitude === 'number' &&
      value.latitude >= -90 &&
      value.latitude <= 90 &&
      typeof value.longitude === 'number' &&
      value.longitude >= -180 &&
      value.longitude <= 180
    ) {
      const address = this.nonEmptyString(value.address);
      const name = this.nonEmptyString(value.name);
      if ((address && address.length > 1_000) || (name && name.length > 1_000))
        throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
      return {
        location: {
          ...(address ? { address } : {}),
          latitude: value.latitude,
          longitude: value.longitude,
          ...(name ? { name } : {}),
        },
        type: 'whatsapp_location',
      };
    }
    throw new ConflictException({ code: 'CRM_WHATSAPP_STRUCTURED_INVALID' });
  }

  private async enqueue(operationId: string, projectId: string) {
    try {
      await this.outboundQueue.enqueue(operationId);
    } catch {
      this.logger.warn({
        message: 'crm_whatsapp_enqueue_failed',
        operationId,
        projectId,
      });
    }
  }

  private requestHash(value: unknown) {
    return createHash('sha256').update(this.canonical(value)).digest('hex');
  }

  private canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.canonical(item)).join(',')}]`;
    if (value && typeof value === 'object')
      return `{${Object.entries(value as JsonObject)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.canonical(item)}`)
        .join(',')}}`;
    return JSON.stringify(value);
  }

  private object(value: unknown): JsonObject | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonObject)
      : undefined;
  }

  private nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private isUniqueConstraint(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
