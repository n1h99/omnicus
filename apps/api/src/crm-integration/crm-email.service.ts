import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EmailInboxService, type CrmEmailActor } from '../email-inbox/email-inbox.service';
import { CrmOutboundService } from './crm-outbound.service';
import { MediaService } from '../media/media.service';
import type {
  CrmEmailScopeDto,
  CrmSendEmailDto,
  CrmEmailUploadDto,
  CrmEmailReadDto,
  CrmEmailUnreadSummaryDto,
} from './crm-email.dto';

@Injectable()
export class CrmEmailService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CrmOutboundService) private readonly outbound: CrmOutboundService,
    @Inject(EmailInboxService) private readonly inbox: EmailInboxService,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  private async scope(input: CrmEmailScopeDto, authenticatedProjectId?: string) {
    await this.outbound.assertProjectRoute(
      input.crmProjectId,
      input.omnicusProjectId,
      authenticatedProjectId,
    );
    const contact = await this.database.client.contact.findFirst({
      where: {
        projectId: input.omnicusProjectId,
        crmLeadId: input.crmLeadId,
        status: { not: 'MERGED' },
      },
      select: { id: true, email: true, normalizedEmail: true, status: true },
    });
    if (!contact) throw new ConflictException('CRM_EMAIL_CONTACT_NOT_SYNCHRONIZED');
    const actor: CrmEmailActor = {
      kind: 'crm',
      userId: input.crmUserId,
      crmLeadId: input.crmLeadId,
      contactId: contact.id,
    };
    return { contact, actor };
  }

  async context(input: CrmEmailScopeDto, projectId?: string) {
    const { contact, actor } = await this.scope(input, projectId);
    const mailboxes = await this.inbox.mailboxes(input.omnicusProjectId, actor);
    return {
      email: contact.normalizedEmail ?? contact.email,
      canSend: contact.status === 'ACTIVE',
      mailboxes: mailboxes.map(({ memberUserIds: _members, ...mailbox }) => mailbox),
    };
  }

  async threads(input: CrmEmailScopeDto, projectId?: string) {
    const { actor } = await this.scope(input, projectId);
    const page = await this.inbox.threads(input.omnicusProjectId, actor, {
      folder: 'all',
      contactId: actor.contactId,
      page: input.page,
    });
    const counts = await this.database.client.emailMessage.groupBy({
      by: ['threadId'],
      where: {
        projectId: input.omnicusProjectId,
        threadId: { in: page.items.map((thread) => thread.id) },
        direction: 'INBOUND',
        crmRead: { is: null },
      },
      _count: { _all: true },
    });
    const unread = new Map(counts.map((row) => [row.threadId, row._count._all]));
    return {
      ...page,
      items: page.items.map((thread) => ({
        ...thread,
        unreadCount: unread.get(thread.id) ?? 0,
        unread: (unread.get(thread.id) ?? 0) > 0,
      })),
    };
  }

  async thread(input: CrmEmailScopeDto, threadId: string, projectId?: string) {
    const { actor } = await this.scope(input, projectId);
    const thread = await this.inbox.thread(input.omnicusProjectId, threadId, actor, input.before);
    const where = {
      projectId: input.omnicusProjectId,
      threadId,
      direction: 'INBOUND',
      crmRead: { is: null },
    };
    const [unreadCount, unreadMessages] = await Promise.all([
      this.database.client.emailMessage.count({ where }),
      this.database.client.emailMessage.findMany({
        where: { ...where, id: { in: thread.messages.map((message) => message.id) } },
        select: { id: true },
      }),
    ]);
    return {
      ...thread,
      unreadCount,
      unread: unreadCount > 0,
      readMessageIds: unreadMessages.map((message) => message.id),
    };
  }

  async unreadSummary(input: CrmEmailUnreadSummaryDto, projectId?: string) {
    await this.outbound.assertProjectRoute(input.crmProjectId, input.omnicusProjectId, projectId);
    const threads = await this.database.client.emailThread.findMany({
      where: {
        projectId: input.omnicusProjectId,
        mailbox: { is: { projectId: input.omnicusProjectId, shared: true } },
        contact: {
          is: {
            projectId: input.omnicusProjectId,
            crmLeadId: { in: input.crmLeadIds },
            status: { not: 'MERGED' },
          },
        },
        messages: { some: { direction: 'INBOUND', crmRead: { is: null } } },
      },
      select: {
        contact: { select: { crmLeadId: true } },
        _count: {
          select: { messages: { where: { direction: 'INBOUND', crmRead: { is: null } } } },
        },
      },
    });
    const counts = new Map(input.crmLeadIds.map((id) => [id, 0]));
    for (const thread of threads) {
      const leadId = thread.contact?.crmLeadId;
      if (leadId && counts.has(leadId))
        counts.set(leadId, counts.get(leadId)! + thread._count.messages);
    }
    return { items: [...counts].map(([leadId, unreadCount]) => ({ leadId, unreadCount })) };
  }

  async markRead(input: CrmEmailReadDto, threadId: string, projectId?: string) {
    const { actor } = await this.scope(input, projectId);
    await this.inbox.assertThread(input.omnicusProjectId, threadId, actor);
    const messages = await this.database.client.emailMessage.findMany({
      where: {
        projectId: input.omnicusProjectId,
        threadId,
        direction: 'INBOUND',
        id: { in: input.messageIds },
      },
      select: { id: true },
    });
    if (messages.length !== new Set(input.messageIds).size)
      throw new NotFoundException('CRM_EMAIL_MESSAGE_NOT_FOUND');
    // Explicit IDs, not "read through now": concurrent or backdated arrivals remain unread.
    await this.database.client.emailMessageCrmRead.createMany({
      data: messages.map(({ id }) => ({
        projectId: input.omnicusProjectId,
        messageId: id,
        readByUserId: actor.userId,
      })),
      skipDuplicates: true,
    });
    return { ok: true };
  }

  async send(input: CrmSendEmailDto, projectId?: string) {
    const { contact, actor } = await this.scope(input, projectId);
    if (contact.status !== 'ACTIVE') throw new ConflictException('CRM_EMAIL_CONTACT_NOT_ACTIVE');
    const to = (contact.normalizedEmail ?? contact.email)?.trim().toLowerCase();
    if (!to || input.to.trim().toLowerCase() !== to)
      throw new BadRequestException('CRM_EMAIL_RECIPIENT_MISMATCH');
    if (input.replyToMessageId) {
      if (!input.threadId) throw new BadRequestException('CRM_EMAIL_REPLY_THREAD_REQUIRED');
      const reply = await this.database.client.emailMessage.findFirst({
        where: {
          projectId: input.omnicusProjectId,
          threadId: input.threadId,
          id: input.replyToMessageId,
        },
        select: { id: true },
      });
      if (!reply) throw new NotFoundException('CRM_EMAIL_REPLY_NOT_FOUND');
    }
    return this.inbox.send(
      input.omnicusProjectId,
      {
        requestId: input.requestId,
        mailboxId: input.mailboxId,
        to,
        subject: input.subject,
        text: input.text,
        ...(input.assetIds ? { assetIds: input.assetIds } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      },
      actor,
    );
  }

  async upload(
    input: CrmEmailUploadDto,
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined,
    projectId?: string,
  ) {
    const { contact, actor } = await this.scope(input, projectId);
    if (contact.status !== 'ACTIVE') throw new ConflictException('CRM_EMAIL_CONTACT_NOT_ACTIVE');
    const project = await this.database.client.project.findUnique({
      where: { id: input.omnicusProjectId },
      select: { status: true },
    });
    if (project?.status !== 'ACTIVE') throw new ConflictException('email_project_not_active');
    await this.inbox.assertMailbox(input.omnicusProjectId, input.mailboxId, actor, true);
    return this.media.uploadFromService(
      input.omnicusProjectId,
      'DOCUMENT',
      file,
      JSON.stringify([actor.contactId, actor.userId, input.requestId]),
      input.requestId,
      'email',
      { contactId: actor.contactId, userId: actor.userId },
    );
  }

  async attachment(input: CrmEmailScopeDto, id: string, projectId?: string) {
    const { actor } = await this.scope(input, projectId);
    return this.inbox.attachment(input.omnicusProjectId, id, actor);
  }

  async outgoingAttachment(
    input: CrmEmailScopeDto,
    messageId: string,
    assetId: string,
    projectId?: string,
  ) {
    const { actor } = await this.scope(input, projectId);
    return this.inbox.outgoingAttachment(input.omnicusProjectId, messageId, assetId, actor);
  }
}
