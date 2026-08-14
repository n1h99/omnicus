import { createHash, randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnvironment } from '@omnicus/config/server';
import { ChannelSecretsService, type EncryptedSecretEnvelope } from '@omnicus/channel-secrets';
import { TelegramAdapter, TelegramHttpTransport } from '@omnicus/channel-telegram';
import { assertWhatsAppMedia, WhatsAppApiError, WhatsAppCloudApi } from '@omnicus/channel-whatsapp';
import {
  CrmClientError,
  type CrmClient,
  type CrmIdentityInput,
  type CrmInteractiveInput,
  type CrmInlineKeyboardInput,
  type CrmLinkPreviewOptionsInput,
  type CrmMessageEntityInput,
  type CrmMediaInput,
  type CrmReactionActorInput,
  type CrmReactionInput,
  type ForwardMessageStatusInput,
} from '@omnicus/crm-core';
import { Prisma } from '@omnicus/database';
import { prepareMediaForTelegram, S3MediaStorage, type MediaKind } from '@omnicus/media-core';

import { DatabaseService } from '../database/database.service';
import { crmOutboundHistorySource, ensureCrmOutboundHistoryIntent } from './crm-outbound-history';
import { CRM_CLIENT } from './crm.tokens';

@Injectable()
export class CrmOutboxService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CrmOutboxService.name);
  private readonly workerId = `crm-outbox-${process.pid}-${randomUUID()}`;
  private readonly maximumMediaBytes: number;
  private readonly mediaRetentionDays: number;
  private readonly signedUrlTtlSeconds: number;
  private readonly secrets: ChannelSecretsService;
  private readonly storage: S3MediaStorage | undefined;
  private readonly telegram = new TelegramAdapter(new TelegramHttpTransport());
  private readonly whatsApp = new WhatsAppCloudApi();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CRM_CLIENT) private readonly client: CrmClient,
  ) {
    this.maximumMediaBytes = config.get('MEDIA_MAX_UPLOAD_BYTES', { infer: true });
    this.mediaRetentionDays = config.get('MEDIA_RETENTION_DAYS', { infer: true });
    this.signedUrlTtlSeconds = config.get('MEDIA_SIGNED_URL_TTL_SECONDS', { infer: true });
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

  onApplicationBootstrap(): void {
    if (!this.config.get('CRM_INTEGRATION_ENABLED', { infer: true })) return;
    this.timer = setInterval(
      () => void this.scanOnce(),
      this.config.get('CRM_OUTBOX_INTERVAL_MS', { infer: true }),
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async scanOnce(now = new Date()): Promise<void> {
    if (!this.config.get('CRM_INTEGRATION_ENABLED', { infer: true }) || this.scanning) return;
    this.scanning = true;
    try {
      await this.recoverOutboundHistory();
      const leaseExpiredBefore = new Date(
        now.getTime() - this.config.get('CRM_OUTBOX_LEASE_MS', { infer: true }),
      );
      const rows = await this.database.client.outboxRecord.findMany({
        orderBy: { createdAt: 'asc' },
        take: 25,
        where: {
          kind: 'CRM',
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
    } finally {
      this.scanning = false;
    }
  }

  async recoverOutboundHistory(): Promise<number> {
    const messages = await this.database.client.message.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, projectId: true },
      take: 25,
      where: {
        crmOperations: { none: {} },
        direction: 'OUTBOUND',
        status: 'SENT',
        OR: [
          { metadata: { path: ['source'], equals: 'automation' } },
          { metadata: { path: ['source'], equals: 'broadcast' } },
          { metadata: { path: ['broadcastId'], not: Prisma.AnyNull } },
        ],
      },
    });
    let queued = 0;
    for (const message of messages)
      if (
        await this.database.client.$transaction((transaction) =>
          ensureCrmOutboundHistoryIntent(transaction, message.projectId, message.id),
        )
      )
        queued += 1;
    if (queued)
      this.logger.log({
        count: queued,
        message: 'crm_outbound_history_recovered',
      });
    return queued;
  }

  private async process(
    outboxRecordId: string,
    now: Date,
    leaseExpiredBefore: Date,
  ): Promise<void> {
    const leaseToken = `${this.workerId}-${randomUUID()}`;
    const claimed = await this.database.client.outboxRecord.updateMany({
      data: {
        attempts: { increment: 1 },
        lastError: null,
        lockedAt: now,
        lockedBy: leaseToken,
        status: 'PROCESSING',
      },
      where: {
        id: outboxRecordId,
        kind: 'CRM',
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

    const operation = await this.database.client.crmOperation.findUnique({
      include: {
        contact: {
          include: {
            channelIdentities: {
              orderBy: { createdAt: 'asc' },
              where: { channel: { in: ['TELEGRAM', 'WHATSAPP'] } },
            },
            customFieldValues: {
              include: { definition: { select: { key: true } } },
            },
            tags: { include: { tag: { select: { id: true, name: true } } } },
          },
        },
        normalizedEvent: {
          include: {
            inboxRecord: {
              select: {
                rawWebhookEvent: { select: { correlationId: true } },
              },
            },
            message: {
              include: {
                conversation: { select: { externalChatId: true } },
                mediaAsset: true,
              },
            },
          },
        },
        message: {
          include: {
            connection: { select: { botUsername: true } },
            conversation: { select: { externalChatId: true } },
            mediaAsset: true,
          },
        },
        outbox: { select: { attempts: true, maxAttempts: true } },
        project: { include: { crmConfig: true } },
      },
      where: { outboxRecordId },
    });
    if (!operation?.project.crmConfig?.enabled || !operation.contact) {
      await this.finish(
        outboxRecordId,
        leaseToken,
        'FAILED',
        'crm_configuration_or_contact_missing',
      );
      return;
    }

    const connectionId =
      operation.normalizedEvent?.connectionId ??
      operation.message?.connectionId ??
      this.stringProperty(operation.inputSafe, 'connectionId');
    const identityRow = connectionId
      ? operation.contact.channelIdentities.find(
          (identity) => identity.connectionId === connectionId,
        )
      : operation.type === 'CREATE_OR_UPDATE_LEAD'
        ? operation.contact.channelIdentities[0]
        : undefined;
    if (
      !identityRow &&
      operation.type !== 'MERGE_CONTACTS' &&
      operation.type !== 'CREATE_OR_UPDATE_LEAD' &&
      operation.type !== 'FORWARD_TRACKED_LINK_CLICK'
    ) {
      await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_channel_identity_missing');
      return;
    }

    const externalChatId =
      operation.normalizedEvent?.message?.conversation.externalChatId ??
      operation.message?.conversation.externalChatId ??
      this.stringProperty(operation.normalizedEvent?.payload, 'chatId');
    const identity: CrmIdentityInput = identityRow
      ? {
          channel: identityRow.channel === 'WHATSAPP' ? 'whatsapp' : 'telegram',
          channelIdentityId: identityRow.id,
          connectionId: identityRow.connectionId,
          ...(externalChatId ? { externalChatId } : {}),
          externalUserId: identityRow.externalUserId,
        }
      : {
          channel: 'telegram',
          channelIdentityId: 'contact-merge',
          connectionId: 'contact-merge',
        };
    const whatsAppIdentity = operation.contact.channelIdentities.find(
      (candidate) =>
        candidate.channel === 'WHATSAPP' &&
        (!connectionId || candidate.connectionId === connectionId),
    );
    const whatsAppReachability = whatsAppIdentity?.whatsAppReachability ?? 'UNKNOWN';
    const whatsAppEligibility = {
      activeForMailing:
        operation.contact.whatsAppConsentStatus === 'GRANTED' &&
        whatsAppReachability === 'AVAILABLE',
      ...(operation.contact.whatsAppConsentSource
        ? { consentSource: operation.contact.whatsAppConsentSource }
        : {}),
      consentStatus: operation.contact.whatsAppConsentStatus,
      ...(whatsAppIdentity?.whatsAppReachabilityCheckedAt
        ? { lastCheckedAt: whatsAppIdentity.whatsAppReachabilityCheckedAt.toISOString() }
        : {}),
      ...(whatsAppIdentity?.whatsAppLastErrorCode
        ? { lastErrorCode: whatsAppIdentity.whatsAppLastErrorCode }
        : {}),
      reachability: whatsAppReachability,
    };
    const context = {
      correlationId:
        operation.normalizedEvent?.inboxRecord.rawWebhookEvent.correlationId ??
        this.stringProperty(operation.inputSafe, 'correlationId') ??
        `crm-operation-${operation.id}`,
      crmProjectId: operation.project.crmConfig.crmProjectId,
      idempotencyKey: outboxRecordId,
      projectId: operation.projectId,
    };
    const inboundReplyToMessageId = this.stringProperty(
      operation.normalizedEvent?.message?.metadata,
      'replyToMessageId',
    );
    const interactive =
      operation.type === 'FORWARD_INBOUND_MESSAGE'
        ? await this.interactive(
            operation.projectId,
            connectionId,
            operation.normalizedEvent?.payload,
            inboundReplyToMessageId,
          )
        : undefined;
    const inboundContent = operation.normalizedEvent?.message?.content;
    const location = this.inboundLocation(inboundContent);
    const whatsAppContacts = this.inboundWhatsAppContacts(inboundContent);
    const inboundText =
      this.messageText(inboundContent) ??
      (interactive?.type === 'callback_query'
        ? (interactive.displayText ?? interactive.data)
        : interactive?.title);

    try {
      let result;
      if (operation.type === 'MERGE_CONTACTS') {
        const primaryContactId = this.stringProperty(operation.inputSafe, 'primaryContactId');
        const secondaryContactId = this.stringProperty(operation.inputSafe, 'secondaryContactId');
        if (!primaryContactId || !secondaryContactId) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_contact_merge_invalid');
          return;
        }
        const primaryCrmLeadId = this.stringProperty(operation.inputSafe, 'primaryCrmLeadId');
        const secondaryCrmLeadId = this.stringProperty(operation.inputSafe, 'secondaryCrmLeadId');
        result = await this.client.mergeContacts(context, {
          primaryContactId,
          ...(primaryCrmLeadId ? { primaryCrmLeadId } : {}),
          secondaryContactId,
          ...(secondaryCrmLeadId ? { secondaryCrmLeadId } : {}),
        });
      } else if (operation.type === 'FORWARD_TRACKED_LINK_CLICK') {
        const trackedLinkId = this.stringProperty(operation.inputSafe, 'trackedLinkId');
        const targetUrl = this.stringProperty(operation.inputSafe, 'targetUrl');
        const clickedAt = this.stringProperty(operation.inputSafe, 'clickedAt');
        const nodeId = this.stringProperty(operation.inputSafe, 'nodeId');
        const scenarioExecutionId = this.stringProperty(operation.inputSafe, 'scenarioExecutionId');
        if (!trackedLinkId || !targetUrl || !clickedAt || !nodeId || !scenarioExecutionId) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_tracked_link_invalid');
          return;
        }
        result = await this.client.forwardTrackedLinkClick(context, {
          clickedAt,
          contactId: operation.contact.id,
          nodeId,
          scenarioExecutionId,
          targetUrl,
          trackedLinkId,
          ...(this.stringProperty(operation.inputSafe, 'userAgent')
            ? { userAgent: this.stringProperty(operation.inputSafe, 'userAgent')! }
            : {}),
        });
      } else if (operation.type === 'CREATE_OR_UPDATE_LEAD')
        result = await this.client.createOrUpdateLead(context, {
          contactId: operation.contact.id,
          contactStatus: operation.contact.status,
          customFields: this.customFields(operation.contact),
          displayName: operation.contact.displayName,
          ...(operation.contact.email ? { email: operation.contact.email } : {}),
          ...(identityRow ? { identity } : {}),
          ...(operation.contact.phone ? { phone: operation.contact.phone } : {}),
          tags: operation.contact.tags.map(({ tag }) => tag),
          ...(operation.contact.username ? { username: operation.contact.username } : {}),
          whatsApp: whatsAppEligibility,
        });
      else if (operation.type === 'FORWARD_INBOUND_MESSAGE')
        result = await this.client.forwardInboundMessage(context, {
          contactId: operation.contact.id,
          identity,
          ...(interactive ? { interactive } : {}),
          ...(location ? { location } : {}),
          ...(await this.media(
            operation.projectId,
            connectionId,
            operation.normalizedEvent?.message?.mediaAsset,
          )),
          ...(operation.normalizedEvent?.message?.id
            ? { messageId: operation.normalizedEvent.message.id }
            : {}),
          normalizedEventId: operation.normalizedEventId ?? operation.id,
          occurredAt:
            operation.normalizedEvent?.message?.createdAt.toISOString() ??
            operation.createdAt.toISOString(),
          ...(inboundReplyToMessageId ? { replyToMessageId: inboundReplyToMessageId } : {}),
          senderName: operation.contact.displayName,
          ...(inboundText === undefined ? {} : { text: inboundText }),
          ...(whatsAppContacts ? { whatsAppContacts } : {}),
        });
      else if (operation.type === 'FORWARD_REACTION_EVENT') {
        const reaction = this.reactionEvent(operation.normalizedEvent?.payload);
        if (!reaction) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_reaction_event_invalid');
          return;
        }
        result = await this.client.forwardReactionEvent(context, {
          actor: reaction.actor,
          contactId: operation.contact.id,
          identity,
          messageId: reaction.messageId,
          newReactions: reaction.newReactions,
          normalizedEventId: operation.normalizedEventId ?? operation.id,
          occurredAt: reaction.occurredAt,
          oldReactions: reaction.oldReactions,
        });
      } else if (operation.type === 'FORWARD_MESSAGE_EDIT') {
        if (!this.client.forwardMessageEdit) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_message_edit_unsupported');
          return;
        }
        const edit = this.messageEditEvent(operation.normalizedEvent?.payload);
        if (!edit) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_message_edit_invalid');
          return;
        }
        result = await this.client.forwardMessageEdit(context, {
          contactId: operation.contact.id,
          editedAt: edit.editedAt,
          ...(edit.entities ? { entities: edit.entities } : {}),
          identity,
          messageId: edit.messageId,
          normalizedEventId: operation.normalizedEventId ?? operation.id,
          ...(edit.caption === undefined ? {} : { caption: edit.caption }),
          ...(edit.text === undefined ? {} : { text: edit.text }),
        });
      } else if (operation.type === 'FORWARD_CONTACT_SHARE') {
        if (!this.client.forwardContactShare) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_contact_share_unsupported');
          return;
        }
        const contactShare = this.contactShareEvent(operation.normalizedEvent?.payload);
        const messageId = operation.normalizedEvent?.message?.id;
        if (!contactShare || !messageId) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_contact_share_invalid');
          return;
        }
        result = await this.client.forwardContactShare(context, {
          contactId: operation.contact.id,
          identity,
          messageId,
          normalizedEventId: operation.normalizedEventId ?? operation.id,
          occurredAt:
            operation.normalizedEvent?.message?.createdAt.toISOString() ??
            operation.createdAt.toISOString(),
          sharedContact: contactShare,
        });
      } else if (operation.type === 'FORWARD_AUTOMATION_STATE') {
        if (!this.client.forwardAutomationState) {
          await this.finish(
            outboxRecordId,
            leaseToken,
            'FAILED',
            'crm_automation_state_unsupported',
          );
          return;
        }
        const state = this.automationStateEvent(operation.inputSafe);
        if (!state) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_automation_state_invalid');
          return;
        }
        result = await this.client.forwardAutomationState(context, {
          ...state,
          contactId: operation.contact.id,
          identity,
        });
      } else if (operation.type === 'FORWARD_MESSAGE_STATUS') {
        if (!this.client.forwardMessageStatus) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_message_status_unsupported');
          return;
        }
        const status = this.messageStatusEvent(operation.inputSafe);
        if (!status) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_message_status_invalid');
          return;
        }
        result = await this.client.forwardMessageStatus(context, {
          ...status,
          contactId: operation.contact.id,
          identity,
          normalizedEventId: operation.normalizedEventId ?? operation.id,
        });
      } else {
        const message = operation.message;
        const source = crmOutboundHistorySource(message?.metadata);
        if (!message?.externalMessageId || !source) {
          await this.finish(outboxRecordId, leaseToken, 'FAILED', 'crm_outbound_message_invalid');
          return;
        }
        const metadata = this.jsonRecord(message.metadata);
        const text = this.messageText(message.content);
        const inlineKeyboard = this.inlineKeyboard(message.content, message.metadata);
        const entities = this.messageEntities(metadata?.entities);
        const linkPreviewOptions = this.linkPreviewOptions(metadata?.linkPreviewOptions);
        const replyToMessageId = await this.replyToMessageId(
          operation.projectId,
          connectionId,
          metadata,
        );
        const sourceContext = this.sourceContext(operation.inputSafe);
        result = await this.client.forwardOutboundMessage(context, {
          contactId: operation.contact.id,
          deliveryStatus: 'SENT',
          identity,
          ...(entities ? { entities } : {}),
          ...(metadata?.hasSpoiler === true ? { hasSpoiler: true } : {}),
          ...(inlineKeyboard ? { inlineKeyboard } : {}),
          ...(linkPreviewOptions ? { linkPreviewOptions } : {}),
          ...(await this.media(operation.projectId, connectionId, message.mediaAsset)),
          messageId: message.id,
          ...(typeof metadata?.messageEffectId === 'string'
            ? { messageEffectId: metadata.messageEffectId }
            : {}),
          occurredAt: (message.sentAt ?? message.createdAt).toISOString(),
          providerMessageId: message.externalMessageId,
          ...(typeof metadata?.protectContent === 'boolean'
            ? { protectContent: metadata.protectContent }
            : {}),
          ...(typeof metadata?.quote === 'string' ? { quote: metadata.quote } : {}),
          ...(typeof metadata?.quotePosition === 'number'
            ? { quotePosition: metadata.quotePosition }
            : {}),
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(message.connection.botUsername
            ? { senderName: `@${message.connection.botUsername}` }
            : {}),
          source,
          ...(sourceContext ? { sourceContext } : {}),
          ...(typeof metadata?.scenarioExecutionId === 'string'
            ? { scenarioExecutionId: metadata.scenarioExecutionId }
            : {}),
          ...(typeof metadata?.broadcastId === 'string'
            ? { broadcastId: metadata.broadcastId }
            : {}),
          ...(text === undefined ? {} : { text }),
        });
      }
      await this.finishSuccess(
        operation,
        outboxRecordId,
        leaseToken,
        result,
        operation.type === 'CREATE_OR_UPDATE_LEAD' && !operation.contact.crmLeadId,
      );
    } catch (error) {
      const failure =
        error instanceof CrmClientError
          ? error
          : new CrmClientError('RETRYABLE_FAILURE', 'crm_unexpected_failure');
      if (failure.outcome === 'UNKNOWN') {
        await this.finish(outboxRecordId, leaseToken, 'UNKNOWN', failure.safeCode);
        return;
      }
      if (
        failure.outcome === 'PERMANENT_FAILURE' ||
        operation.outbox.attempts >= operation.outbox.maxAttempts
      ) {
        await this.finish(
          outboxRecordId,
          leaseToken,
          'FAILED',
          failure.outcome === 'PERMANENT_FAILURE' ? failure.safeCode : 'crm_retry_exhausted',
        );
        return;
      }
      const retryDelay =
        failure.retryAfterMs ??
        Math.min(300_000, 1_000 * 2 ** Math.min(operation.outbox.attempts, 12));
      await this.database.client.outboxRecord.updateMany({
        data: {
          lastError: failure.safeCode,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: new Date(Date.now() + retryDelay),
          status: 'RETRY',
        },
        where: { id: outboxRecordId, lockedBy: leaseToken, status: 'PROCESSING' },
      });
      this.logger.warn({
        errorCode: failure.safeCode,
        message: 'crm_retry_scheduled',
        outboxRecordId,
        projectId: operation.projectId,
      });
    }
  }

  private sourceContext(value: Prisma.JsonValue | null | undefined) {
    const input = this.jsonRecord(value);
    const candidate = this.jsonRecord(input?.sourceContext as Prisma.JsonValue | undefined);
    if (
      !candidate ||
      !['scenario', 'broadcast', 'system'].includes(String(candidate.type)) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.displayName !== 'string'
    )
      return undefined;
    return {
      displayName: candidate.displayName,
      id: candidate.id,
      type: candidate.type as 'broadcast' | 'scenario' | 'system',
      ...(typeof candidate.webUrl === 'string' ? { webUrl: candidate.webUrl } : {}),
    };
  }

  private async finishSuccess(
    operation: {
      contactId: string | null;
      id: string;
      projectId: string;
      type:
        | 'CREATE_OR_UPDATE_LEAD'
        | 'MERGE_CONTACTS'
        | 'FORWARD_INBOUND_MESSAGE'
        | 'FORWARD_OUTBOUND_MESSAGE'
        | 'FORWARD_REACTION_EVENT'
        | 'FORWARD_MESSAGE_EDIT'
        | 'FORWARD_CONTACT_SHARE'
        | 'FORWARD_AUTOMATION_STATE'
        | 'FORWARD_TRACKED_LINK_CLICK'
        | 'FORWARD_MESSAGE_STATUS';
    },
    outboxRecordId: string,
    leaseToken: string,
    result: { mode: string; operationId: string; providerReference: string },
    shouldBackfillHistory: boolean,
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await transaction.crmOperation.update({
        data: {
          resultSafe: {
            mode: result.mode,
            operationId: result.operationId,
            providerReference: result.providerReference,
          },
        },
        where: { id: operation.id },
      });
      if (
        (operation.type === 'CREATE_OR_UPDATE_LEAD' || operation.type === 'MERGE_CONTACTS') &&
        operation.contactId &&
        result.providerReference
      )
        await transaction.contact.update({
          data: { crmLeadId: result.providerReference },
          where: {
            projectId_id: { id: operation.contactId, projectId: operation.projectId },
          },
        });
      if (
        shouldBackfillHistory &&
        operation.type === 'CREATE_OR_UPDATE_LEAD' &&
        operation.contactId
      )
        await this.queueInitialHistory(
          transaction,
          operation.projectId,
          operation.contactId,
          operation.id,
        );
      await transaction.outboxRecord.updateMany({
        data: {
          completedAt: new Date(),
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
          status: 'SUCCEEDED',
        },
        where: { id: outboxRecordId, lockedBy: leaseToken, status: 'PROCESSING' },
      });
    });
  }

  private async queueInitialHistory(
    transaction: Prisma.TransactionClient,
    projectId: string,
    contactId: string,
    sourceOperationId: string,
  ): Promise<void> {
    const messages = await transaction.message.findMany({
      orderBy: { createdAt: 'asc' },
      take: 50,
      where: {
        contactId,
        direction: 'INBOUND',
        normalizedEventId: { not: null },
        projectId,
      },
    });
    for (const message of messages) {
      if (!message.normalizedEventId) continue;
      const alreadyQueued = await transaction.crmOperation.findFirst({
        select: { id: true },
        where: {
          normalizedEventId: message.normalizedEventId,
          projectId,
          type: 'FORWARD_INBOUND_MESSAGE',
        },
      });
      if (alreadyQueued) continue;
      const idempotencyKey = `crm-history-${message.id}`;
      await transaction.outboxRecord.createMany({
        data: [
          {
            idempotencyKey,
            kind: 'CRM',
            payload: {},
            projectId,
          },
        ],
        skipDuplicates: true,
      });
      const outbox = await transaction.outboxRecord.findUnique({
        include: { crmOperation: { select: { id: true } } },
        where: { projectId_idempotencyKey: { idempotencyKey, projectId } },
      });
      if (!outbox || outbox.crmOperation) continue;
      const historyOperation = await transaction.crmOperation.create({
        data: {
          contactId,
          inputSafe: { source: 'initial_history', sourceOperationId },
          messageId: message.id,
          normalizedEventId: message.normalizedEventId,
          outboxRecordId: outbox.id,
          projectId,
          type: 'FORWARD_INBOUND_MESSAGE',
        },
      });
      await transaction.outboxRecord.update({
        data: { payload: { crmOperationId: historyOperation.id } },
        where: { projectId_id: { id: outbox.id, projectId } },
      });
    }
  }

  private async finish(
    outboxRecordId: string,
    leaseToken: string,
    status: 'FAILED' | 'UNKNOWN',
    error: string,
  ): Promise<void> {
    await this.database.client.outboxRecord.updateMany({
      data: {
        completedAt: new Date(),
        lastError: error,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
        status,
      },
      where: { id: outboxRecordId, lockedBy: leaseToken, status: 'PROCESSING' },
    });
  }

  private customFields(contact: {
    customFields: Prisma.JsonValue;
    customFieldValues: Array<{
      definition: { key: string };
      valueJson: Prisma.JsonValue;
    }>;
  }): Record<string, unknown> {
    const legacy =
      contact.customFields &&
      typeof contact.customFields === 'object' &&
      !Array.isArray(contact.customFields)
        ? (contact.customFields as Record<string, unknown>)
        : {};
    return {
      ...legacy,
      ...Object.fromEntries(
        contact.customFieldValues.map((value) => [value.definition.key, value.valueJson]),
      ),
    };
  }

  private messageText(content: Prisma.JsonValue | undefined): string | undefined {
    if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined;
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    return typeof record.caption === 'string' ? record.caption : undefined;
  }

  private jsonRecord(
    value: Prisma.JsonValue | null | undefined,
  ): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private stringProperty(value: Prisma.JsonValue | undefined, key: string): string | undefined {
    const candidate = this.jsonRecord(value)?.[key];
    return typeof candidate === 'string' ? candidate : undefined;
  }

  private messageStatusEvent(
    value: Prisma.JsonValue | null | undefined,
  ): Omit<ForwardMessageStatusInput, 'contactId' | 'identity' | 'normalizedEventId'> | undefined {
    const input = this.jsonRecord(value);
    if (
      !input ||
      typeof input.messageId !== 'string' ||
      typeof input.occurredAt !== 'string' ||
      !['SENT', 'DELIVERED', 'READ', 'FAILED', 'DELETED', 'UNKNOWN'].includes(
        String(input.status),
      ) ||
      (!['FAILED', 'UNKNOWN'].includes(String(input.status)) &&
        typeof input.providerMessageId !== 'string')
    )
      return undefined;
    return {
      messageId: input.messageId,
      occurredAt: input.occurredAt,
      ...(typeof input.providerMessageId === 'string'
        ? { providerMessageId: input.providerMessageId }
        : {}),
      status: input.status as 'DELETED' | 'DELIVERED' | 'FAILED' | 'READ' | 'SENT' | 'UNKNOWN',
      ...(typeof input.errorCode === 'string' ? { errorCode: input.errorCode } : {}),
    };
  }

  private reactionEvent(payload: Prisma.JsonValue | undefined):
    | {
        actor: CrmReactionActorInput;
        messageId: string;
        newReactions: CrmReactionInput[];
        occurredAt: string;
        oldReactions: CrmReactionInput[];
      }
    | undefined {
    const content = this.jsonRecord(this.jsonRecord(payload)?.content as Prisma.JsonValue);
    const actor = this.jsonRecord(content?.actor as Prisma.JsonValue);
    const oldReactions = this.reactions(content?.oldReactions);
    const newReactions = this.reactions(content?.newReactions);
    if (
      !content ||
      !actor ||
      actor.type !== 'user' ||
      typeof actor.displayName !== 'string' ||
      typeof actor.externalUserId !== 'string' ||
      typeof content.messageId !== 'string' ||
      typeof content.occurredAt !== 'string' ||
      !oldReactions ||
      !newReactions
    )
      return undefined;
    return {
      actor: {
        displayName: actor.displayName,
        externalUserId: actor.externalUserId,
        type: 'user',
        ...(typeof actor.username === 'string' ? { username: actor.username } : {}),
      },
      messageId: content.messageId,
      newReactions,
      occurredAt: content.occurredAt,
      oldReactions,
    };
  }

  private messageEditEvent(payload: Prisma.JsonValue | undefined):
    | {
        caption?: string;
        editedAt: string;
        entities?: CrmMessageEntityInput[];
        messageId: string;
        text?: string;
      }
    | undefined {
    const content = this.jsonRecord(this.jsonRecord(payload)?.content as Prisma.JsonValue);
    if (
      !content ||
      typeof content.messageId !== 'string' ||
      typeof content.occurredAt !== 'string' ||
      (typeof content.text !== 'string' && typeof content.caption !== 'string')
    )
      return undefined;
    const entities = this.messageEntities(content.entities);
    return {
      editedAt: content.occurredAt,
      ...(entities ? { entities } : {}),
      messageId: content.messageId,
      ...(typeof content.caption === 'string' ? { caption: content.caption } : {}),
      ...(typeof content.text === 'string' ? { text: content.text } : {}),
    };
  }

  private contactShareEvent(payload: Prisma.JsonValue | undefined):
    | {
        firstName: string;
        lastName?: string;
        phoneNumber: string;
        telegramUserId?: string;
        vcard?: string;
      }
    | undefined {
    const content = this.jsonRecord(this.jsonRecord(payload)?.content as Prisma.JsonValue);
    if (
      !content ||
      typeof content.firstName !== 'string' ||
      typeof content.phoneNumber !== 'string'
    )
      return undefined;
    return {
      firstName: content.firstName,
      phoneNumber: content.phoneNumber,
      ...(typeof content.lastName === 'string' ? { lastName: content.lastName } : {}),
      ...(typeof content.telegramUserId === 'string'
        ? { telegramUserId: content.telegramUserId }
        : {}),
      ...(typeof content.vcard === 'string' ? { vcard: content.vcard } : {}),
    };
  }

  private automationStateEvent(value: Prisma.JsonValue | null | undefined):
    | {
        changedAt: string;
        conversationId: string;
        mode: 'AUTO' | 'MANUAL' | 'PAUSED';
        reasonCode?: string;
        resumeAt?: string;
        revision: number;
      }
    | undefined {
    const state = this.jsonRecord(value);
    if (
      !state ||
      typeof state.changedAt !== 'string' ||
      typeof state.conversationId !== 'string' ||
      !['AUTO', 'MANUAL', 'PAUSED'].includes(String(state.mode)) ||
      !Number.isSafeInteger(state.revision)
    )
      return undefined;
    return {
      changedAt: state.changedAt,
      conversationId: state.conversationId,
      mode: state.mode as 'AUTO' | 'MANUAL' | 'PAUSED',
      revision: state.revision as number,
      ...(typeof state.reasonCode === 'string' ? { reasonCode: state.reasonCode } : {}),
      ...(typeof state.resumeAt === 'string' ? { resumeAt: state.resumeAt } : {}),
    };
  }

  private reactions(value: unknown): CrmReactionInput[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const output: CrmReactionInput[] = [];
    for (const candidate of value) {
      const reaction =
        candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          ? (candidate as Record<string, unknown>)
          : undefined;
      if (!reaction) return undefined;
      if (reaction.type === 'paid') output.push({ type: 'paid' });
      else if (reaction.type === 'emoji' && typeof reaction.emoji === 'string')
        output.push({ emoji: reaction.emoji, type: 'emoji' });
      else if (reaction.type === 'custom_emoji' && typeof reaction.customEmojiId === 'string')
        output.push({ customEmojiId: reaction.customEmojiId, type: 'custom_emoji' });
      else return undefined;
    }
    return output;
  }

  private messageEntities(value: unknown): CrmMessageEntityInput[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const entities: CrmMessageEntityInput[] = [];
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
      const entity = candidate as Record<string, unknown>;
      if (
        typeof entity.type !== 'string' ||
        typeof entity.offset !== 'number' ||
        typeof entity.length !== 'number'
      )
        return undefined;
      entities.push({
        length: entity.length,
        offset: entity.offset,
        type: entity.type,
        ...(typeof entity.customEmojiId === 'string'
          ? { customEmojiId: entity.customEmojiId }
          : {}),
        ...(typeof entity.language === 'string' ? { language: entity.language } : {}),
        ...(typeof entity.url === 'string' ? { url: entity.url } : {}),
      });
    }
    return entities;
  }

  private linkPreviewOptions(value: unknown): CrmLinkPreviewOptionsInput | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const output: CrmLinkPreviewOptionsInput = {};
    for (const key of [
      'isDisabled',
      'preferLargeMedia',
      'preferSmallMedia',
      'showAboveText',
    ] as const)
      if (typeof input[key] === 'boolean') output[key] = input[key];
    if (typeof input.url === 'string') output.url = input.url;
    return Object.keys(output).length ? output : undefined;
  }

  private async replyToMessageId(
    projectId: string,
    connectionId: string | null | undefined,
    metadata: Record<string, unknown> | undefined,
  ): Promise<string | undefined> {
    if (typeof metadata?.replyToOmnicusMessageId === 'string')
      return metadata.replyToOmnicusMessageId;
    if (!connectionId || typeof metadata?.replyToMessageId !== 'string') return undefined;
    const target = await this.database.client.message.findFirst({
      select: { id: true },
      where: {
        connectionId,
        externalMessageId: metadata.replyToMessageId,
        projectId,
      },
    });
    return target?.id;
  }

  private inlineKeyboard(
    content: Prisma.JsonValue,
    metadata: Prisma.JsonValue | null,
  ): CrmInlineKeyboardInput | undefined {
    for (const source of [metadata, content]) {
      const keyboard = this.jsonRecord(source)?.inlineKeyboard;
      if (!Array.isArray(keyboard)) continue;
      const result: CrmInlineKeyboardInput = [];
      let valid = true;
      for (const row of keyboard) {
        if (!Array.isArray(row)) {
          valid = false;
          break;
        }
        const outputRow: CrmInlineKeyboardInput[number] = [];
        for (const candidate of row) {
          const button = this.jsonRecord(candidate as Prisma.JsonValue);
          if (
            !button ||
            typeof button.text !== 'string' ||
            !(
              (typeof button.callbackData === 'string' && button.url === undefined) ||
              (typeof button.url === 'string' && button.callbackData === undefined)
            )
          ) {
            valid = false;
            break;
          }
          outputRow.push({
            text: button.text,
            ...(typeof button.callbackData === 'string'
              ? { callbackData: button.callbackData }
              : {}),
            ...(typeof button.url === 'string' ? { url: button.url } : {}),
          });
        }
        if (!valid) break;
        result.push(outputRow);
      }
      if (valid) return result;
    }
    return undefined;
  }

  private async media(
    projectId: string,
    connectionId: string | null | undefined,
    asset:
      | {
          bucketKey: string | null;
          connectionId: string | null;
          declaredMimeType: string | null;
          detectedMimeType: string | null;
          extension: string | null;
          id: string;
          kind: string;
          originalFilename: string | null;
          providerMediaId: string | null;
          providerMetadata: Prisma.JsonValue | null;
          sizeBytes: bigint | null;
          status: string;
        }
      | null
      | undefined,
  ): Promise<{ media: CrmMediaInput } | undefined> {
    if (!asset) return undefined;
    let current = asset;
    if (
      current.status === 'PROVIDER_REFERENCE' &&
      connectionId &&
      current.connectionId === connectionId &&
      current.providerMediaId
    )
      current = await this.materializeProviderMedia(projectId, connectionId, current);
    const providerMetadata = this.jsonRecord(current.providerMetadata);
    const size =
      current.sizeBytes !== null && current.sizeBytes <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(current.sizeBytes)
        : undefined;
    const download =
      current.status === 'AVAILABLE' && current.bucketKey && this.storage
        ? {
            downloadUrl: await this.storage.signedDownloadUrl(
              current.bucketKey,
              this.signedUrlTtlSeconds,
            ),
            downloadUrlExpiresAt: new Date(
              Date.now() + this.signedUrlTtlSeconds * 1_000,
            ).toISOString(),
          }
        : {};
    return {
      media: {
        assetId: current.id,
        availability: current.status === 'AVAILABLE' ? 'available' : 'unavailable',
        ...download,
        ...(current.originalFilename ? { fileName: current.originalFilename } : {}),
        ...((current.detectedMimeType ?? current.declaredMimeType)
          ? { mimeType: current.detectedMimeType ?? current.declaredMimeType! }
          : {}),
        ...(size === undefined ? {} : { size }),
        ...(typeof providerMetadata?.emoji === 'string' ? { emoji: providerMetadata.emoji } : {}),
        ...(providerMetadata?.hasSpoiler === true ? { hasSpoiler: true } : {}),
        ...(typeof providerMetadata?.mediaGroupId === 'string'
          ? { mediaGroupId: providerMetadata.mediaGroupId }
          : {}),
        ...(typeof providerMetadata?.setName === 'string'
          ? { setName: providerMetadata.setName }
          : {}),
        ...(typeof providerMetadata?.materializationFailure === 'string'
          ? { unavailableReason: providerMetadata.materializationFailure }
          : {}),
        kind: current.kind as CrmMediaInput['kind'],
        type:
          current.kind === 'PHOTO'
            ? 'image'
            : current.kind === 'STICKER'
              ? 'sticker'
              : ['AUDIO', 'VOICE'].includes(current.kind)
                ? 'audio'
                : ['ANIMATION', 'VIDEO', 'VIDEO_NOTE'].includes(current.kind)
                  ? 'video'
                  : 'file',
      },
    };
  }

  private async interactive(
    projectId: string,
    connectionId: string | null | undefined,
    payload: Prisma.JsonValue | undefined,
    sourceMessageId?: string,
  ): Promise<CrmInteractiveInput | undefined> {
    if (!connectionId || !payload || typeof payload !== 'object' || Array.isArray(payload))
      return undefined;
    const normalized = payload as Record<string, unknown>;
    const whatsAppInteractive = this.jsonRecord(
      normalized.interactive as Prisma.JsonValue | undefined,
    );
    if (
      whatsAppInteractive &&
      (whatsAppInteractive.type === 'button_reply' || whatsAppInteractive.type === 'list_reply') &&
      typeof whatsAppInteractive.id === 'string' &&
      typeof whatsAppInteractive.title === 'string'
    )
      return {
        ...(typeof whatsAppInteractive.description === 'string'
          ? { description: whatsAppInteractive.description }
          : {}),
        id: whatsAppInteractive.id,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        title: whatsAppInteractive.title,
        type: whatsAppInteractive.type,
      };
    const content =
      normalized.content &&
      typeof normalized.content === 'object' &&
      !Array.isArray(normalized.content)
        ? (normalized.content as Record<string, unknown>)
        : undefined;
    if (!content || typeof content.id !== 'string') return undefined;
    const data = typeof content.data === 'string' ? content.data : undefined;
    const metadata =
      normalized.metadata &&
      typeof normalized.metadata === 'object' &&
      !Array.isArray(normalized.metadata)
        ? (normalized.metadata as Record<string, unknown>)
        : undefined;
    const callback =
      metadata?.telegramCallbackQuery &&
      typeof metadata.telegramCallbackQuery === 'object' &&
      !Array.isArray(metadata.telegramCallbackQuery)
        ? (metadata.telegramCallbackQuery as Record<string, unknown>)
        : undefined;
    const sourceTelegramMessage =
      callback?.message && typeof callback.message === 'object' && !Array.isArray(callback.message)
        ? (callback.message as Record<string, unknown>)
        : undefined;
    const sourceProviderId =
      typeof sourceTelegramMessage?.message_id === 'number'
        ? String(sourceTelegramMessage.message_id)
        : undefined;
    const source = sourceProviderId
      ? await this.database.client.message.findFirst({
          select: { content: true, id: true, metadata: true },
          where: {
            connectionId,
            direction: 'OUTBOUND',
            externalMessageId: sourceProviderId,
            projectId,
          },
        })
      : undefined;
    const displayText = data
      ? this.callbackLabel(source?.content, source?.metadata, data)
      : undefined;
    return {
      callbackQueryId: content.id,
      ...(data === undefined ? {} : { data }),
      ...(displayText === undefined ? {} : { displayText }),
      ...(source?.id ? { sourceMessageId: source.id } : {}),
      type: 'callback_query',
    };
  }

  private inboundLocation(value: Prisma.JsonValue | undefined):
    | {
        address?: string;
        latitude: number;
        longitude: number;
        name?: string;
        url?: string;
      }
    | undefined {
    const input = this.jsonRecord(value);
    if (!input || typeof input.latitude !== 'number' || typeof input.longitude !== 'number') return;
    if (
      !Number.isFinite(input.latitude) ||
      !Number.isFinite(input.longitude) ||
      input.latitude < -90 ||
      input.latitude > 90 ||
      input.longitude < -180 ||
      input.longitude > 180
    )
      return;
    return {
      ...(typeof input.address === 'string' ? { address: input.address } : {}),
      latitude: input.latitude,
      longitude: input.longitude,
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
      ...(typeof input.url === 'string' ? { url: input.url } : {}),
    };
  }

  private inboundWhatsAppContacts(value: Prisma.JsonValue | undefined):
    | {
        contacts: Array<{
          emails: Array<{ email: string; type?: string }>;
          name: { firstName?: string; formattedName: string; lastName?: string };
          phones: Array<{ phone: string; type?: string; waId?: string }>;
        }>;
      }
    | undefined {
    const source = this.jsonRecord(value);
    if (!Array.isArray(source?.contacts)) return;
    const contacts = source.contacts.slice(0, 20).flatMap((candidate) => {
      const contact = this.jsonRecord(candidate as Prisma.JsonValue);
      const name = this.jsonRecord(contact?.name as Prisma.JsonValue | undefined);
      if (!contact || typeof name?.formattedName !== 'string') return [];
      const emails = Array.isArray(contact.emails)
        ? contact.emails.slice(0, 20).flatMap((candidateEmail) => {
            const email = this.jsonRecord(candidateEmail as Prisma.JsonValue);
            return typeof email?.email === 'string'
              ? [
                  {
                    email: email.email,
                    ...(typeof email.type === 'string' ? { type: email.type } : {}),
                  },
                ]
              : [];
          })
        : [];
      const phones = Array.isArray(contact.phones)
        ? contact.phones.slice(0, 20).flatMap((candidatePhone) => {
            const phone = this.jsonRecord(candidatePhone as Prisma.JsonValue);
            return typeof phone?.phone === 'string'
              ? [
                  {
                    phone: phone.phone,
                    ...(typeof phone.type === 'string' ? { type: phone.type } : {}),
                    ...(typeof phone.waId === 'string' ? { waId: phone.waId } : {}),
                  },
                ]
              : [];
          })
        : [];
      return [
        {
          emails,
          name: {
            ...(typeof name.firstName === 'string' ? { firstName: name.firstName } : {}),
            formattedName: name.formattedName,
            ...(typeof name.lastName === 'string' ? { lastName: name.lastName } : {}),
          },
          phones,
        },
      ];
    });
    return contacts.length ? { contacts } : undefined;
  }

  private callbackLabel(
    content: Prisma.JsonValue | undefined,
    metadata: Prisma.JsonValue | null | undefined,
    data: string,
  ): string | undefined {
    for (const value of [content, metadata]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const keyboard = (value as Record<string, unknown>).inlineKeyboard;
      if (!Array.isArray(keyboard)) continue;
      for (const row of keyboard) {
        if (!Array.isArray(row)) continue;
        for (const candidate of row) {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
          const button = candidate as Record<string, unknown>;
          if (button.callbackData === data && typeof button.text === 'string') return button.text;
        }
      }
    }
    return undefined;
  }

  private async materializeTelegramMedia(
    projectId: string,
    connectionId: string,
    asset: {
      bucketKey: string | null;
      connectionId: string | null;
      declaredMimeType: string | null;
      detectedMimeType: string | null;
      extension: string | null;
      id: string;
      kind: string;
      originalFilename: string | null;
      providerMediaId: string | null;
      providerMetadata: Prisma.JsonValue | null;
      sizeBytes: bigint | null;
      status: string;
    },
  ): Promise<typeof asset> {
    if (!this.storage || !asset.providerMediaId) return asset;
    try {
      const connection = await this.database.client.channelConnection.findUnique({
        where: { projectId_id: { id: connectionId, projectId } },
      });
      if (!connection) return asset;
      const token = this.secrets.decryptSecret({
        channelConnectionId: connection.id,
        channelType: 'telegram',
        envelope: connection.credentialsEncrypted as unknown as EncryptedSecretEnvelope,
        field: 'botToken',
        projectId,
      });
      const downloaded = await this.telegram.downloadFile(
        token,
        asset.providerMediaId,
        this.maximumMediaBytes,
      );
      const prepared = await prepareMediaForTelegram({
        bytes: downloaded.bytes,
        ...(asset.declaredMimeType ? { declaredMimeType: asset.declaredMimeType } : {}),
        ...(asset.originalFilename ? { filename: asset.originalFilename } : {}),
        kind: asset.kind as MediaKind,
        maximumBytes: this.maximumMediaBytes,
      });
      const bucketKey = `${projectId}/telegram/${asset.id}.${prepared.extension}`;
      await this.storage.putObject(bucketKey, prepared.bytes, prepared.mimeType, {
        assetId: asset.id,
        projectId,
      });
      return await this.database.client.mediaAsset.update({
        data: {
          availableAt: new Date(),
          bucketKey,
          checksumSha256: createHash('sha256').update(prepared.bytes).digest('hex'),
          detectedMimeType: prepared.mimeType,
          extension: prepared.extension,
          providerMetadata: {
            ...(asset.providerMetadata &&
            typeof asset.providerMetadata === 'object' &&
            !Array.isArray(asset.providerMetadata)
              ? asset.providerMetadata
              : {}),
            materializedFromTelegram: true,
          },
          retentionUntil: new Date(Date.now() + this.mediaRetentionDays * 86_400_000),
          sizeBytes: BigInt(prepared.sizeBytes),
          status: 'AVAILABLE',
        },
        where: { projectId_id: { id: asset.id, projectId } },
      });
    } catch {
      this.logger.warn({
        assetId: asset.id,
        message: 'crm_media_materialization_unavailable',
        projectId,
      });
      return asset;
    }
  }

  private async materializeProviderMedia(
    projectId: string,
    connectionId: string,
    asset: Parameters<CrmOutboxService['materializeTelegramMedia']>[2],
  ): Promise<typeof asset> {
    const connection = await this.database.client.channelConnection.findUnique({
      select: { type: true },
      where: { projectId_id: { id: connectionId, projectId } },
    });
    if (!connection)
      return this.markWhatsAppMediaUnavailable(projectId, asset, 'connection_unavailable');
    if (connection.type === 'WHATSAPP')
      return this.materializeWhatsAppMedia(projectId, connectionId, asset);
    if (connection.type === 'TELEGRAM')
      return this.materializeTelegramMedia(projectId, connectionId, asset);
    return this.markWhatsAppMediaUnavailable(projectId, asset, 'connection_unsupported');
  }

  private async materializeWhatsAppMedia(
    projectId: string,
    connectionId: string,
    asset: Parameters<CrmOutboxService['materializeTelegramMedia']>[2],
  ): Promise<typeof asset> {
    if (!this.storage)
      throw new CrmClientError('RETRYABLE_FAILURE', 'crm_media_storage_unavailable');
    if (!asset.providerMediaId)
      return this.markWhatsAppMediaUnavailable(projectId, asset, 'provider_media_id_missing');
    const connection = await this.database.client.channelConnection.findUnique({
      where: { projectId_id: { id: connectionId, projectId } },
    });
    const metadata = this.jsonRecord(connection?.webhookMetadata);
    const credentials = this.jsonRecord(connection?.credentialsEncrypted);
    const envelope = this.jsonRecord(
      credentials?.accessToken as Prisma.JsonValue | undefined,
    ) as unknown as EncryptedSecretEnvelope | undefined;
    if (
      !connection ||
      connection.type !== 'WHATSAPP' ||
      !envelope ||
      typeof metadata?.graphApiVersion !== 'string'
    )
      return this.markWhatsAppMediaUnavailable(projectId, asset, 'connection_unavailable');
    let token: string;
    try {
      token = this.secrets.decryptSecret({
        channelConnectionId: connection.id,
        channelType: 'whatsapp',
        envelope,
        field: 'accessToken',
        projectId,
      });
    } catch {
      return this.markWhatsAppMediaUnavailable(projectId, asset, 'credentials_invalid');
    }
    let downloaded: Awaited<ReturnType<WhatsAppCloudApi['downloadMedia']>>;
    try {
      downloaded = await this.whatsApp.downloadMedia({
        accessToken: token,
        graphApiVersion: metadata.graphApiVersion,
        maximumBytes: this.maximumMediaBytes,
        mediaId: asset.providerMediaId,
      });
    } catch (error) {
      if (error instanceof WhatsAppApiError && error.status >= 400 && error.status < 500)
        return this.markWhatsAppMediaUnavailable(
          projectId,
          asset,
          error.status === 413 ? 'too_large' : 'provider_rejected',
        );
      throw new CrmClientError('RETRYABLE_FAILURE', 'crm_whatsapp_media_download_retryable');
    }
    const contentType = (downloaded.contentType ?? asset.declaredMimeType)
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    const providerKind =
      asset.kind === 'PHOTO'
        ? 'image'
        : ['AUDIO', 'VOICE'].includes(asset.kind)
          ? 'audio'
          : asset.kind === 'DOCUMENT'
            ? 'document'
            : asset.kind === 'STICKER'
              ? 'sticker'
              : asset.kind === 'VIDEO'
                ? 'video'
                : undefined;
    if (!contentType || !providerKind)
      return this.markWhatsAppMediaUnavailable(projectId, asset, 'unsupported');
    try {
      assertWhatsAppMedia(providerKind, contentType, downloaded.bytes.byteLength, downloaded.bytes);
    } catch {
      return this.markWhatsAppMediaUnavailable(projectId, asset, 'unsupported_or_too_large');
    }
    const providerMetadata = this.jsonRecord(asset.providerMetadata);
    if (
      typeof providerMetadata?.sha256 === 'string' &&
      createHash('sha256').update(downloaded.bytes).digest('base64') !== providerMetadata.sha256
    )
      return this.markWhatsAppMediaUnavailable(projectId, asset, 'checksum_mismatch');
    const extension = this.whatsAppExtension(contentType);
    if (!extension) return this.markWhatsAppMediaUnavailable(projectId, asset, 'unsupported');
    const bucketKey = `${projectId}/whatsapp/${asset.id}.${extension}`;
    try {
      await this.storage.putObject(bucketKey, downloaded.bytes, contentType, {
        assetId: asset.id,
        projectId,
      });
      return await this.database.client.mediaAsset.update({
        data: {
          availableAt: new Date(),
          bucketKey,
          checksumSha256: createHash('sha256').update(downloaded.bytes).digest('hex'),
          detectedMimeType: contentType,
          extension,
          providerMetadata: {
            ...(providerMetadata ?? {}),
            materializedFromWhatsApp: true,
          },
          retentionUntil: new Date(Date.now() + this.mediaRetentionDays * 86_400_000),
          sizeBytes: BigInt(downloaded.bytes.byteLength),
          status: 'AVAILABLE',
        },
        where: { projectId_id: { id: asset.id, projectId } },
      });
    } catch (error) {
      if (error instanceof CrmClientError) throw error;
      throw new CrmClientError('RETRYABLE_FAILURE', 'crm_whatsapp_media_storage_retryable');
    }
  }

  private async markWhatsAppMediaUnavailable(
    projectId: string,
    asset: Parameters<CrmOutboxService['materializeTelegramMedia']>[2],
    reason: string,
  ): Promise<typeof asset> {
    try {
      const providerMetadata = this.jsonRecord(asset.providerMetadata);
      return await this.database.client.mediaAsset.update({
        data: {
          providerMetadata: {
            ...(providerMetadata ?? {}),
            materializationFailure: reason,
          },
          status: 'UNAVAILABLE',
        },
        where: { projectId_id: { id: asset.id, projectId } },
      });
    } catch {
      throw new CrmClientError('RETRYABLE_FAILURE', 'crm_media_state_persistence_retryable');
    }
  }

  private whatsAppExtension(contentType: string): string | undefined {
    const extensions: Readonly<Record<string, string>> = {
      'application/msword': 'doc',
      'application/pdf': 'pdf',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.ms-powerpoint': 'ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'audio/aac': 'aac',
      'audio/amr': 'amr',
      'audio/mp4': 'm4a',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'text/plain': 'txt',
      'video/3gpp': '3gp',
      'video/mp4': 'mp4',
    };
    return extensions[contentType];
  }
}
