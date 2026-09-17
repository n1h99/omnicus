import type { CommunicationProjectScope } from './native-communication-scope';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelSecretsService, type EncryptedSecretEnvelope } from '@omnicus/channel-secrets';
import {
  TelegramAdapter,
  TelegramHttpTransport,
  type TelegramMessageEntity,
  type TelegramReaction,
  type TelegramRichMessage,
  validateTelegramInlineKeyboard,
  validateTelegramLinkPreviewOptions,
  validateTelegramMessageEntities,
} from '@omnicus/channel-telegram';
import type { ApiEnvironment } from '@omnicus/config/server';
import { Prisma } from '@omnicus/database';

import { TelegramOutboundQueueService } from '../channels/telegram-outbound-queue.service';
import { DatabaseService } from '../database/database.service';
import type {
  CrmCapabilitiesQueryDto,
  CrmBotInterfaceDto,
  CrmBotInterfaceQueryDto,
  CrmAutomationStateDto,
  CrmAutomationStateQueryDto,
  CrmChatActionDto,
  CrmDraftDto,
  CrmMessageMutationDto,
  CrmMediaGroupDto,
  CrmPinMessageDto,
  CrmReactionDto,
  CrmRetryOperationDto,
  CrmTelegramScopeDto,
} from './dto';

type V3Action = 'DELETE_MESSAGE' | 'EDIT_MESSAGE' | 'PIN_MESSAGE' | 'SET_REACTION';

