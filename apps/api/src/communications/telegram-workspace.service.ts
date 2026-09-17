import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@omnicus/database';
import { AccessService } from '../access/access.service';
import type { RequestSecurityContext } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { MediaService } from '../media/media.service';
import { CrmOutboundService } from '../crm-integration/crm-outbound.service';
import { CrmTelegramV3Service } from '../crm-integration/crm-telegram-v3.service';
import {
  CrmAutomationStateDto,
  CrmBotInterfaceDto,
  CrmChatActionDto,
  CrmMediaGroupDto,
  CrmMessageMutationDto,
  CrmOutboundMessageDto,
  CrmPinMessageDto,
  CrmReactionDto,
  CrmScheduledMessageDto,
  CrmScheduledMessageUpdateDto,
} from '../crm-integration/dto';
import type { TelegramWorkspaceWriteDto } from './telegram-workspace.dto';
import { CommunicationDraftDto } from './telegram-workspace.dto';

type Scope = Awaited<ReturnType<TelegramWorkspaceService['scope']>>;
type Entry = Prisma.CommunicationEntryGetPayload<{ include: { owner: true } }>;
type MessageRow = Prisma.MessageGetPayload<{
  include: { mediaAsset: true; scheduledMessage: true };
}>;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** JWT-only facade for the CRM chat UI contract. No CRM credentials or lead creation. */
@Injectable()
export class TelegramWorkspaceService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(CrmOutboundService) private readonly outbound: CrmOutboundService,
    @Inject(CrmTelegramV3Service) private readonly telegram: CrmTelegramV3Service,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  async scope(projectId: string, contactId: string, identityId: string) {
    const identity = await this.database.client.channelIdentity.findFirst({
      where: {
        projectId,
        contactId,
        id: identityId,
        channel: 'TELEGRAM',
        status: 'ACTIVE',
        contact: { status: { not: 'MERGED' } },
        connection: { type: 'TELEGRAM', status: 'ACTIVE', project: { status: 'ACTIVE' } },
      },
      include: { contact: true, connection: true },
    });
    if (!identity) throw new NotFoundException({ code: 'COMMUNICATION_IDENTITY_NOT_FOUND' });
    const dto = {
      crmProjectId: projectId,
      omnicusProjectId: projectId,
      omnicusContactId: contactId,
      identity: {
        channel: 'telegram' as const,
        channelIdentityId: identityId,
        connectionId: identity.connectionId,
      },
    };
    return {
      projectId,
      contactId,
      identityId,
      identity,
      dto,
      native: { projectId, source: 'omnicus' as const },
      query: {
        crmProjectId: projectId,
        omnicusProjectId: projectId,
        omnicusContactId: contactId,
        channelIdentityId: identityId,
        connectionId: identity.connectionId,
        channel: 'telegram' as const,
      },
      namespace: `telegram:${identityId}`,
    };
  }

  async read(
    projectId: string,
    contactId: string,
    identityId: string,
    resource: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    if (resource.length > 2000)
      throw new BadRequestException({ code: 'WORKSPACE_RESOURCE_INVALID' });
    const scope = await this.scope(projectId, contactId, identityId);
    const [path = '', search] = resource.split('?');
    if (path === '' || path === 'messages')
      return this.history(scope, new URLSearchParams(search), path === 'messages');
    if (path === 'capabilities') {
      const capabilities = await this.telegram.capabilities(scope.query, scope.native);
      const canManageChannel = await this.access.hasProjectPermission(
        actor.userId,
        projectId,
        'channels:manage',
      );
      if (!canManageChannel)
        capabilities.capabilities.botInterface = {
          supported: false,
          reasonCode: 'PERMISSION_REQUIRED',
        };
      return capabilities;
    }
    if (path === 'automation-state')
      return this.telegram.automationState(scope.query, scope.native);
    if (path === 'bot-interface') {
      await this.requirePermission(actor, projectId, 'channels:manage');
      return this.telegram.botInterface(scope.query, scope.native);
    }
    if (path === 'draft') {
      const row = await this.database.client.communicationEntry.findUnique({
        where: {
          projectId_namespace_key: {
            projectId,
            namespace: scope.namespace,
            key: `draft:${actor.userId}`,
          },
        },
        include: { owner: true },
      });
      return row && Date.parse(text(object(row.data).expiresAt)) > Date.now()
        ? this.entry(row)
        : null;
    }
    if (path === 'notes') {
      const rows = await this.database.client.communicationEntry.findMany({
        where: { projectId, contactId, namespace: scope.namespace, kind: 'NOTE' },
        include: { owner: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map((row) => this.entry(row));
    }
    if (path === 'quick-replies') return this.quickReplies(scope, actor);
    if (path === 'directory') {
      const members = await this.database.client.projectMembership.findMany({
        where: { projectId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
        include: { user: true },
      });
      return members.map(({ user }) => ({
        id: user.id,
        name: `${user.firstName} ${user.lastName}`.trim(),
        email: user.email,
        role: 'USER',
      }));
    }
    if (path === 'workspace') {
      const contact = scope.identity.contact;
      const variables = {
        'client.name': contact.displayName,
        'client.username': contact.username ? `@${contact.username}` : '',
        'client.phone': contact.phone ?? '',
        'client.email': contact.email ?? '',
        'lead.id': contact.crmLeadId ?? contact.id,
        'manager.name': actor.email,
      };
      return {
        lead: {
          id: contact.id,
          title: contact.displayName,
          status: contact.status,
          workFolder: 'Omnicus',
          manager: null,
          car: null,
        },
        variables,
        variableKeys: Object.keys(variables),
      };
    }
    if (path.startsWith('media/')) {
      const row = await this.message(scope, path.slice(6));
      if (!row.mediaAssetId) throw new NotFoundException({ code: 'MEDIA_ASSET_NOT_FOUND' });
      await this.media.materialize(projectId, row.mediaAssetId, actor, context);
      return this.media.signedUrl(projectId, row.mediaAssetId);
    }
    throw new NotFoundException({ code: 'WORKSPACE_RESOURCE_NOT_FOUND' });
  }

  async write(
    projectId: string,
    contactId: string,
    identityId: string,
    input: TelegramWorkspaceWriteDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const scope = await this.scope(projectId, contactId, identityId);
    const { resource, method, payload } = input;
    if (JSON.stringify(payload).length > 100_000)
      throw new BadRequestException({ code: 'WORKSPACE_PAYLOAD_TOO_LARGE' });
    if (resource === 'draft') return this.saveDraft(scope, method, payload, actor);
    if (resource === 'notes' || resource.startsWith('notes/'))
      return this.saveNote(scope, resource.slice(6), method, payload, actor);
    if (resource === 'quick-replies' || resource.startsWith('quick-replies/'))
      return this.saveQuickReply(scope, resource.slice(14), method, payload, actor);
    const body = {
      ...payload,
      ...scope.dto,
      crmLeadId: scope.identity.contact.crmLeadId ?? undefined,
    };
    if (resource === 'chat-actions' && method === 'POST')
      return this.telegram.chatAction(await this.checked(CrmChatActionDto, body), scope.native);
    const requestId = this.requiredText(payload.clientRequestId, 128);
    const key = `omnicus-${identityId}-${requestId}`;
    if ((resource === 'messages' || resource === 'scheduled') && method === 'POST') {
      const dto =
        resource === 'scheduled'
          ? await this.checked(CrmScheduledMessageDto, body)
          : await this.checked(CrmOutboundMessageDto, body);
      const result = await this.outbound.queue(dto, key, context.correlationId, projectId, {
        source: 'omnicus',
        actorUserId: actor.userId,
        actorEmail: actor.email,
      });
      const row = await this.message(scope, result.messageId);
      const serialized = await this.serialize(row);
      return resource === 'scheduled' ? { ...result, message: serialized } : serialized;
    }
    if (resource === 'media-group' && method === 'POST')
      return this.telegram.mediaGroup(
        await this.checked(CrmMediaGroupDto, body),
        key,
        context.correlationId,
        scope.native,
      );
    if (resource === 'automation-state' && method === 'PUT')
      return this.telegram.setAutomationState(
        await this.checked(CrmAutomationStateDto, body),
        key,
        context.correlationId,
        scope.native,
      );
    if (resource === 'bot-interface' && method === 'PUT') {
      await this.requirePermission(actor, projectId, 'channels:manage');
      return this.telegram.setBotInterface(
        await this.checked(CrmBotInterfaceDto, {
          ...body,
          connectionId: scope.identity.connectionId,
        }),
        key,
        context.correlationId,
        scope.native,
      );
    }
    const scheduled = /^scheduled\/([^/]+)$/.exec(resource);
    if (scheduled?.[1]) {
      if (method === 'DELETE')
        return this.outbound.cancelScheduled(scheduled[1], scope.query, projectId, true);
      if (method === 'PATCH')
        return this.outbound.updateScheduled(
          scheduled[1],
          await this.checked(CrmScheduledMessageUpdateDto, payload),
          scope.query,
          key,
          context.correlationId,
          projectId,
          true,
        );
    }
    const mutation = /^messages\/([^/]+)(?:\/(reaction|pin))?$/.exec(resource);
    if (mutation?.[1]) {
      const messageId = mutation[1];
      const row = await this.message(scope, messageId);
      if (!mutation[2] && method === 'PATCH') {
        const content = row.mediaAssetId
          ? { ...body, caption: payload.text, text: undefined }
          : body;
        return this.telegram.edit(
          messageId,
          await this.checked(CrmMessageMutationDto, content),
          key,
          context.correlationId,
          scope.native,
        );
      }
      if (!mutation[2] && method === 'DELETE')
        return this.telegram.delete(messageId, scope.dto, key, context.correlationId, scope.native);
      if (mutation[2] === 'reaction' && ['PUT', 'DELETE'].includes(method))
        return this.telegram.reaction(
          messageId,
          method === 'DELETE' ? scope.dto : await this.checked(CrmReactionDto, body),
          key,
          context.correlationId,
          scope.native,
        );
      if (mutation[2] === 'pin' && ['PUT', 'DELETE'].includes(method))
        return this.telegram.pin(
          messageId,
          await this.checked(CrmPinMessageDto, body),
          method === 'PUT',
          key,
          context.correlationId,
          scope.native,
        );
    }
    const retry = /^operations\/([^/]+)\/retry$/.exec(resource);
    if (retry?.[1] && method === 'POST') {
      const operation = await this.database.client.outboxRecord.findFirst({
        where: {
          projectId,
          id: retry[1],
          connectionId: scope.identity.connectionId,
          kind: 'TELEGRAM',
        },
      });
      if (!operation) throw new NotFoundException({ code: 'OPERATION_NOT_FOUND' });
      await this.message(scope, text(object(operation.payload).messageId));
      return this.telegram.retry(
        operation.id,
        { crmProjectId: projectId, omnicusProjectId: projectId, retryRequestId: key },
        context.correlationId,
        scope.native,
      );
    }
    throw new NotFoundException({ code: 'WORKSPACE_ACTION_NOT_FOUND' });
  }

  private async history(scope: Scope, params: URLSearchParams, pageOnly: boolean) {
    const conversation = await this.database.client.conversation.findUnique({
      where: {
        projectId_connectionId_externalChatId: {
          projectId: scope.projectId,
          connectionId: scope.identity.connectionId,
          externalChatId: scope.identity.externalUserId,
        },
      },
    });
    const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 50));
    const where: Prisma.MessageWhereInput = {
      projectId: scope.projectId,
      contactId: scope.contactId,
      connectionId: scope.identity.connectionId,
      ...(conversation ? { conversationId: conversation.id } : { id: '__none__' }),
    };
    const cursor = params.get('cursor');
    const and: Prisma.MessageWhereInput[] = [];
    if (cursor) {
      const anchor = await this.message(scope, cursor);
      and.push({
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ],
      });
    }
    const from = params.get('dateFrom');
    const to = params.get('dateTo');
    if (from || to) {
      if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to))))
        throw new BadRequestException({ code: 'HISTORY_DATE_INVALID' });
      and.push({
        createdAt: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        },
      });
    }
    const query = params.get('query')?.trim();
    if (query)
      and.push({
        OR: [
          { content: { path: ['text'], string_contains: query, mode: 'insensitive' } },
          { content: { path: ['caption'], string_contains: query, mode: 'insensitive' } },
          { mediaAsset: { originalFilename: { contains: query, mode: 'insensitive' } } },
        ],
      });
    switch (params.get('filter')) {
      case 'media':
        where.type = {
          in: ['PHOTO', 'VIDEO', 'AUDIO', 'VOICE', 'VIDEO_NOTE', 'ANIMATION', 'STICKER'],
        };
        break;
      case 'documents':
        where.type = 'DOCUMENT';
        break;
      case 'failed':
        where.status = { in: ['FAILED', 'UNKNOWN'] };
        break;
      case 'automation':
        and.push({ metadata: { path: ['source'], equals: 'automation' } });
        break;
      case 'manager':
        and.push({
          OR: [
            { metadata: { path: ['source'], equals: 'crm' } },
            { metadata: { path: ['source'], equals: 'omnicus' } },
          ],
        });
        break;
      case 'links':
        and.push({
          OR: [
            { content: { path: ['text'], string_contains: 'http' } },
            { content: { path: ['caption'], string_contains: 'http' } },
          ],
        });
        break;
    }
    where.AND = and;
    const rows = await this.database.client.message.findMany({
      where,
      include: { mediaAsset: true, scheduledMessage: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const visible = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (visible.at(-1)?.id ?? null) : null;
    const messages = await Promise.all([...visible].reverse().map((row) => this.serialize(row)));
    if (pageOnly) return { messages, nextCursor, hasMore: Boolean(nextCursor) };
    const operations = visible.length
      ? await this.database.client.outboxRecord.findMany({
          where: {
            projectId: scope.projectId,
            connectionId: scope.identity.connectionId,
            kind: 'TELEGRAM',
            OR: visible.map((row) => ({ payload: { path: ['messageId'], equals: row.id } })),
          },
          orderBy: { createdAt: 'asc' },
          take: 500,
        })
      : [];
    return {
      conversation: {
        _id: conversation?.id ?? scope.identityId,
        leadId: scope.contactId,
        channel: 'telegram',
        accountType: 'company',
        channelAccountId: scope.identity.connectionId,
        transport: 'omnicus',
        externalContactId: scope.identity.externalUserId,
        externalChatId: scope.identity.externalUserId,
        crmProjectId: scope.projectId,
        omnicusProjectId: scope.projectId,
        omnicusContactId: scope.contactId,
        omnicusChannelIdentityId: scope.identityId,
        omnicusConnectionId: scope.identity.connectionId,
        omnicusConversationId: conversation?.id,
        status: 'open',
        unreadCount: 0,
        participant: {
          externalUserId: scope.identity.externalUserId,
          username: scope.identity.username ?? undefined,
          firstName: scope.identity.contact.displayName,
        },
      },
      messages,
      messagePage: { nextCursor, hasMore: Boolean(nextCursor) },
      operations: operations
        .filter((row) =>
          ['EDIT_MESSAGE', 'DELETE_MESSAGE', 'SET_REACTION', 'PIN_MESSAGE'].includes(
            text(object(row.payload).action),
          ),
        )
        .map((row) => {
          const payload = object(row.payload);
          return {
            _id: row.id,
            providerOperationId: row.id,
            omnicusMessageId: payload.messageId,
            messageDocumentId: payload.messageId,
            action: payload.action,
            status: ['PENDING', 'RETRY'].includes(row.status) ? 'queued' : row.status.toLowerCase(),
            errorCode: row.lastError,
            errorMessage: row.lastError,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
        }),
    };
  }

  private async message(scope: Scope, id: string) {
    const row = await this.database.client.message.findFirst({
      where: {
        id,
        projectId: scope.projectId,
        contactId: scope.contactId,
        connectionId: scope.identity.connectionId,
        conversation: { externalChatId: scope.identity.externalUserId },
      },
      include: { mediaAsset: true, scheduledMessage: true },
    });
    if (!row) throw new NotFoundException({ code: 'MESSAGE_NOT_FOUND' });
    return row;
  }

  private async serialize(row: MessageRow) {
    const content = object(row.content);
    const metadata = object(row.metadata);
    const asset = row.mediaAsset;
    const schedule = row.scheduledMessage;
    let url: string | undefined;
    if (asset?.status === 'AVAILABLE')
      url = (await this.media.signedUrl(row.projectId, asset.id).catch(() => null))?.url;
    const reaction = object(metadata.managerReaction);
    return {
      _id: row.id,
      leadId: row.contactId,
      conversationId: row.conversationId,
      omnicusMessageId: row.id,
      providerMessageId: row.externalMessageId,
      externalMessageId: row.externalMessageId,
      direction: row.direction.toLowerCase(),
      status: metadata.deleted ? 'deleted' : row.status.toLowerCase(),
      text:
        text(content.text) || text(content.caption) || text(object(content.richMessage).markdown),
      source: ['crm', 'omnicus'].includes(text(metadata.source))
        ? 'CRM'
        : text(metadata.source).toUpperCase() || 'SYSTEM',
      senderUserId: metadata.actorUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      occurredAt: row.createdAt,
      entities: metadata.entities ?? content.entities,
      inlineKeyboard: content.inlineKeyboard ?? metadata.inlineKeyboard,
      replyMarkup: metadata.replyMarkup,
      replyToMessageId: metadata.replyToOmnicusMessageId ?? metadata.replyToMessageId,
      quote: metadata.quote,
      quotePosition: metadata.quotePosition,
      linkPreviewOptions: metadata.linkPreviewOptions,
      protectContent: metadata.protectContent,
      disableNotification: metadata.disableNotification,
      messageEffectId: metadata.messageEffectId,
      isPinned: metadata.pinned === true,
      editedAt: metadata.editedAt,
      deletedAt: metadata.deleted ? row.updatedAt : undefined,
      managerReaction: reaction.type
        ? { type: reaction.type, value: reaction.emoji ?? reaction.customEmojiId }
        : undefined,
      clientReactions: metadata.clientReactions,
      clientReactionActor: metadata.clientReactionActor,
      clientReactionOccurredAt: metadata.clientReactionOccurredAt,
      richMessage: content.richMessage,
      structured: content.structured,
      sharedContact: content.contact ?? (row.type === 'CONTACT' ? content : undefined),
      interactive:
        row.type === 'CALLBACK_QUERY' ? { type: 'callback_query', ...content } : undefined,
      attachment: asset
        ? {
            type: ['PHOTO', 'ANIMATION'].includes(asset.kind)
              ? 'image'
              : ['VIDEO', 'VIDEO_NOTE'].includes(asset.kind)
                ? 'video'
                : ['VOICE', 'AUDIO'].includes(asset.kind)
                  ? 'audio'
                  : asset.kind === 'STICKER'
                    ? 'sticker'
                    : 'file',
            kind: asset.kind,
            url,
            fileName: asset.originalFilename ?? asset.kind.toLowerCase(),
            mimeType: asset.detectedMimeType ?? asset.declaredMimeType ?? '',
            size: Number(asset.sizeBytes ?? 0),
            storageStatus: url ? 'stored' : 'metadata_only',
            availability: url ? 'available' : 'unavailable',
            providerAssetId: asset.id,
            durationSeconds: metadata.durationSeconds ?? content.durationSeconds,
            hasSpoiler: metadata.hasSpoiler ?? content.hasSpoiler,
            mediaGroupId: metadata.mediaGroupId ?? content.mediaGroupId,
            emoji: content.emoji,
            setName: content.setName,
          }
        : undefined,
      ...(schedule
        ? {
            scheduleId: schedule.status === 'CANCELLED' ? undefined : schedule.id,
            scheduledAt: schedule.scheduledAt,
            scheduleTimezone: schedule.timezone,
            scheduleRecurrence: schedule.recurrence,
            scheduleRevision: schedule.revision,
            scheduleOccurrence: schedule.occurrence,
            ...(schedule.status === 'CANCELLED'
              ? { status: 'deleted', deletedAt: schedule.cancelledAt }
              : {}),
          }
        : {}),
    };
  }

  private entry(row: Entry) {
    return {
      ...object(row.data),
      _id: row.id,
      leadId: row.contactId,
      userId: row.ownerUserId,
      authorUserId: row.ownerUserId,
      ownerUserId: row.ownerUserId,
      authorName: `${row.owner.firstName} ${row.owner.lastName}`.trim() || row.owner.email,
      channel: 'telegram',
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async saveDraft(
    scope: Scope,
    method: string,
    payload: Record<string, unknown>,
    actor: AuthenticatedUser,
  ) {
    const key = `draft:${actor.userId}`;
    const where = { projectId: scope.projectId, namespace: scope.namespace, key };
    if (method === 'DELETE') {
      await this.database.client.communicationEntry.deleteMany({ where });
      return { deleted: true };
    }
    if (method !== 'PUT') throw new BadRequestException({ code: 'WORKSPACE_METHOD_INVALID' });
    const value = text(payload.text);
    if (value.length > 20_000 || !['message', 'note'].includes(text(payload.composerMode)))
      throw new BadRequestException({ code: 'DRAFT_INVALID' });
    const draft = await this.checked(CommunicationDraftDto, payload);
    if (
      draft.inlineKeyboard?.some(
        (row) =>
          !Array.isArray(row) || row.some((button) => typeof object(button).text !== 'string'),
      )
    )
      throw new BadRequestException({ code: 'DRAFT_INVALID' });
    const data = json({
      ...draft,
      text: value,
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });
    const row = await this.database.client.communicationEntry.upsert({
      where: { projectId_namespace_key: where },
      create: {
        ...where,
        kind: 'DRAFT',
        contactId: scope.contactId,
        ownerUserId: actor.userId,
        data,
      },
      update: { data, revision: { increment: 1 } },
      include: { owner: true },
    });
    return this.entry(row);
  }

  private async saveNote(
    scope: Scope,
    id: string,
    method: string,
    payload: Record<string, unknown>,
    actor: AuthenticatedUser,
  ) {
    const where = {
      projectId: scope.projectId,
      contactId: scope.contactId,
      namespace: scope.namespace,
      kind: 'NOTE',
      id,
    };
    const existing = id ? await this.database.client.communicationEntry.findFirst({ where }) : null;
    if (id && !existing) throw new NotFoundException({ code: 'NOTE_NOT_FOUND' });
    if (existing?.ownerUserId !== actor.userId && existing)
      await this.requirePermission(actor, scope.projectId, 'project:manage');
    if (method === 'DELETE' && existing) {
      await this.database.client.communicationEntry.deleteMany({ where });
      return { deleted: true };
    }
    if (!(method === 'POST' && !id) && !(method === 'PATCH' && existing))
      throw new BadRequestException({ code: 'WORKSPACE_METHOD_INVALID' });
    const value = this.requiredText(payload.text, 20_000);
    const ids = Array.isArray(payload.mentionedUserIds)
      ? [...new Set(payload.mentionedUserIds.filter((id): id is string => typeof id === 'string'))]
      : [];
    if (ids.length > 50) throw new BadRequestException({ code: 'MENTIONS_INVALID' });
    const members = await this.database.client.projectMembership.findMany({
      where: {
        projectId: scope.projectId,
        userId: { in: ids },
        status: 'ACTIVE',
        user: { status: 'ACTIVE' },
      },
      select: { userId: true },
    });
    if (members.length !== ids.length) throw new BadRequestException({ code: 'MENTIONS_INVALID' });
    if (payload.replyToMessageId) await this.message(scope, text(payload.replyToMessageId));
    const data = json({
      text: value,
      mentionedUserIds: ids,
      ...(payload.replyToMessageId ? { replyToMessageId: payload.replyToMessageId } : {}),
      ...(existing ? { editedAt: new Date().toISOString() } : {}),
    });
    const row = existing
      ? await this.database.client.communicationEntry.update({
          where: { id: existing.id },
          data: { data, revision: { increment: 1 } },
          include: { owner: true },
        })
      : await this.database.client.communicationEntry.create({
          data: {
            projectId: scope.projectId,
            contactId: scope.contactId,
            namespace: scope.namespace,
            kind: 'NOTE',
            key: randomUUID(),
            ownerUserId: actor.userId,
            data,
          },
          include: { owner: true },
        });
    return this.entry(row);
  }

  private async quickReplies(scope: Scope, actor: AuthenticatedUser) {
    const rows = await this.database.client.communicationEntry.findMany({
      where: {
        projectId: scope.projectId,
        namespace: 'quick-replies',
        kind: 'QUICK_REPLY',
        OR: [{ ownerUserId: actor.userId }, { data: { path: ['scope'], equals: 'TEAM' } }],
      },
      include: { owner: true },
      orderBy: { createdAt: 'desc' },
    });
    const preferences = await this.database.client.communicationEntry.findMany({
      where: {
        projectId: scope.projectId,
        namespace: 'quick-reply-preferences',
        ownerUserId: actor.userId,
      },
    });
    return rows.map((row) => ({
      ...this.entry(row),
      ...object(preferences.find((pref) => pref.key === `${actor.userId}:${row.id}`)?.data),
    }));
  }

  private async saveQuickReply(
    scope: Scope,
    suffix: string,
    method: string,
    payload: Record<string, unknown>,
    actor: AuthenticatedUser,
  ) {
    const [id = '', action] = suffix.split('/');
    const existing = id
      ? await this.database.client.communicationEntry.findFirst({
          where: {
            id,
            projectId: scope.projectId,
            namespace: 'quick-replies',
            kind: 'QUICK_REPLY',
            OR: [{ ownerUserId: actor.userId }, { data: { path: ['scope'], equals: 'TEAM' } }],
          },
        })
      : null;
    if (id && !existing) throw new NotFoundException({ code: 'QUICK_REPLY_NOT_FOUND' });
    if (
      existing &&
      ((action === 'favorite' && method === 'PUT') || (action === 'use' && method === 'POST'))
    ) {
      if (action === 'favorite' && typeof payload.favorite !== 'boolean')
        throw new BadRequestException({ code: 'FAVORITE_INVALID' });
      const where = {
        projectId: scope.projectId,
        namespace: 'quick-reply-preferences',
        key: `${actor.userId}:${id}`,
      };
      const old = await this.database.client.communicationEntry.findUnique({
        where: { projectId_namespace_key: where },
      });
      const data = json({
        ...object(old?.data),
        ...(action === 'favorite'
          ? { isFavorite: payload.favorite }
          : { lastUsedAt: new Date().toISOString() }),
      });
      await this.database.client.communicationEntry.upsert({
        where: { projectId_namespace_key: where },
        create: { ...where, ownerUserId: actor.userId, kind: 'PREFERENCE', data },
        update: { data },
      });
      return { favorite: payload.favorite, used: action === 'use' };
    }
    if (action) throw new BadRequestException({ code: 'WORKSPACE_RESOURCE_INVALID' });
    if (
      existing &&
      (object(existing.data).scope === 'TEAM' || existing.ownerUserId !== actor.userId)
    )
      await this.requirePermission(actor, scope.projectId, 'project:manage');
    if (method === 'DELETE' && existing) {
      await this.database.client.communicationEntry.delete({ where: { id: existing.id } });
      return { deleted: true };
    }
    if (!(method === 'POST' && !existing) && !(method === 'PATCH' && existing))
      throw new BadRequestException({ code: 'WORKSPACE_METHOD_INVALID' });
    if (!['TEAM', 'PERSONAL'].includes(text(payload.scope)))
      throw new BadRequestException({ code: 'QUICK_REPLY_SCOPE_INVALID' });
    if (payload.scope === 'TEAM')
      await this.requirePermission(actor, scope.projectId, 'project:manage');
    const data = json({
      title: this.requiredText(payload.title, 120),
      content: this.requiredText(payload.content, 4096),
      scope: payload.scope,
    });
    const row = existing
      ? await this.database.client.communicationEntry.update({
          where: { id: existing.id },
          data: { data },
          include: { owner: true },
        })
      : await this.database.client.communicationEntry.create({
          data: {
            projectId: scope.projectId,
            namespace: 'quick-replies',
            key: randomUUID(),
            kind: 'QUICK_REPLY',
            ownerUserId: actor.userId,
            data,
          },
          include: { owner: true },
        });
    return this.entry(row);
  }

  private async checked<T extends object>(
    type: new () => T,
    value: Record<string, unknown>,
  ): Promise<T> {
    const dto = plainToInstance(type, value);
    const errors = await validate(dto, { whitelist: true, forbidUnknownValues: true });
    if (errors.length)
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Review the message fields.',
        details: errors.map((error) => ({
          property: error.property,
          constraints: error.constraints,
        })),
      });
    return dto;
  }

  private requiredText(value: unknown, max: number) {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      throw new BadRequestException({ code: 'WORKSPACE_TEXT_INVALID' });
    return value;
  }

  private async requirePermission(actor: AuthenticatedUser, projectId: string, permission: string) {
    if (!(await this.access.hasProjectPermission(actor.userId, projectId, permission)))
      throw new ForbiddenException({ code: 'PERMISSION_REQUIRED' });
  }
}
