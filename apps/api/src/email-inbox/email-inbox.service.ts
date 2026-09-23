import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiEnvironment } from '@omnicus/config/server';
import { attachMailboxDelivery, MailboxDeliveryError, Prisma } from '@omnicus/database';
import {
  createDefaultEmailDocument,
  emailDocumentSchema,
  mailboxAddressSchema,
  mailboxLocalPartSchema,
  parseMailAddress,
  receivingDomainReady,
  receivedEmailEventSchema,
  replyAliasToken,
  safeMailFilename,
  type ResendMailDomain,
} from '@omnicus/email-core';
import { ResendMailClient, ResendMailApiError } from '@omnicus/email-core/server';
import { S3MediaStorage } from '@omnicus/media-core';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import type {
  CreateEmailMailboxDto,
  SaveEmailDraftDto,
  SendInboxEmailDto,
  UpdateEmailMailboxDto,
  UpdateEmailThreadStateDto,
} from './dto';

type Json = Prisma.InputJsonValue;
export type CrmEmailActor = { kind: 'crm'; userId: string; contactId: string; crmLeadId: string };
// CRM users have no Omnicus membership: expose shared mailboxes and the mapped
// contact only, and audit their actions as CRM rather than an Omnicus user.
type InboxActor = AuthenticatedUser | CrmEmailActor;
const isCrmActor = (actor: InboxActor): actor is CrmEmailActor =>
  'kind' in actor && actor.kind === 'crm';
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