@Injectable()
export class CrmTelegramV3Service {
  private readonly adapter = new TelegramAdapter(new TelegramHttpTransport());
  private readonly logger = new Logger(CrmTelegramV3Service.name);
  private readonly secrets: ChannelSecretsService;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TelegramOutboundQueueService)
    private readonly outboundQueue: TelegramOutboundQueueService,
    @Inject(ConfigService) config: ConfigService<ApiEnvironment, true>,
  ) {
    this.secrets = new ChannelSecretsService(config.get('CHANNEL_SECRETS_KEY', { infer: true }));
  }

  async capabilities(
    query: CrmCapabilitiesQueryDto,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    await this.assertProject(query.crmProjectId, query.omnicusProjectId, authenticatedProjectId);
    const connection = await this.database.client.channelConnection.findUnique({
      select: { id: true, status: true, type: true },
      where: {
        projectId_id: { id: query.connectionId, projectId: query.omnicusProjectId },
      },
    });
    if (!connection || connection.type !== 'TELEGRAM')
      throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
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
              connectionId: query.connectionId,
              ...(query.omnicusContactId ? { contactId: query.omnicusContactId } : {}),
              projectId: query.omnicusProjectId,
            },
          });
      if (
        !identity ||
        identity.connectionId !== query.connectionId ||
        (query.omnicusContactId && identity.contactId !== query.omnicusContactId)
      )
        throw new NotFoundException({ code: 'CHANNEL_IDENTITY_NOT_FOUND' });
    }
    const unavailable = connection.status !== 'ACTIVE';
    const supported = (limits?: Record<string, unknown>) => ({
      supported: !unavailable,
      ...(unavailable ? { reasonCode: 'CONNECTION_NOT_ACTIVE' } : {}),
      ...(limits ? { limits } : {}),
    });
    return {
      capabilities: {
        automationManualMode: supported(),
        automationPausedMode: supported({
          optimisticConcurrency: 'revision',
          requiresResumeAt: true,
        }),
        clientMessageEdits: supported({ event: 'MESSAGE_EDITED', externalDeletionEvents: false }),
        chatActions: supported({ ttlSeconds: 5 }),
        deleteMessage: supported({ maximumAgeHours: 48 }),
        editMessage: supported({
          editableFields: ['text', 'caption', 'entities', 'inlineKeyboard', 'linkPreviewOptions'],
          immutableFields: [
            'protectContent',
            'messageEffectId',
            'replyToMessageId',
            'quote',
            'quotePosition',
          ],
          maximumTextLength: 4096,
          omissionSemantics: {
            entities: 'cleared_when_text_or_caption_is_replaced_without_entities',
            inlineKeyboard: 'preserved_when_omitted',
            linkPreviewOptions: 'telegram_default_when_omitted',
          },
          preservedFields: [
            'protectContent',
            'messageEffectId',
            'replyToMessageId',
            'quote',
            'quotePosition',
          ],
        }),
        explicitRetry: supported({ terminalStatus: 'FAILED', unknownRequires: 'reconciliation' }),
        externalDeletionEvents: {
          supported: false,
          reasonCode: 'BOT_API_NO_DELETE_EVENT',
        },
        formattingEntities: supported({ offsets: 'UTF-16' }),
        inlineKeyboard: supported({ maximumButtonsPerRow: 8, maximumRows: 8 }),
        linkPreviewOptions: supported({ allowedProtocols: 'http,https' }),
        mediaGroups: supported({
          itemCount: { maximum: 10, minimum: 2 },
          kinds: ['PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT'],
          mixedKinds: ['PHOTO', 'VIDEO'],
        }),
        mediaSpoilers: supported({ mediaKinds: ['ANIMATION', 'PHOTO', 'VIDEO'] }),
        messageEffects: supported({
          availableEffects: [],
          catalogAvailable: false,
          catalogReasonCode: 'BOT_API_EFFECT_CATALOG_UNAVAILABLE',
          editable: false,
          privateChatsOnly: true,
          repeatableOnNewMessages: true,
        }),
        botInterface: supported({
          commands: true,
          menuButton: true,
          scopes: ['default', 'all_private_chats', 'chat'],
        }),
        contactShare: supported({ automaticPhoneMerge: false, inbound: true, outbound: true }),
        externalActions: { supported: false, reasonCode: 'EXTERNAL_ACTIONS_NOT_RELEASED' },
        pinMessage: supported(),
        protectContent: supported(),
        quote: supported({ maximumLength: 1024, requiresReplyToMessage: true }),
        reactions: supported({ maximumBotReactions: 1, paidReactions: false }),
        userReactionEvents: supported({ contractPublished: true, privateChatsOnly: true }),
        scheduling: supported({
          applicationOwned: true,
          frequencies: ['DAILY', 'WEEKLY'],
          maximumCount: 1_000,
          maximumInterval: 30,
          optimisticConcurrency: 'revision',
          recurring: true,
          timezone: 'IANA',
        }),
        stickers: supported({
          animatedMaximumBytes: 64 * 1024,
          captions: false,
          formats: ['TGS', 'WEBM', 'WEBP'],
          staticMaximumBytes: 512 * 1024,
          videoMaximumBytes: 256 * 1024,
        }),
        structuredMessages: supported({ types: ['contact', 'location', 'poll'] }),
        replyKeyboard: supported({
          buttonTypes: ['text', 'request_contact', 'request_location'],
          forceReply: true,
          maximumButtonsPerRow: 8,
          maximumRows: 8,
          remove: true,
        }),
        richMessages: supported({
          externalMediaUrls: false,
          format: 'markdown',
          maximumMediaAssets: 1,
          maximumUtf8Bytes: 32_768,
          nativeTelegram: true,
        }),
        streamingDraft: supported({
          mediaDirectUpload: false,
          mediaReuseOnly: true,
          modes: ['text', 'rich_markdown'],
          privateChatsOnly: true,
          ttlSeconds: 30,
        }),
      },
      contractVersion: '3.3.0',
      telegramBotApiVersion: '10.2',
    };
  }

  async botInterface(
    query: CrmBotInterfaceQueryDto,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    await this.assertProject(query.crmProjectId, query.omnicusProjectId, authenticatedProjectId);
    const connection = await this.database.client.channelConnection.findUnique({
      where: { projectId_id: { id: query.connectionId, projectId: query.omnicusProjectId } },
    });
    if (!connection || connection.type !== 'TELEGRAM')
      throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
    return (
      (await this.database.client.telegramBotInterface.findUnique({
        select: {
          commandScope: true,
          commands: true,
          languageCode: true,
          menuButton: true,
          revision: true,
          updatedAt: true,
        },
        where: {
          projectId_connectionId: {
            connectionId: query.connectionId,
            projectId: query.omnicusProjectId,
          },
        },
      })) ?? {
        commandScope: { type: 'default' },
        commands: [],
        languageCode: '',
        menuButton: { type: 'default' },
        revision: 0,
        updatedAt: null,
      }
    );
  }

  async setBotInterface(
    dto: CrmBotInterfaceDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    await this.assertProject(dto.crmProjectId, dto.omnicusProjectId, authenticatedProjectId);
    const connection = await this.database.client.channelConnection.findUnique({
      where: { projectId_id: { id: dto.connectionId, projectId: dto.omnicusProjectId } },
    });
    if (!connection || connection.type !== 'TELEGRAM' || connection.status !== 'ACTIVE')
      throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND' });
    const commands = dto.commands.map((value) => {
      const command =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      if (
        !command ||
        typeof command.command !== 'string' ||
        !/^[a-z0-9_]{1,32}$/.test(command.command) ||
        typeof command.description !== 'string' ||
        command.description.length < 1 ||
        command.description.length > 256
      )
        throw new ConflictException({ code: 'BOT_COMMAND_INVALID' });
      return { command: command.command, description: command.description };
    });
    const scope = await this.validateBotScope(dto);
    const menuButton = this.validateMenuButton(dto.menuButton);
    const storedKey = `crm-bot-interface-${idempotencyKey}`;
    const existingOutbox = await this.database.client.outboxRecord.findUnique({
      where: {
        projectId_idempotencyKey: { idempotencyKey: storedKey, projectId: dto.omnicusProjectId },
      },
    });
    if (existingOutbox)
      return { operationId: existingOutbox.id, replayed: true, status: 'QUEUED' as const };
    const result = await this.database.client.$transaction(async (transaction) => {
      const current = await transaction.telegramBotInterface.findUnique({
        where: {
          projectId_connectionId: {
            connectionId: dto.connectionId,
            projectId: dto.omnicusProjectId,
          },
        },
      });
      if ((current?.revision ?? 0) !== dto.expectedRevision)
        throw new ConflictException({ code: 'BOT_INTERFACE_REVISION_CONFLICT' });
      const outbox = await transaction.outboxRecord.create({
        data: {
          connectionId: dto.connectionId,
          idempotencyKey: storedKey,
          kind: 'TELEGRAM',
          nextAttemptAt: new Date(),
          payload: {},
          projectId: dto.omnicusProjectId,
        },
      });
      const config = current
        ? await transaction.telegramBotInterface.update({
            data: {
              commandScope: scope,
              commands,
              languageCode: dto.languageCode ?? '',
              menuButton,
              outboxRecordId: outbox.id,
              revision: { increment: 1 },
            },
            where: { projectId_id: { id: current.id, projectId: dto.omnicusProjectId } },
          })
        : await transaction.telegramBotInterface.create({
            data: {
              commandScope: scope,
              commands,
              connectionId: dto.connectionId,
              languageCode: dto.languageCode ?? '',
              menuButton,
              outboxRecordId: outbox.id,
              projectId: dto.omnicusProjectId,
              revision: 1,
            },
          });
      await transaction.outboxRecord.update({
        data: {
          payload: {
            action: 'CONFIGURE_BOT_INTERFACE',
            botInterfaceId: config.id,
            correlationId,
          },
        },
        where: { projectId_id: { id: outbox.id, projectId: dto.omnicusProjectId } },
      });
      return { operationId: outbox.id, revision: config.revision };
    });
    try {
      await this.outboundQueue.enqueue(result.operationId);
    } catch {
      this.logger.warn({
        message: 'crm_bot_interface_enqueue_failed',
        operationId: result.operationId,
      });
    }
    return { ...result, replayed: false, status: 'QUEUED' as const };
  }

  private async validateBotScope(dto: CrmBotInterfaceDto): Promise<Prisma.InputJsonObject> {
    const type = dto.scope.type;
    if (type === 'default' || type === 'all_private_chats') return { type };
    if (type !== 'chat' || typeof dto.scope.channelIdentityId !== 'string')
      throw new ConflictException({ code: 'BOT_COMMAND_SCOPE_INVALID' });
    const identity = await this.database.client.channelIdentity.findUnique({
      where: {
        projectId_id: {
          id: dto.scope.channelIdentityId,
          projectId: dto.omnicusProjectId,
        },
      },
    });
    if (!identity || identity.connectionId !== dto.connectionId)
      throw new NotFoundException({ code: 'CHANNEL_IDENTITY_NOT_FOUND' });
    return { channelIdentityId: identity.id, type: 'chat' };
  }

  private validateMenuButton(value: Record<string, unknown>): Prisma.InputJsonObject {
    if (value.type === 'default' || value.type === 'commands') return { type: value.type };
    if (
      value.type !== 'web_app' ||
      typeof value.text !== 'string' ||
      value.text.length < 1 ||
      value.text.length > 64 ||
      typeof value.url !== 'string'
    )
      throw new ConflictException({ code: 'BOT_MENU_BUTTON_INVALID' });
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      throw new ConflictException({ code: 'BOT_MENU_BUTTON_INVALID' });
    }
    if (url.protocol !== 'https:') throw new ConflictException({ code: 'BOT_MENU_BUTTON_INVALID' });
    return { text: value.text, type: 'web_app', url: url.toString() };
  }

  async automationState(
    query: CrmAutomationStateQueryDto,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    const route = await this.resolveIdentity(
      {
        crmProjectId: query.crmProjectId,
        identity: {
          channel: 'telegram',
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
          externalChatId: route.externalChatId,
          projectId: route.projectId,
        },
      },
    });
    return {
      changedAt: conversation?.updatedAt?.toISOString() ?? null,
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
    authenticatedProjectId?: CommunicationProjectScope,
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
          scope: 'crm-automation-state',
        },
      },
    });
    if (existing) {
      const replay = this.automationStateReplay(existing.resultSafe);
      if (!replay || JSON.stringify(replay.request) !== JSON.stringify(request))
        throw new ConflictException({ code: 'AUTOMATION_IDEMPOTENCY_CONFLICT' });
      return replay.response;
    }
    const resumeAt = dto.resumeAt ? new Date(dto.resumeAt) : undefined;
    if (dto.mode === 'PAUSED' && (!resumeAt || resumeAt.getTime() <= Date.now()))
      throw new ConflictException({ code: 'AUTOMATION_RESUME_AT_REQUIRED' });
    if (dto.mode !== 'PAUSED' && resumeAt)
      throw new ConflictException({ code: 'AUTOMATION_RESUME_AT_NOT_ALLOWED' });
    return this.database.client.$transaction(async (transaction) => {
      const key = {
        connectionId: route.connectionId,
        externalChatId: route.externalChatId,
        projectId: route.projectId,
      };
      let current = await transaction.conversation.findUnique({
        where: { projectId_connectionId_externalChatId: key },
      });
      if (!current) {
        if (dto.expectedRevision !== 0)
          throw new ConflictException({ code: 'AUTOMATION_REVISION_CONFLICT' });
        current = await transaction.conversation.create({
          data: {
            automationModeOverride: dto.mode === 'AUTO' ? 'ENABLED' : 'DISABLED',
            ...(dto.reasonCode ? { automationReasonCode: dto.reasonCode } : {}),
            ...(resumeAt ? { automationResumeAt: resumeAt } : {}),
            automationRevision: 1,
            automationState: dto.mode,
            connectionId: route.connectionId,
            contactId: dto.omnicusContactId,
            externalChatId: route.externalChatId,
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
            id: current.id,
            projectId: route.projectId,
          },
        });
        if (updated.count !== 1)
          throw new ConflictException({ code: 'AUTOMATION_REVISION_CONFLICT' });
        current = (await transaction.conversation.findUnique({
          where: { projectId_id: { id: current.id, projectId: route.projectId } },
        }))!;
      }
      await this.queueAutomationStateForCrm(
        transaction,
        current,
        dto.omnicusContactId,
        correlationId,
      );
      const response = {
        changedAt: current.updatedAt.toISOString(),
        mode: dto.mode,
        reasonCode: current.automationReasonCode,
        resumeAt: current.automationResumeAt?.toISOString() ?? null,
        revision: current.automationRevision,
      };
      await transaction.idempotencyRecord.create({
        data: {
          key: idempotencyKey,
          projectId: route.projectId,
          resultSafe: { request, response },
          scope: 'crm-automation-state',
        },
      });
      return response;
    });
  }

  private automationStateReplay(value: Prisma.JsonValue | null | undefined):
    | {
        request: {
          expectedRevision: number;
          mode: 'AUTO' | 'MANUAL' | 'PAUSED';
          reasonCode: string | null;
          resumeAt: string | null;
        };
        response: {
          changedAt: string;
          mode: 'AUTO' | 'MANUAL' | 'PAUSED';
          reasonCode: string | null;
          resumeAt: string | null;
          revision: number;
        };
      }
    | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const request = value.request;
    const response = value.response;
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      !response ||
      typeof response !== 'object' ||
      Array.isArray(response) ||
      !Number.isSafeInteger(request.expectedRevision) ||
      !['AUTO', 'MANUAL', 'PAUSED'].includes(String(request.mode)) ||
      (request.reasonCode !== null && typeof request.reasonCode !== 'string') ||
      (request.resumeAt !== null && typeof request.resumeAt !== 'string') ||
      typeof response.changedAt !== 'string' ||
      !['AUTO', 'MANUAL', 'PAUSED'].includes(String(response.mode)) ||
      (response.reasonCode !== null && typeof response.reasonCode !== 'string') ||
      (response.resumeAt !== null && typeof response.resumeAt !== 'string') ||
      !Number.isSafeInteger(response.revision)
    )
      return undefined;
    return { request, response } as ReturnType<CrmTelegramV3Service['automationStateReplay']>;
  }

  private async queueAutomationStateForCrm(
    transaction: Prisma.TransactionClient,
    conversation: {
      automationReasonCode: string | null;
      automationResumeAt: Date | null;
      automationRevision: number;
      automationState: string;
      contactId: string;
      connectionId: string;
      id: string;
      projectId: string;
      updatedAt: Date;
    },
    contactId: string,
    correlationId: string,
  ) {
    const crm = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId: conversation.projectId },
    });
    if (!crm?.enabled || crm.status !== 'ACTIVE') return;
    const idempotencyKey = `crm-automation-state-${conversation.id}-${conversation.automationRevision}`;
    await transaction.outboxRecord.createMany({
      data: [{ idempotencyKey, kind: 'CRM', payload: {}, projectId: conversation.projectId }],
      skipDuplicates: true,
    });
    const outbox = await transaction.outboxRecord.findUnique({
      include: { crmOperation: { select: { id: true } } },
      where: {
        projectId_idempotencyKey: { idempotencyKey, projectId: conversation.projectId },
      },
    });
    if (!outbox || outbox.crmOperation) return;
    const operation = await transaction.crmOperation.create({
      data: {
        contactId,
        inputSafe: {
          changedAt: conversation.updatedAt.toISOString(),
          connectionId: conversation.connectionId,
          conversationId: conversation.id,
          correlationId,
          mode: conversation.automationState,
          reasonCode: conversation.automationReasonCode,
          resumeAt: conversation.automationResumeAt?.toISOString() ?? null,
          revision: conversation.automationRevision,
        },
        outboxRecordId: outbox.id,
        projectId: conversation.projectId,
        type: 'FORWARD_AUTOMATION_STATE',
      },
    });
    await transaction.outboxRecord.update({
      data: { payload: { crmOperationId: operation.id } },
      where: { projectId_id: { id: outbox.id, projectId: conversation.projectId } },
    });
  }

  async chatAction(dto: CrmChatActionDto, authenticatedProjectId?: CommunicationProjectScope) {
    const route = await this.resolveIdentity(dto, authenticatedProjectId);
    const actions = {
      RECORD_VIDEO_NOTE: 'record_video_note',
      RECORD_VOICE: 'record_voice',
      TYPING: 'typing',
      UPLOAD_DOCUMENT: 'upload_document',
      UPLOAD_PHOTO: 'upload_photo',
      UPLOAD_VIDEO: 'upload_video',
    } as const;
    await this.adapter.sendChatAction(this.tokenFor(route), {
      action: actions[dto.action],
      chatId: route.externalChatId,
    });
    return { accepted: true, expiresAt: new Date(Date.now() + 5_000).toISOString() };
  }

  async draft(dto: CrmDraftDto, authenticatedProjectId?: CommunicationProjectScope) {
    if (dto.text && dto.richMessage)
      throw new ConflictException({ code: 'DRAFT_CONTENT_CONFLICT' });
    if (!dto.text && !dto.richMessage)
      return {
        accepted: false,
        expiresAt: null,
        reasonCode: 'EMPTY_DRAFT_IGNORED',
      };
    const route = await this.resolveIdentity(dto, authenticatedProjectId);
    if (dto.richMessage) {
      const rich = await this.richDraft(dto.richMessage, route.projectId, route.connectionId);
      await this.adapter.sendRichMessageDraft(this.tokenFor(route), {
        chatId: route.externalChatId,
        draftId: dto.draftId,
        richMessage: rich,
      });
      return { accepted: true, expiresAt: new Date(Date.now() + 30_000).toISOString() };
    }
    let entities: TelegramMessageEntity[] | undefined;
    try {
      entities = dto.entities
        ? validateTelegramMessageEntities(dto.entities, dto.text!)
        : undefined;
    } catch {
      throw new ConflictException({ code: 'MESSAGE_ENTITIES_INVALID' });
    }
    await this.adapter.sendMessageDraft(this.tokenFor(route), {
      chatId: route.externalChatId,
      draftId: dto.draftId,
      ...(entities ? { entities } : {}),
      text: dto.text!,
    });
    return { accepted: true, expiresAt: new Date(Date.now() + 30_000).toISOString() };
  }

  private async richDraft(
    value: Record<string, unknown>,
    projectId: string,
    connectionId: string,
  ): Promise<TelegramRichMessage> {
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
      throw new ConflictException({ code: 'RICH_DRAFT_INVALID' });
    let media: TelegramRichMessage['media'];
    if (value.media !== undefined) {
      if (!value.media || typeof value.media !== 'object' || Array.isArray(value.media))
        throw new ConflictException({ code: 'RICH_DRAFT_MEDIA_INVALID' });
      const candidate = value.media as Record<string, unknown>;
      if (
        Object.keys(candidate).some((key) => !['id', 'kind', 'mediaAssetId'].includes(key)) ||
        typeof candidate.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(candidate.id) ||
        typeof candidate.kind !== 'string' ||
        !['ANIMATION', 'AUDIO', 'PHOTO', 'VIDEO', 'VOICE'].includes(candidate.kind) ||
        typeof candidate.mediaAssetId !== 'string'
      )
        throw new ConflictException({ code: 'RICH_DRAFT_MEDIA_INVALID' });
      const asset = await this.database.client.mediaAsset.findFirst({
        select: { providerMediaId: true },
        where: {
          connectionId,
          id: candidate.mediaAssetId,
          kind: candidate.kind as 'ANIMATION' | 'AUDIO' | 'PHOTO' | 'VIDEO' | 'VOICE',
          projectId,
          providerMediaId: { not: null },
        },
      });
      if (!asset?.providerMediaId)
        throw new ConflictException({ code: 'RICH_DRAFT_MEDIA_NOT_REUSABLE' });
      media = {
        id: candidate.id,
        kind: candidate.kind as 'ANIMATION' | 'AUDIO' | 'PHOTO' | 'VIDEO' | 'VOICE',
        media: asset.providerMediaId,
      };
    }
    return {
      ...(value.isRtl === true ? { isRtl: true } : {}),
      markdown: value.markdown,
      ...(media ? { media } : {}),
      ...(value.skipEntityDetection === true ? { skipEntityDetection: true } : {}),
    };
  }

  async mediaGroup(
    dto: CrmMediaGroupDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    const route = await this.resolveIdentity(dto, authenticatedProjectId);
    const kinds = new Set(dto.items.map((item) => item.kind));
    if ((kinds.has('AUDIO') && kinds.size !== 1) || (kinds.has('DOCUMENT') && kinds.size !== 1))
      throw new ConflictException({ code: 'MEDIA_GROUP_KIND_COMBINATION_INVALID' });
    const storedKey = `crm-media-group-${idempotencyKey}`;
    const existing = await this.database.client.outboxRecord.findUnique({
      include: { telegramMediaGroup: true },
      where: {
        projectId_idempotencyKey: { idempotencyKey: storedKey, projectId: route.projectId },
      },
    });
    if (existing?.telegramMediaGroup)
      return {
        mediaGroupId: existing.telegramMediaGroup.id,
        operationId: existing.id,
        replayed: true,
        status: 'QUEUED' as const,
      };
    const items = dto.items.map((item, position) => {
      let entities: TelegramMessageEntity[] | undefined;
      if (item.hasSpoiler && !['PHOTO', 'VIDEO'].includes(item.kind))
        throw new ConflictException({ code: 'MEDIA_GROUP_SPOILER_INVALID' });
      try {
        entities = item.entities
          ? validateTelegramMessageEntities(item.entities, item.caption ?? '')
          : undefined;
      } catch {
        throw new ConflictException({ code: 'MEDIA_GROUP_ENTITIES_INVALID' });
      }
      return { ...item, entities, position };
    });
    const result = await this.database.client.$transaction(async (transaction) => {
      for (const item of items) {
        const asset = await transaction.mediaAsset.findFirst({
          select: { id: true },
          where: {
            id: item.mediaAssetId,
            kind: item.kind,
            projectId: route.projectId,
            status: { in: ['AVAILABLE', 'PROVIDER_REFERENCE'] },
          },
        });
        if (!asset) throw new NotFoundException({ code: 'MEDIA_GROUP_ASSET_NOT_FOUND' });
      }
      const outbox = await transaction.outboxRecord.create({
        data: {
          connectionId: route.connectionId,
          idempotencyKey: storedKey,
          kind: 'TELEGRAM',
          nextAttemptAt: new Date(),
          payload: {},
          projectId: route.projectId,
        },
      });
      const group = await transaction.telegramMediaGroup.create({
        data: {
          channelIdentityId: dto.identity.channelIdentityId,
          connectionId: route.connectionId,
          contactId: dto.omnicusContactId,
          disableNotification: dto.disableNotification ?? false,
          items: {
            create: items.map((item) => ({
              ...(item.caption === undefined ? {} : { caption: item.caption }),
              ...(item.entities
                ? { entities: item.entities as unknown as Prisma.InputJsonValue }
                : {}),
              hasSpoiler: item.hasSpoiler ?? false,
              kind: item.kind,
              mediaAsset: {
                connect: {
                  projectId_id: { id: item.mediaAssetId, projectId: route.projectId },
                },
              },
              position: item.position,
            })),
          },
          outboxRecordId: outbox.id,
          projectId: route.projectId,
          protectContent: dto.protectContent ?? false,
        },
      });
      if (
        typeof authenticatedProjectId === 'object' &&
        authenticatedProjectId.source === 'omnicus'
      ) {
        const now = new Date();
        const conversation = await transaction.conversation.upsert({
          where: {
            projectId_connectionId_externalChatId: {
              projectId: route.projectId,
              connectionId: route.connectionId,
              externalChatId: route.externalChatId,
            },
          },
          create: {
            projectId: route.projectId,
            connectionId: route.connectionId,
            contactId: dto.omnicusContactId,
            externalChatId: route.externalChatId,
            lastMessageAt: now,
          },
          update: { lastMessageAt: now },
        });
        for (const item of items) {
          await transaction.message.create({
            data: {
              projectId: route.projectId,
              connectionId: route.connectionId,
              contactId: dto.omnicusContactId,
              conversationId: conversation.id,
              direction: 'OUTBOUND',
              type: item.kind,
              status: 'QUEUED',
              mediaAssetId: item.mediaAssetId,
              createdAt: new Date(now.getTime() + item.position),
              content: { caption: item.caption ?? '' },
              metadata: {
                source: 'omnicus',
                mediaGroupId: group.id,
                mediaGroupPosition: item.position,
                hasSpoiler: item.hasSpoiler ?? false,
                disableNotification: dto.disableNotification ?? false,
                protectContent: dto.protectContent ?? false,
                ...(item.entities
                  ? { entities: item.entities.map((entity) => ({ ...entity })) }
                  : {}),
              } satisfies Prisma.InputJsonObject,
            },
          });
        }
        await transaction.contact.update({
          where: { projectId_id: { projectId: route.projectId, id: dto.omnicusContactId } },
          data: { lastInteractionAt: now },
        });
      }
      await transaction.outboxRecord.update({
        data: {
          payload: {
            action: 'SEND_MEDIA_GROUP',
            channelIdentityId: dto.identity.channelIdentityId,
            correlationId,
            mediaGroupId: group.id,
          },
        },
        where: { projectId_id: { id: outbox.id, projectId: route.projectId } },
      });
      return { mediaGroupId: group.id, operationId: outbox.id };
    });
    try {
      await this.outboundQueue.enqueue(result.operationId);
    } catch {
      this.logger.warn({
        message: 'crm_media_group_enqueue_failed',
        operationId: result.operationId,
      });
    }
    return { ...result, replayed: false, status: 'QUEUED' as const };
  }

  async edit(
    messageId: string,
    dto: CrmMessageMutationDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    if (!dto.text && dto.caption === undefined && dto.inlineKeyboard === undefined)
      throw new ConflictException({ code: 'MESSAGE_MUTATION_REQUIRED' });
    const target = await this.resolveMessage(messageId, dto, authenticatedProjectId);
    if (target.direction !== 'OUTBOUND')
      throw new ConflictException({ code: 'MESSAGE_NOT_EDITABLE' });
    const contentText = dto.text ?? dto.caption ?? '';
    let entities: TelegramMessageEntity[] | undefined;
    let inlineKeyboard;
    let linkPreviewOptions;
    try {
      entities = dto.entities
        ? validateTelegramMessageEntities(dto.entities, contentText)
        : undefined;
      inlineKeyboard = dto.inlineKeyboard
        ? validateTelegramInlineKeyboard(dto.inlineKeyboard)
        : undefined;
      linkPreviewOptions = dto.linkPreviewOptions
        ? validateTelegramLinkPreviewOptions(dto.linkPreviewOptions)
        : undefined;
    } catch {
      throw new ConflictException({ code: 'MESSAGE_MUTATION_INVALID' });
    }
    return this.queueAction(
      'EDIT_MESSAGE',
      target,
      {
        ...(dto.caption === undefined ? {} : { caption: dto.caption }),
        ...(entities ? { entities } : {}),
        ...(inlineKeyboard ? { inlineKeyboard } : {}),
        ...(linkPreviewOptions ? { linkPreviewOptions } : {}),
        ...(dto.text ? { text: dto.text } : {}),
      },
      idempotencyKey,
      correlationId,
    );
  }

  async delete(
    messageId: string,
    dto: CrmTelegramScopeDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    const target = await this.resolveMessage(messageId, dto, authenticatedProjectId);
    return this.queueAction('DELETE_MESSAGE', target, {}, idempotencyKey, correlationId);
  }

  async reaction(
    messageId: string,
    dto: CrmReactionDto | CrmTelegramScopeDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    const target = await this.resolveMessage(messageId, dto, authenticatedProjectId);
    if (('emoji' in dto && dto.emoji !== undefined) || ('type' in dto && (!dto.type || !dto.value)))
      throw new ConflictException({ code: 'REACTION_INVALID' });
    const reaction: TelegramReaction | undefined =
      'type' in dto && dto.type && dto.value
        ? dto.type === 'emoji'
          ? { emoji: dto.value, type: 'emoji' }
          : { customEmojiId: dto.value, type: 'custom_emoji' }
        : undefined;
    return this.queueAction(
      'SET_REACTION',
      target,
      { ...('isBig' in dto && dto.isBig ? { isBig: true } : {}), reaction },
      idempotencyKey,
      correlationId,
    );
  }

  async pin(
    messageId: string,
    dto: CrmPinMessageDto,
    pinned: boolean,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    const target = await this.resolveMessage(messageId, dto, authenticatedProjectId);
    return this.queueAction(
      'PIN_MESSAGE',
      target,
      { disableNotification: dto.disableNotification ?? false, pinned },
      idempotencyKey,
      correlationId,
    );
  }

  async retry(
    operationId: string,
    dto: CrmRetryOperationDto,
    correlationId: string,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    await this.assertProject(dto.crmProjectId, dto.omnicusProjectId, authenticatedProjectId);
    const source = await this.database.client.outboxRecord.findUnique({
      where: { projectId_id: { id: operationId, projectId: dto.omnicusProjectId } },
    });
    if (!source || source.kind !== 'TELEGRAM')
      throw new NotFoundException({ code: 'OPERATION_NOT_FOUND' });
    if (source.status === 'UNKNOWN')
      throw new ConflictException({ code: 'UNKNOWN_REQUIRES_RECONCILIATION' });
    if (source.status !== 'FAILED') throw new ConflictException({ code: 'OPERATION_NOT_FAILED' });
    if (
      !source.payload ||
      typeof source.payload !== 'object' ||
      Array.isArray(source.payload) ||
      typeof (source.payload as Prisma.JsonObject).messageId !== 'string'
    )
      throw new ConflictException({ code: 'OPERATION_PAYLOAD_INVALID' });
    const sourcePayload = source.payload as Prisma.JsonObject;
    const messageId = sourcePayload.messageId as string;
    const storedKey = `crm-retry-${dto.retryRequestId}`;
    const existing = await this.database.client.outboxRecord.findUnique({
      where: {
        projectId_idempotencyKey: {
          idempotencyKey: storedKey,
          projectId: dto.omnicusProjectId,
        },
      },
    });
    const retry =
      existing ??
      (await this.database.client.outboxRecord.create({
        data: {
          connectionId: source.connectionId,
          idempotencyKey: storedKey,
          kind: 'TELEGRAM',
          maxAttempts: source.maxAttempts,
          nextAttemptAt: new Date(),
          payload: {
            ...sourcePayload,
            retryOfOperationId: source.id,
          },
          projectId: source.projectId,
        },
      }));
    try {
      await this.outboundQueue.enqueue(retry.id);
    } catch {
      this.logger.warn({ message: 'crm_retry_enqueue_failed', operationId: retry.id });
    }
    return {
      messageId,
      operationId: retry.id,
      replayed: Boolean(existing),
      status: 'QUEUED' as const,
    };
  }

  private async queueAction(
    action: V3Action,
    target: {
      channelIdentityId: string;
      connectionId: string;
      externalMessageId: string;
      messageId: string;
      projectId: string;
    },
    mutation: Record<string, unknown>,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const storedKey = `crm-v3-${idempotencyKey}`;
    let record = await this.database.client.outboxRecord.findUnique({
      where: {
        projectId_idempotencyKey: { idempotencyKey: storedKey, projectId: target.projectId },
      },
    });
    let replayed = Boolean(record);
    if (!record)
      try {
        record = await this.database.client.outboxRecord.create({
          data: {
            connectionId: target.connectionId,
            idempotencyKey: storedKey,
            kind: 'TELEGRAM',
            nextAttemptAt: new Date(),
            payload: {
              action,
              channelIdentityId: target.channelIdentityId,
              correlationId,
              messageId: target.messageId,
              mutation: mutation as Prisma.InputJsonObject,
              providerMessageId: target.externalMessageId,
            } as Prisma.InputJsonObject,
            projectId: target.projectId,
          },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
          throw error;
        record = await this.database.client.outboxRecord.findUnique({
          where: {
            projectId_idempotencyKey: {
              idempotencyKey: storedKey,
              projectId: target.projectId,
            },
          },
        });
        replayed = true;
      }
    if (!record) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
    try {
      await this.outboundQueue.enqueue(record.id);
    } catch {
      this.logger.warn({ message: 'crm_v3_enqueue_failed', operationId: record.id });
    }
    return {
      messageId: target.messageId,
      operationId: record.id,
      replayed,
      status: 'QUEUED' as const,
    };
  }

  private async resolveMessage(
    messageId: string,
    dto: CrmTelegramScopeDto,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    const route = await this.resolveIdentity(dto, authenticatedProjectId);
    const message = await this.database.client.message.findFirst({
      where: {
        connectionId: dto.identity.connectionId,
        contactId: dto.omnicusContactId,
        externalMessageId: { not: null },
        id: messageId,
        projectId: dto.omnicusProjectId,
      },
    });
    if (!message?.externalMessageId) throw new NotFoundException({ code: 'MESSAGE_NOT_FOUND' });
    return {
      channelIdentityId: dto.identity.channelIdentityId,
      connectionId: route.connectionId,
      direction: message.direction,
      externalMessageId: message.externalMessageId,
      messageId: message.id,
      projectId: message.projectId,
    };
  }

  private async resolveIdentity(
    dto: CrmTelegramScopeDto,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    await this.assertProject(dto.crmProjectId, dto.omnicusProjectId, authenticatedProjectId);
    const identity = await this.database.client.channelIdentity.findUnique({
      include: { connection: true },
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
      identity.channel !== 'TELEGRAM' ||
      identity.status !== 'ACTIVE' ||
      identity.connection.type !== 'TELEGRAM' ||
      identity.connection.status !== 'ACTIVE'
    )
      throw new NotFoundException({ code: 'CHANNEL_IDENTITY_NOT_FOUND' });
    return {
      connectionId: identity.connectionId,
      credentialsEncrypted: identity.connection.credentialsEncrypted,
      externalChatId: identity.externalUserId,
      projectId: identity.connection.projectId,
    };
  }

  private tokenFor(route: {
    connectionId: string;
    credentialsEncrypted: unknown;
    projectId: string;
  }): string {
    return this.secrets.decryptSecret({
      projectId: route.projectId,
      channelConnectionId: route.connectionId,
      channelType: 'telegram',
      field: 'botToken',
      envelope: route.credentialsEncrypted as EncryptedSecretEnvelope,
    });
  }

  private async assertProject(
    crmProjectId: string,
    omnicusProjectId: string,
    authenticatedProjectId?: CommunicationProjectScope,
  ) {
    const project = await this.database.client.project.findUnique({
      include: { crmConfig: true },
      where: { id: omnicusProjectId },
    });
    const native = typeof authenticatedProjectId === 'object' ? authenticatedProjectId : undefined;
    const expectedProjectId = native?.projectId ?? authenticatedProjectId;
    if (
      (expectedProjectId && expectedProjectId !== omnicusProjectId) ||
      !project ||
      project.status !== 'ACTIVE' ||
      (native
        ? native.source !== 'omnicus' || crmProjectId !== omnicusProjectId
        : !project.crmConfig?.enabled || project.crmConfig.crmProjectId !== crmProjectId)
    )
      throw new NotFoundException({ code: 'CRM_PROJECT_ROUTE_NOT_FOUND' });
  }
}
