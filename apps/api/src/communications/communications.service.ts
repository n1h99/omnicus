import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { whatsAppTemplateDisabledReason } from '@omnicus/channel-whatsapp';
import type { Prisma } from '@omnicus/database';

import type { RequestSecurityContext } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { ensureWhatsAppContactIdentity } from '../channels/whatsapp-contact-identity';
import { CrmOutboundService } from '../crm-integration/crm-outbound.service';
import type { CrmOutboundMessageDto } from '../crm-integration/dto';
import { CrmWhatsAppV4Service } from '../crm-integration/crm-whatsapp-v4.service';
import type {
  CommunicationMessagesQueryDto,
  CommunicationsContactsQueryDto,
  SendCommunicationMessageDto,
} from './dto';

@Injectable()
export class CommunicationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CrmOutboundService) private readonly outbound: CrmOutboundService,
    @Inject(CrmWhatsAppV4Service) private readonly whatsApp: CrmWhatsAppV4Service,
  ) {}

  async contacts(projectId: string, query: CommunicationsContactsQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.ContactWhereInput = {
      projectId,
      status: { not: 'MERGED' },
      ...(search
        ? {
            OR: [
              { displayName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { username: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.database.client.$transaction([
      this.database.client.contact.findMany({
        include: {
          channelIdentities: {
            include: {
              connection: {
                select: {
                  botUsername: true,
                  id: true,
                  status: true,
                  type: true,
                  webhookMetadata: true,
                },
              },
            },
            where: { status: 'ACTIVE' },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            select: { content: true, createdAt: true, direction: true, status: true, type: true },
            take: 1,
          },
        },
        orderBy: [{ lastInteractionAt: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        where,
      }),
      this.database.client.contact.count({ where }),
    ]);
    return {
      items: items.map((contact) => {
        const latest = contact.messages[0];
        return {
          channels: [
            ...new Set([
              ...contact.channelIdentities.map((identity) => identity.channel),
              ...(contact.email ? ['EMAIL'] : []),
            ]),
          ],
          displayName: contact.displayName,
          email: contact.email,
          id: contact.id,
          lastInteractionAt: contact.lastInteractionAt,
          phone: contact.phone,
          preview: latest ? this.messagePreview(latest.content, latest.type) : null,
          status: contact.status,
        };
      }),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async contact(projectId: string, contactId: string) {
    const [contact, connections] = await Promise.all([
      this.database.client.contact.findUnique({
        include: {
          channelIdentities: {
            include: {
              connection: {
                select: {
                  botUsername: true,
                  id: true,
                  status: true,
                  type: true,
                  webhookMetadata: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
          conversations: {
            orderBy: { updatedAt: 'desc' },
            select: {
              automationState: true,
              connectionId: true,
              externalChatId: true,
              id: true,
              lastInboundAt: true,
              lastMessageAt: true,
              serviceWindowExpiresAt: true,
              status: true,
            },
          },
        },
        where: { projectId_id: { id: contactId, projectId } },
      }),
      this.database.client.channelConnection.findMany({
        orderBy: { createdAt: 'asc' },
        select: { botUsername: true, id: true, status: true, type: true, webhookMetadata: true },
        where: { projectId, status: 'ACTIVE' },
      }),
    ]);
    if (!contact) throw new NotFoundException({ code: 'CONTACT_NOT_FOUND' });
    return {
      automationMode: contact.automationMode,
      connections: connections.map((connection) => this.safeConnection(connection)),
      displayName: contact.displayName,
      email: contact.email,
      firstName: contact.firstName,
      id: contact.id,
      lastName: contact.lastName,
      phone: contact.phone,
      status: contact.status,
      username: contact.username,
      whatsAppConsentStatus: contact.whatsAppConsentStatus,
      templateVariables: this.templateVariables(contact),
      identities: contact.channelIdentities.map((identity) => {
        const conversation = contact.conversations.find(
          (candidate) =>
            candidate.connectionId === identity.connectionId &&
            candidate.externalChatId === identity.externalUserId,
        );
        return {
          channel: identity.channel,
          connection: this.safeConnection(identity.connection),
          connectionId: identity.connectionId,
          conversation: conversation ?? null,
          displayName: identity.displayName,
          externalUserId: identity.externalUserId,
          id: identity.id,
          status: identity.status,
          username: identity.username,
          whatsAppReachability: identity.whatsAppReachability,
        };
      }),
    };
  }

  async messages(projectId: string, contactId: string, query: CommunicationMessagesQueryDto) {
    const identity = await this.identity(projectId, contactId, query.identityId);
    const conversation = await this.database.client.conversation.findUnique({
      where: {
        projectId_connectionId_externalChatId: {
          connectionId: identity.connectionId,
          externalChatId: identity.externalUserId,
          projectId,
        },
      },
    });
    if (!conversation)
      return {
        conversation: null,
        items: [],
        nextCursor: null,
      };
    const rows = await this.database.client.message.findMany({
      ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
      include: {
        mediaAsset: {
          select: {
            declaredMimeType: true,
            detectedMimeType: true,
            id: true,
            kind: true,
            originalFilename: true,
            sizeBytes: true,
            status: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      where: { conversationId: conversation.id, projectId },
    });
    const hasMore = rows.length > query.limit;
    const visible = rows.slice(0, query.limit);
    return {
      conversation: {
        automationState: conversation.automationState,
        id: conversation.id,
        lastInboundAt: conversation.lastInboundAt,
        serviceWindowExpiresAt: conversation.serviceWindowExpiresAt,
        status: conversation.status,
      },
      items: visible.reverse().map((message) => ({
        ...message,
        mediaAsset: message.mediaAsset
          ? { ...message.mediaAsset, sizeBytes: Number(message.mediaAsset.sizeBytes ?? 0) }
          : null,
      })),
      nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null,
    };
  }

  async templates(projectId: string, contactId: string, connectionId: string) {
    await this.assertContact(projectId, contactId);
    const connection = await this.database.client.channelConnection.findUnique({
      where: { projectId_id: { id: connectionId, projectId } },
    });
    if (!connection || connection.type !== 'WHATSAPP' || connection.status !== 'ACTIVE')
      throw new NotFoundException({ code: 'CHANNEL_CONNECTION_NOT_FOUND' });
    const templates = await this.database.client.whatsAppMessageTemplate.findMany({
      orderBy: [{ name: 'asc' }, { languageCode: 'asc' }],
      select: {
        category: true,
        components: true,
        id: true,
        languageCode: true,
        lastSyncedAt: true,
        name: true,
        quality: true,
        rejectionReasonCode: true,
        status: true,
      },
      take: 2_000,
      where: { connectionId, projectId, status: 'APPROVED' },
    });
    return templates.map((template) => {
      const disabledReason = whatsAppTemplateDisabledReason(template) ?? null;
      return { ...template, disabledReason, sendable: disabledReason === null };
    });
  }

  async send(
    projectId: string,
    contactId: string,
    input: SendCommunicationMessageDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const identity = await this.resolveOutboundIdentity(projectId, contactId, input);
    if (identity.channel !== input.channel)
      throw new ConflictException({ code: 'COMMUNICATION_IDENTITY_CHANNEL_MISMATCH' });
    if (input.channel === 'WHATSAPP' && identity.whatsAppReachability === 'BLOCKED')
      throw new ConflictException({ code: 'COMMUNICATION_WHATSAPP_RECIPIENT_BLOCKED' });
    if (input.channel === 'WHATSAPP' && input.template)
      await this.assertWhatsAppConsent(projectId, contactId);
    const dto: CrmOutboundMessageDto = {
      crmProjectId: projectId,
      identity: {
        channel: input.channel === 'WHATSAPP' ? 'whatsapp' : 'telegram',
        channelIdentityId: identity.id,
        connectionId: identity.connectionId,
      },
      omnicusContactId: contactId,
      omnicusProjectId: projectId,
      ...(input.disableNotification === undefined
        ? {}
        : { disableNotification: input.disableNotification }),
      ...(input.hasSpoiler === undefined ? {} : { hasSpoiler: input.hasSpoiler }),
      ...(input.inlineKeyboard ? { inlineKeyboard: input.inlineKeyboard } : {}),
      ...(input.interactive ? { interactive: input.interactive } : {}),
      ...(input.linkPreviewOptions ? { linkPreviewOptions: input.linkPreviewOptions } : {}),
      ...(input.media ? { media: input.media } : {}),
      ...(input.protectContent === undefined ? {} : { protectContent: input.protectContent }),
      ...(input.replyMarkup ? { replyMarkup: input.replyMarkup } : {}),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.richMessage ? { richMessage: input.richMessage } : {}),
      ...(input.structured ? { structured: input.structured } : {}),
      ...(input.template ? { template: input.template } : {}),
      ...(input.text?.trim() ? { text: input.text.trim() } : {}),
    };
    const requestContext = {
      actorEmail: actor.email,
      actorUserId: actor.userId,
      source: 'omnicus' as const,
    };
    return input.channel === 'WHATSAPP'
      ? this.whatsApp.queue(
          dto,
          input.clientRequestId,
          context.correlationId,
          projectId,
          requestContext,
        )
      : this.outbound.queue(
          dto,
          input.clientRequestId,
          context.correlationId,
          projectId,
          requestContext,
        );
  }

  private async resolveOutboundIdentity(
    projectId: string,
    contactId: string,
    input: SendCommunicationMessageDto,
  ) {
    if (input.identityId) return this.identity(projectId, contactId, input.identityId);
    if (input.channel !== 'WHATSAPP' || !input.connectionId || !input.template)
      throw new ConflictException({ code: 'COMMUNICATION_IDENTITY_REQUIRED' });
    return this.createWhatsAppIdentity(projectId, contactId, input.connectionId);
  }

  private async createWhatsAppIdentity(projectId: string, contactId: string, connectionId: string) {
    return this.database.client.$transaction(async (transaction) => {
      const identity = await ensureWhatsAppContactIdentity(
        transaction,
        projectId,
        contactId,
        connectionId,
        'omnicus_communications',
      );
      await this.queueCrmIdentitySync(transaction, projectId, contactId, connectionId, identity.id);
      return identity;
    });
  }

  private async queueCrmIdentitySync(
    transaction: Prisma.TransactionClient,
    projectId: string,
    contactId: string,
    connectionId: string,
    identityId: string,
  ) {
    const crm = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId },
    });
    if (!crm?.enabled || crm.status !== 'ACTIVE') return;
    const idempotencyKey = `crm-whatsapp-identity-communications-${identityId}`;
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
        inputSafe: { connectionId, source: 'omnicus_communications' },
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

  private async identity(projectId: string, contactId: string, identityId: string) {
    const identity = await this.database.client.channelIdentity.findUnique({
      include: { connection: { select: { status: true, type: true } } },
      where: { projectId_id: { id: identityId, projectId } },
    });
    if (
      !identity ||
      identity.contactId !== contactId ||
      identity.status !== 'ACTIVE' ||
      identity.connection.status !== 'ACTIVE' ||
      identity.connection.type !== identity.channel
    )
      throw new NotFoundException({ code: 'COMMUNICATION_IDENTITY_NOT_FOUND' });
    return identity;
  }

  private async assertContact(projectId: string, contactId: string) {
    const contact = await this.database.client.contact.findUnique({
      select: { id: true },
      where: { projectId_id: { id: contactId, projectId } },
    });
    if (!contact) throw new NotFoundException({ code: 'CONTACT_NOT_FOUND' });
  }

  private async assertWhatsAppConsent(projectId: string, contactId: string) {
    const contact = await this.database.client.contact.findUnique({
      select: { status: true, whatsAppConsentStatus: true },
      where: { projectId_id: { id: contactId, projectId } },
    });
    if (!contact || contact.status !== 'ACTIVE')
      throw new ConflictException({ code: 'COMMUNICATION_CONTACT_UNAVAILABLE' });
    if (contact.whatsAppConsentStatus !== 'GRANTED')
      throw new ConflictException({ code: 'COMMUNICATION_WHATSAPP_CONSENT_REQUIRED' });
  }

  private safeConnection(connection: {
    botUsername: string | null;
    id: string;
    status: string;
    type: string;
    webhookMetadata: Prisma.JsonValue | null;
  }) {
    const metadata = this.object(connection.webhookMetadata);
    return {
      botUsername: connection.botUsername,
      id: connection.id,
      name:
        this.text(metadata?.name) ??
        this.text(metadata?.displayPhoneNumber) ??
        (connection.type === 'WHATSAPP' ? 'WhatsApp' : 'Telegram'),
      status: connection.status,
      type: connection.type,
    };
  }

  private messagePreview(content: Prisma.JsonValue, type: string) {
    const value = this.object(content);
    const interactive = this.object(value?.interactive);
    return (
      this.text(value?.text) ??
      this.text(value?.caption) ??
      this.text(this.object(value?.richMessage)?.markdown) ??
      this.text(interactive?.title) ??
      this.text(interactive?.displayText) ??
      this.text(this.object(value?.whatsAppTemplate)?.name) ??
      type.toLowerCase().replaceAll('_', ' ')
    );
  }

  private templateVariables(contact: {
    customFields: Prisma.JsonValue;
    displayName: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    username: string | null;
  }) {
    const customFields = this.object(contact.customFields) ?? {};
    const scalarCustomFields = Object.fromEntries(
      Object.entries(customFields).flatMap(([key, value]) =>
        ['boolean', 'number', 'string'].includes(typeof value) && String(value).trim()
          ? [[key, String(value)]]
          : [],
      ),
    );
    const nameParts = contact.displayName.trim().split(/\s+/);
    return Object.fromEntries(
      Object.entries({
        ...scalarCustomFields,
        displayName: contact.displayName,
        email: contact.email,
        firstName: contact.firstName ?? nameParts[0],
        fullName: contact.displayName,
        lastName: contact.lastName ?? (nameParts.length > 1 ? nameParts.slice(1).join(' ') : null),
        name: contact.displayName,
        phone: contact.phone,
        username: contact.username,
      }).flatMap(([key, value]) => (value === null || value === undefined ? [] : [[key, value]])),
    );
  }

  private object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
}