@Injectable()
export class EmailInboxService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService<ApiEnvironment, true>,
  ) {}

  private async manager(projectId: string, actor: AuthenticatedUser) {
    return this.access.hasProjectPermission(actor.userId, projectId, 'email:manage');
  }

  private async mailboxFilter(
    projectId: string,
    actor: InboxActor,
  ): Promise<Prisma.EmailMailboxWhereInput> {
    if (isCrmActor(actor)) return { projectId, shared: true };
    return {
      projectId,
      ...((await this.manager(projectId, actor))
        ? {}
        : {
            OR: [
              { shared: true },
              { members: { some: { userId: actor.userId, membership: { status: 'ACTIVE' } } } },
            ],
          }),
    };
  }

  async assertMailbox(projectId: string, id: string, actor: InboxActor, send = false) {
    const mailbox = await this.database.client.emailMailbox.findFirst({
      include: { domain: true },
      where: { ...(await this.mailboxFilter(projectId, actor)), id },
    });
    if (!mailbox) throw new NotFoundException('email_mailbox_not_found');
    if (
      send &&
      (mailbox.status !== 'ACTIVE' ||
        mailbox.domain.status !== 'verified' ||
        !mailbox.domain.sendingEnabled)
    )
      throw new ConflictException('email_sender_not_ready');
    return mailbox;
  }

  async sender(projectId: string, id: string | null | undefined, actor: AuthenticatedUser) {
    const mailbox = id
      ? await this.assertMailbox(projectId, id, actor, true)
      : await this.database.client.emailMailbox.findFirst({
          where: { projectId, isDefault: true },
        });
    if (!mailbox) return null; // Existing deployments may still use EMAIL_FROM.
    if (!(await this.access.hasProjectPermission(actor.userId, projectId, 'email:send')))
      throw new ForbiddenException('email_sender_access_denied');
    await this.assertMailbox(projectId, mailbox.id, actor, true);
    return mailbox.id;
  }

  async mailboxes(projectId: string, actor: InboxActor) {
    const rows = await this.database.client.emailMailbox.findMany({
      where: await this.mailboxFilter(projectId, actor),
      include: { domain: true, members: { select: { userId: true } } },
      orderBy: [{ isDefault: 'desc' }, { address: 'asc' }],
      take: 200,
    });
    return rows.map((mailbox) => ({
      id: mailbox.id,
      address: mailbox.address,
      displayName: mailbox.displayName,
      signature: mailbox.signature,
      mode: mailbox.mode,
      status: mailbox.status,
      shared: mailbox.shared,
      isDefault: mailbox.isDefault,
      domainId: mailbox.domainId,
      memberUserIds: mailbox.members.map((member) => member.userId),
      sendingReady:
        mailbox.domain.status === 'verified' &&
        mailbox.domain.sendingEnabled &&
        mailbox.status === 'ACTIVE',
      receivingReady:
        mailbox.domain.receivingReady && mailbox.mode === 'TWO_WAY' && mailbox.status === 'ACTIVE',
    }));
  }

  private provider() {
    const key = this.config.get('RESEND_API_KEY', { infer: true });
    if (!key) throw new ServiceUnavailableException('email_provider_not_configured');
    return new ResendMailClient(key);
  }

  async domains(projectId: string) {
    return this.database.client.emailDomain.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
      take: 100,
    });
  }

  async availableDomains(projectId: string, actor: AuthenticatedUser) {
    this.assertDomainAdministrator(actor);
    const claimed = await this.database.client.emailDomain.findMany({
      where: { projectId: { not: projectId } },
      select: { providerDomainId: true },
    });
    try {
      const domains = await this.provider().domains();
      return domains.filter(
        (domain) => !claimed.some((item) => item.providerDomainId === domain.id),
      );
    } catch (error) {
      this.providerError(error);
    }
  }

  async connectDomain(projectId: string, providerDomainId: string, actor: AuthenticatedUser) {
    this.assertDomainAdministrator(actor);
    try {
      const domain = await this.provider().domain(providerDomainId);
      const existing = await this.database.client.emailDomain.findUnique({
        where: { providerDomainId },
      });
      if (existing && existing.projectId !== projectId)
        throw new ConflictException('email_domain_already_assigned');
      const result = existing
        ? await this.database.client.emailDomain.update({
            where: { projectId_id: { projectId, id: existing.id } },
            data: this.domainSnapshot(domain),
          })
        : await this.database.client.emailDomain.create({
            data: { projectId, providerDomainId, ...this.domainSnapshot(domain) },
          });
      await this.record('email.domain_connected', projectId, result.id, actor);
      return result;
    } catch (error) {
      this.providerError(error);
    }
  }

  async refreshDomain(projectId: string, id: string) {
    const domain = await this.database.client.emailDomain.findFirst({ where: { projectId, id } });
    if (!domain) throw new NotFoundException('email_domain_not_found');
    try {
      const snapshot = await this.provider().domain(domain.providerDomainId);
      if (snapshot.name.toLowerCase() !== domain.name)
        throw new ConflictException('email_domain_identity_changed');
      return await this.database.client.emailDomain.update({
        where: { id },
        data: this.domainSnapshot(snapshot),
      });
    } catch (error) {
      this.providerError(error);
    }
  }

  private domainSnapshot(domain: ResendMailDomain) {
    return {
      name: domain.name.toLowerCase(),
      status: domain.status,
      sendingEnabled: domain.capabilities?.sending === 'enabled',
      receivingEnabled: domain.capabilities?.receiving === 'enabled',
      receivingReady: receivingDomainReady(domain),
      region: domain.region ?? null,
      dnsRecords: domain.records as Json,
      lastCheckedAt: new Date(),
    };
  }

  private assertDomainAdministrator(actor: AuthenticatedUser) {
    if (!actor.globalRoleNames.includes('super-admin'))
      throw new ForbiddenException('email_domain_requires_system_admin');
  }

  private providerError(error: unknown): never {
    if (error instanceof ResendMailApiError) throw new ServiceUnavailableException(error.code);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new ConflictException('email_domain_or_address_already_assigned');
    throw error;
  }

  async members(projectId: string) {
    const rows = await this.database.client.projectMembership.findMany({
      where: { projectId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
      select: { userId: true, user: { select: { email: true, firstName: true, lastName: true } } },
      take: 500,
    });
    return rows.map((row) => ({
      id: row.userId,
      email: row.user.email,
      name: [row.user.firstName, row.user.lastName].filter(Boolean).join(' '),
    }));
  }

  private async assertMembers(
    transaction: Prisma.TransactionClient,
    projectId: string,
    ids: string[],
  ) {
    const count = await transaction.projectMembership.count({
      where: { projectId, userId: { in: ids }, status: 'ACTIVE', user: { status: 'ACTIVE' } },
    });
    if (count !== ids.length) throw new BadRequestException('email_mailbox_member_invalid');
  }

  async createMailbox(projectId: string, input: CreateEmailMailboxDto, actor: AuthenticatedUser) {
    if (input.isDefault && input.shared === false)
      throw new BadRequestException('email_default_must_be_shared');
    const local = mailboxLocalPartSchema.safeParse(input.localPart);
    if (!local.success) throw new BadRequestException('email_mailbox_address_invalid');
    const domain = await this.database.client.emailDomain.findFirst({
      where: { projectId, id: input.domainId },
    });
    if (!domain) throw new NotFoundException('email_domain_not_found');
    try {
      const result = await this.database.client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}), 90401)`;
        await this.assertMembers(tx, projectId, input.memberUserIds ?? []);
        if (input.isDefault)
          await tx.emailMailbox.updateMany({
            where: { projectId, isDefault: true },
            data: { isDefault: false },
          });
        return tx.emailMailbox.create({
          data: {
            projectId,
            domainId: domain.id,
            address: local.data + '@' + domain.name,
            displayName: input.displayName.trim(),
            signature: input.signature ?? '',
            mode: input.mode ?? 'TWO_WAY',
            shared: input.shared ?? true,
            isDefault: input.isDefault ?? false,
            members: {
              create: (input.memberUserIds ?? []).map((userId) => ({ projectId, userId })),
            },
          },
        });
      });
      await this.record('email.mailbox_created', projectId, result.id, actor);
      return result;
    } catch (error) {
      this.providerError(error);
    }
  }

  async updateMailbox(
    projectId: string,
    id: string,
    input: UpdateEmailMailboxDto,
    actor: AuthenticatedUser,
  ) {
    await this.assertMailbox(projectId, id, actor);
    const result = await this.database.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}), 90401)`;
      const current = await tx.emailMailbox.findUniqueOrThrow({
        where: { projectId_id: { projectId, id } },
      });
      if ((input.isDefault ?? current.isDefault) && !(input.shared ?? current.shared))
        throw new BadRequestException('email_default_must_be_shared');
      if (input.memberUserIds) {
        await this.assertMembers(tx, projectId, input.memberUserIds);
        await tx.emailMailboxMember.deleteMany({ where: { projectId, mailboxId: id } });
        await tx.emailMailboxMember.createMany({
          data: input.memberUserIds.map((userId) => ({ projectId, mailboxId: id, userId })),
        });
      }
      if (input.isDefault)
        await tx.emailMailbox.updateMany({
          where: { projectId, isDefault: true },
          data: { isDefault: false },
        });
      const { memberUserIds: _members, ...changes } = input;
      void _members;
      return tx.emailMailbox.update({ where: { projectId_id: { projectId, id } }, data: changes });
    });
    await this.record('email.mailbox_updated', projectId, id, actor);
    return result;
  }

  async threads(
    projectId: string,
    actor: InboxActor,
    query: {
      mailboxId?: string | undefined;
      folder?: string | undefined;
      q?: string | undefined;
      page?: string | undefined;
      contactId?: string | undefined;
    },
  ) {
    const folder = query.folder ?? 'inbox';
    if (!['inbox', 'sent', 'starred', 'archived', 'all'].includes(folder))
      throw new BadRequestException('email_folder_invalid');
    const page = Math.max(1, Math.min(10_000, Number(query.page) || 1));
    if (!Number.isInteger(page)) throw new BadRequestException('email_page_invalid');
    const search = (query.q ?? '').trim().slice(0, 200);
    const state = { userId: isCrmActor(actor) ? 'crm:' + actor.userId : actor.userId };
    const where: Prisma.EmailThreadWhereInput = {
      projectId,
      mailbox: {
        is: {
          ...(await this.mailboxFilter(projectId, actor)),
          ...(query.mailboxId ? { id: query.mailboxId } : {}),
        },
      },
      ...(isCrmActor(actor)
        ? { contactId: actor.contactId }
        : query.contactId
          ? { contactId: query.contactId }
          : {}),
      ...(folder === 'inbox'
        ? {
            lastInboundAt: { not: null },
            userStates: { none: { ...state, archivedAt: { not: null } } },
          }
        : {}),
      ...(folder === 'sent' ? { lastOutboundAt: { not: null } } : {}),
      ...(folder === 'archived'
        ? { userStates: { some: { ...state, archivedAt: { not: null } } } }
        : {}),
      ...(folder === 'starred' ? { userStates: { some: { ...state, starred: true } } } : {}),
      ...(search
        ? {
            OR: [
              { subject: { contains: search, mode: 'insensitive' } },
              { peerEmail: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.database.client.emailThread.findMany({
        where,
        include: {
          userStates: { where: state },
          mailbox: { select: { address: true, displayName: true } },
        },
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * 30,
        take: 30,
      }),
      this.database.client.emailThread.count({ where }),
    ]);
    return {
      items: rows.map(({ replyToken: _token, userStates, ...thread }) => ({
        ...thread,
        starred: userStates[0]?.starred ?? false,
        archived: Boolean(userStates[0]?.archivedAt),
        unread: Boolean(
          thread.lastInboundAt &&
          (!userStates[0]?.readAt || userStates[0].readAt < thread.lastInboundAt),
        ),
      })),
      total,
      page,
      pageSize: 30,
    };
  }

  async assertThread(projectId: string, threadId: string, actor: InboxActor) {
    const thread = await this.database.client.emailThread.findFirst({
      where: {
        id: threadId,
        projectId,
        ...(isCrmActor(actor) ? { contactId: actor.contactId } : {}),
        mailbox: { is: await this.mailboxFilter(projectId, actor) },
      },
    });
    if (!thread) throw new NotFoundException('email_thread_not_found');
    return thread;
  }

  async thread(projectId: string, id: string, actor: InboxActor, before?: string) {
    const { replyToken: _token, ...thread } = await this.assertThread(projectId, id, actor);
    void _token;
    if (before && !uuidPattern.test(before)) throw new BadRequestException('email_cursor_invalid');
    const cursor = before
      ? await this.database.client.emailMessage.findFirst({
          where: { projectId, threadId: id, id: before },
        })
      : null;
    if (before && !cursor) throw new BadRequestException('email_cursor_invalid');
    const state = isCrmActor(actor)
      ? null
      : await this.database.client.emailThreadUserState.findUnique({
          where: { projectId_threadId_userId: { projectId, threadId: id, userId: actor.userId } },
        });
    const rows = await this.database.client.emailMessage.findMany({
      where: {
        projectId,
        threadId: id,
        ...(cursor
          ? {
              OR: [
                { occurredAt: { lt: cursor.occurredAt } },
                { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 51,
      include: {
        attachments: {
          select: {
            id: true,
            filename: true,
            contentType: true,
            contentId: true,
            sizeBytes: true,
            status: true,
            errorCode: true,
          },
        },
        delivery: {
          select: {
            status: true,
            lastError: true,
            campaignId: true,
            scenarioExecutionId: true,
            attachmentAssetIds: true,
            sentAt: true,
          },
        },
      },
    });
    return {
      ...thread,
      starred: state?.starred ?? false,
      archived: Boolean(state?.archivedAt),
      unread: Boolean(
        thread.lastInboundAt && (!state?.readAt || state.readAt < thread.lastInboundAt),
      ),
      messages: rows
        .slice(0, 50)
        .reverse()
        .map(({ requestHash: _hash, requestKey: _key, ...message }) => message),
      nextCursor: rows.length > 50 ? rows[49]!.id : null,
    };
  }

  async threadState(
    projectId: string,
    threadId: string,
    input: UpdateEmailThreadStateDto,
    actor: AuthenticatedUser,
  ) {
    const thread = await this.assertThread(projectId, threadId, actor);
    const data = {
      ...(input.read === undefined ? {} : { readAt: input.read ? thread.lastMessageAt : null }),
      ...(input.starred === undefined ? {} : { starred: input.starred }),
      ...(input.archived === undefined ? {} : { archivedAt: input.archived ? new Date() : null }),
    };
    return this.database.client.emailThreadUserState.upsert({
      where: { projectId_threadId_userId: { projectId, threadId, userId: actor.userId } },
      create: { projectId, threadId, userId: actor.userId, ...data },
      update: data,
    });
  }

  async receive(event: unknown, providerEventId: string) {
    const parsed = receivedEmailEventSchema.safeParse(event);
    if (!parsed.success) throw new BadRequestException('email_received_event_invalid');
    const at = new Date(parsed.data.created_at);
    if (Number.isNaN(at.getTime())) throw new BadRequestException('email_received_date_invalid');
    const recipients = [
      ...new Set(
        [...parsed.data.data.to, ...(parsed.data.data.cc ?? []), ...(parsed.data.data.bcc ?? [])]
          .map(parseMailAddress)
          .filter((item): item is string => item !== null),
      ),
    ];
    const direct = await this.database.client.emailMailbox.findMany({
      where: { address: { in: recipients }, mode: 'TWO_WAY' },
    });
    const aliases = recipients
      .map((address) => ({ address, token: replyAliasToken(address) }))
      .filter((item) => item.token);
    const threads = aliases.length
      ? await this.database.client.emailThread.findMany({
          where: {
            replyToken: { in: aliases.map((item) => item.token!) },
            mailbox: { mode: 'TWO_WAY' },
          },
          include: { mailbox: true },
        })
      : [];
    const routes = new Map(
      direct.map((mailbox) => [mailbox.id, { mailbox, recipient: mailbox.address }]),
    );
    for (const thread of threads) {
      const alias = aliases.find(
        (candidate) =>
          candidate.token === thread.replyToken &&
          candidate.address.split('@')[1] === thread.mailbox.address.split('@')[1],
      );
      if (alias)
        routes.set(thread.mailboxId, { mailbox: thread.mailbox, recipient: alias.address });
    }
    await this.database.client.emailInboundReceipt.createMany({
      data: [...routes.values()].map(({ mailbox, recipient }) => ({
        mailboxId: mailbox.id,
        projectId: mailbox.projectId,
        providerEmailId: parsed.data.data.email_id,
        providerEventId,
        recipient,
        occurredAt: at,
      })),
      skipDuplicates: true,
    });
    return { accepted: true, ignored: routes.size === 0 };
  }

  async send(projectId: string, input: SendInboxEmailDto, actor: InboxActor) {
    const mailbox = await this.assertMailbox(projectId, input.mailboxId, actor);
    const to = mailboxAddressSchema.parse(input.to);
    if (!input.text.trim() && !input.assetIds?.length)
      throw new BadRequestException('email_message_empty');
    if (input.threadId) {
      const thread = await this.assertThread(projectId, input.threadId, actor);
      if (thread.mailboxId !== mailbox.id || thread.peerEmail !== to)
        throw new BadRequestException('email_thread_recipient_mismatch');
    }
    const requestKey =
      (isCrmActor(actor) ? 'crm:' + actor.crmLeadId + ':' : 'manual:') +
      actor.userId +
      ':' +
      input.requestId;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ ...input, to }))
      .digest('hex');
    const existing = await this.database.client.emailMessage.findUnique({
      where: { projectId_requestKey: { projectId, requestKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ConflictException('email_request_id_reused');
      return { id: existing.id, threadId: existing.threadId, deliveryId: existing.deliveryId };
    }
    await this.assertMailbox(projectId, input.mailboxId, actor, true);
    const project = await this.database.client.project.findUnique({
      where: { id: projectId },
      select: { status: true },
    });
    if (project?.status !== 'ACTIVE') throw new ConflictException('email_project_not_active');
    if (
      await this.database.client.emailSuppression.findUnique({
        where: { projectId_normalizedEmail: { projectId, normalizedEmail: to } },
      })
    )
      throw new ConflictException('email_address_suppressed');
    const assets = await this.assets(projectId, input.assetIds ?? [], actor);
    const document = createDefaultEmailDocument();
    const text = input.text.trim() + (mailbox.signature ? '\n\n' + mailbox.signature : '');
    document.blocks = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 20_000, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      document.blocks.push({
        id: 'text-' + start,
        type: 'TEXT',
        content: text.slice(start, end),
        align: 'left',
        fontSize: 14,
        lineHeight: 1.6,
      });
      start = end;
    }
    document.blocks.push(
      ...assets.map((asset) => ({
        id: asset.id,
        type: 'ATTACHMENT' as const,
        assetId: asset.id,
        fileName: (asset.originalFilename ?? 'attachment').slice(0, 255),
        label: (asset.originalFilename ?? 'Attachment').slice(0, 160),
      })),
    );
    const design = emailDocumentSchema.parse(document);
    try {
      const message = await this.database.client.$transaction(async (tx) => {
        if (input.draftId) {
          const draft = await tx.emailDraft.findFirst({
            where: { projectId, id: input.draftId, userId: actor.userId },
          });
          if (!draft || draft.revision !== input.draftRevision)
            throw new ConflictException('email_draft_changed');
        }
        const contacts = await tx.contact.findMany({
          where: {
            projectId,
            normalizedEmail: to,
            status: 'ACTIVE',
            ...(isCrmActor(actor) ? { id: actor.contactId } : {}),
          },
          take: 2,
          select: { id: true },
        });
        const delivery = await tx.emailDelivery.create({
          data: {
            projectId,
            mailboxId: mailbox.id,
            contactId: contacts.length === 1 ? contacts[0]!.id : null,
            toEmail: to,
            normalizedEmail: to,
            subject: input.subject.trim(),
            source: 'MANUAL',
            designSnapshot: design as Json,
            attachmentAssetIds: assets.map((asset) => asset.id),
          },
        });
        const saved = await attachMailboxDelivery(tx, delivery.id, {
          projectId,
          mailboxId: mailbox.id,
          threadId: input.threadId ?? null,
          replyToMessageId: input.replyToMessageId ?? null,
          requestKey,
          requestHash,
          textBody: text,
        });
        if (!saved) throw new BadRequestException('email_mailbox_unavailable');
        await tx.emailAssetReference.createMany({
          data: assets.map((asset) => ({
            projectId,
            mediaAssetId: asset.id,
            ownerType: 'EMAIL_DELIVERY',
            ownerId: delivery.id,
            usage: 'ATTACHMENT',
          })),
          skipDuplicates: true,
        });
        if (input.draftId) {
          await tx.emailAssetReference.deleteMany({
            where: { projectId, ownerType: 'EMAIL_DRAFT', ownerId: input.draftId },
          });
          const removed = await tx.emailDraft.deleteMany({
            where: {
              projectId,
              id: input.draftId,
              userId: actor.userId,
              revision: input.draftRevision!,
            },
          });
          if (removed.count !== 1) throw new ConflictException('email_draft_changed');
        }
        return saved;
      });
      await this.record('email.message_queued', projectId, message.id, actor);
      return { id: message.id, threadId: message.threadId, deliveryId: message.deliveryId };
    } catch (error) {
      if (error instanceof MailboxDeliveryError) throw new BadRequestException(error.message);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const saved = await this.database.client.emailMessage.findUnique({
          where: { projectId_requestKey: { projectId, requestKey } },
        });
        if (saved?.requestHash === requestHash)
          return { id: saved.id, threadId: saved.threadId, deliveryId: saved.deliveryId };
        throw new ConflictException('email_request_id_reused');
      }
      throw error;
    }
  }

  private async assets(projectId: string, assetIds: string[], actor: InboxActor) {
    if (
      assetIds.length &&
      (isCrmActor(actor) ||
        !(await this.access.hasProjectPermission(actor.userId, projectId, 'media:read')))
    )
      throw new ForbiddenException('email_attachment_access_denied');
    const assets = await this.database.client.mediaAsset.findMany({
      where: { projectId, id: { in: assetIds }, status: 'AVAILABLE' },
    });
    if (assets.length !== assetIds.length)
      throw new BadRequestException('email_attachment_unavailable');
    if (assets.reduce((sum, asset) => sum + Number(asset.sizeBytes ?? 0), 0) > 25 * 1024 * 1024)
      throw new BadRequestException('email_attachments_too_large');
    return assets;
  }

  async drafts(projectId: string, actor: AuthenticatedUser) {
    return this.database.client.emailDraft.findMany({
      where: {
        projectId,
        userId: actor.userId,
        mailbox: { is: await this.mailboxFilter(projectId, actor) },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  async saveDraft(
    projectId: string,
    id: string,
    input: SaveEmailDraftDto,
    actor: AuthenticatedUser,
  ) {
    if (!uuidPattern.test(id)) throw new BadRequestException('email_draft_id_invalid');
    await this.assertMailbox(projectId, input.mailboxId, actor);
    if (input.threadId) {
      const thread = await this.assertThread(projectId, input.threadId, actor);
      if (thread.mailboxId !== input.mailboxId)
        throw new BadRequestException('email_thread_mailbox_mismatch');
    }
    const assets = await this.assets(projectId, input.assetIds ?? [], actor);
    return this.database.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}), hashtext(${id}))`;
      const data = {
        mailboxId: input.mailboxId,
        threadId: input.threadId ?? null,
        toEmail: input.to,
        subject: input.subject,
        textBody: input.text,
        assetIds: input.assetIds ?? [],
      };
      const existing = await tx.emailDraft.findFirst({
        where: { projectId, id, userId: actor.userId },
      });
      // A lost save response can be retried, but a different edit must keep its revision check.
      if (
        existing?.revision === input.revision + 1 &&
        existing.mailboxId === data.mailboxId &&
        existing.threadId === data.threadId &&
        existing.toEmail === data.toEmail &&
        existing.subject === data.subject &&
        existing.textBody === data.textBody &&
        JSON.stringify(existing.assetIds) === JSON.stringify(data.assetIds)
      )
        return existing;
      if (input.revision === 0) {
        if ((await tx.emailDraft.count({ where: { projectId, userId: actor.userId } })) >= 100)
          throw new ConflictException('email_draft_limit_reached');
        const inserted = await tx.emailDraft.createMany({
          data: [{ id, projectId, userId: actor.userId, ...data }],
          skipDuplicates: true,
        });
        if (inserted.count !== 1) throw new ConflictException('email_draft_changed');
      } else {
        const updated = await tx.emailDraft.updateMany({
          where: { projectId, id, userId: actor.userId, revision: input.revision },
          data: { ...data, revision: { increment: 1 } },
        });
        if (updated.count !== 1) throw new ConflictException('email_draft_changed');
      }
      await tx.emailAssetReference.deleteMany({
        where: { projectId, ownerType: 'EMAIL_DRAFT', ownerId: id },
      });
      await tx.emailAssetReference.createMany({
        data: assets.map((asset) => ({
          projectId,
          mediaAssetId: asset.id,
          ownerType: 'EMAIL_DRAFT',
          ownerId: id,
          usage: 'ATTACHMENT',
        })),
      });
      return tx.emailDraft.findUniqueOrThrow({ where: { projectId_id: { projectId, id } } });
    });
  }

  async deleteDraft(projectId: string, id: string, revision: number, actor: AuthenticatedUser) {
    const draft = await this.database.client.emailDraft.findFirst({
      where: { projectId, id, userId: actor.userId },
    });
    if (!draft) throw new NotFoundException('email_draft_not_found');
    await this.assertMailbox(projectId, draft.mailboxId, actor);
    await this.database.client.$transaction(async (tx) => {
      const removed = await tx.emailDraft.deleteMany({
        where: { projectId, id, userId: actor.userId, revision },
      });
      if (removed.count !== 1) throw new ConflictException('email_draft_changed');
      await tx.emailAssetReference.deleteMany({
        where: { projectId, ownerId: id, ownerType: 'EMAIL_DRAFT' },
      });
    });
    return { deleted: true };
  }

  async attachment(projectId: string, id: string, actor: AuthenticatedUser) {
    const attachment = await this.database.client.emailAttachment.findFirst({
      where: { projectId, id },
      include: { message: { select: { mailboxId: true } } },
    });
    if (!attachment) throw new NotFoundException('email_attachment_not_found');
    await this.assertMailbox(projectId, attachment.message.mailboxId, actor);
    if (attachment.status !== 'AVAILABLE' || !attachment.bucketKey)
      throw new ConflictException('email_attachment_unavailable');
    return this.storedAttachment(attachment.bucketKey, attachment.filename);
  }

  async outgoingAttachment(
    projectId: string,
    messageId: string,
    assetId: string,
    actor: AuthenticatedUser,
  ) {
    const message = await this.database.client.emailMessage.findFirst({
      where: { projectId, id: messageId },
      include: { delivery: { select: { attachmentAssetIds: true } } },
    });
    if (!message) throw new NotFoundException('email_message_not_found');
    await this.assertMailbox(projectId, message.mailboxId, actor);
    if (
      !Array.isArray(message.delivery?.attachmentAssetIds) ||
      !message.delivery.attachmentAssetIds.includes(assetId)
    )
      throw new NotFoundException('email_attachment_not_found');
    const asset = await this.database.client.mediaAsset.findFirst({
      where: { projectId, id: assetId, status: 'AVAILABLE' },
    });
    if (!asset?.bucketKey) throw new ConflictException('email_attachment_unavailable');
    return this.storedAttachment(asset.bucketKey, asset.originalFilename ?? 'attachment');
  }

  private async storedAttachment(bucketKey: string, filename: string) {
    if (!this.config.get('MEDIA_STORAGE_ENABLED', { infer: true }))
      throw new ServiceUnavailableException('email_storage_unavailable');
    const storage = new S3MediaStorage({
      accessKeyId: this.config.get('MEDIA_BUCKET_ACCESS_KEY_ID', { infer: true })!,
      secretAccessKey: this.config.get('MEDIA_BUCKET_SECRET_ACCESS_KEY', { infer: true })!,
      bucket: this.config.get('MEDIA_BUCKET', { infer: true })!,
      endpoint: this.config.get('MEDIA_BUCKET_ENDPOINT', { infer: true })!,
      region: this.config.get('MEDIA_BUCKET_REGION', { infer: true }),
      forcePathStyle: this.config.get('MEDIA_BUCKET_FORCE_PATH_STYLE', { infer: true }),
    });
    const object = await storage.getObject(bucketKey);
    return { bytes: Buffer.from(object.bytes), filename: safeMailFilename(filename) };
  }

  private record(action: string, projectId: string, entityId: string, actor: InboxActor) {
    return this.audit.record({
      action,
      projectId,
      entityId,
      entityType: 'EmailInbox',
      ...(isCrmActor(actor)
        ? {
            actorType: 'CRM',
            afterSafeJson: { crmUserId: actor.userId, crmLeadId: actor.crmLeadId },
          }
        : { actorUserId: actor.userId }),
      correlationId: 'email-inbox',
    });
  }

  async health(projectId: string) {
    const [receipts, failedReceipts, failedAutomations] = await Promise.all([
      this.database.client.emailInboundReceipt.groupBy({
        by: ['status'],
        where: { projectId },
        _count: true,
      }),
      this.database.client.emailInboundReceipt.findMany({
        where: { projectId, status: 'FAILED' },
        select: {
          id: true,
          lastError: true,
          updatedAt: true,
          mailbox: { select: { address: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      }),
      this.database.client.emailMessage.findMany({
        where: { projectId, automationStatus: 'FAILED' },
        select: { id: true, threadId: true, automationError: true },
        take: 20,
      }),
    ]);
    return {
      counts: Object.fromEntries(receipts.map((row) => [row.status, row._count])),
      failedReceipts,
      failedAutomations,
    };
  }

  async retryReceipt(projectId: string, id: string, actor: AuthenticatedUser) {
    const row = await this.database.client.emailInboundReceipt.findFirst({
      where: { projectId, id },
    });
    if (!row) throw new NotFoundException('email_receipt_not_found');
    await this.assertMailbox(projectId, row.mailboxId, actor);
    const updated = await this.database.client.emailInboundReceipt.updateMany({
      where: { projectId, id, status: 'FAILED' },
      data: { status: 'RETRY', attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    if (!updated.count) throw new ConflictException('email_receipt_state_changed');
    await this.record('email.receipt_retried', projectId, id, actor);
    return { queued: true };
  }

  async retryAutomation(projectId: string, id: string, actor: AuthenticatedUser) {
    const message = await this.database.client.emailMessage.findFirst({ where: { projectId, id } });
    if (!message) throw new NotFoundException('email_message_not_found');
    await this.assertMailbox(projectId, message.mailboxId, actor);
    const updated = await this.database.client.emailMessage.updateMany({
      where: { projectId, id, automationStatus: 'FAILED' },
      data: { automationStatus: 'PENDING', automationError: null },
    });
    if (!updated.count) throw new ConflictException('email_message_state_changed');
    await this.record('email.automation_retried', projectId, id, actor);
    return { queued: true };
  }
}
