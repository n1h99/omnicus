import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type CustomFieldType } from '@omnicus/database';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import type { RequestSecurityContext } from '../auth/auth.service';
import type {
  AddTagDto,
  BulkTagsDto,
  ContactsQueryDto,
  CreateContactDto,
  CreateCustomFieldDto,
  CreateSegmentDto,
  CreateTagDto,
  MergeContactsDto,
  UpdateContactDto,
  UpdateCustomFieldDto,
  UpdateSegmentDto,
  UpdateTagDto,
} from './dto';

const contactSelect = {
  automationMode: true,
  createdAt: true,
  crmContactId: true,
  crmLeadId: true,
  crmManagerId: true,
  customFields: true,
  displayName: true,
  email: true,
  firstName: true,
  id: true,
  lastInteractionAt: true,
  lastName: true,
  phone: true,
  projectId: true,
  status: true,
  updatedAt: true,
  username: true,
  whatsAppConsentAt: true,
  whatsAppConsentSource: true,
  whatsAppConsentStatus: true,
  whatsAppOptOutAt: true,
} as const;

@Injectable()
export class ContactsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async list(projectId: string, query: ContactsQueryDto) {
    const where: Prisma.ContactWhereInput = {
      projectId,
      ...(query.status ? { status: query.status } : { status: { not: 'MERGED' } }),
      ...(query.channel
        ? { channelIdentities: { some: { channel: query.channel as never } } }
        : {}),
      ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
      ...(query.hasCrmLeadId === 'true' ? { crmLeadId: { not: null } } : {}),
      ...(query.hasCrmLeadId === 'false' ? { crmLeadId: null } : {}),
      ...(query.search
        ? {
            OR: [
              { displayName: { contains: query.search, mode: 'insensitive' } },
              { username: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    if (query.segmentId) {
      const segment = await this.database.client.segment.findFirst({
        where: { archivedAt: null, id: query.segmentId, projectId, status: 'ACTIVE' },
      });
      if (!segment)
        throw new NotFoundException({
          code: 'SEGMENT_NOT_FOUND',
          message: 'Segment was not found',
        });
      Object.assign(where, await this.whereForSegment(projectId, segment.filter));
    }
    const [items, total] = await this.database.client.$transaction([
      this.database.client.contact.findMany({
        include: {
          channelIdentities: { select: { channel: true } },
          tags: { include: { tag: true } },
        },
        orderBy: { [query.sortBy]: query.sortDirection },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        where,
      }),
      this.database.client.contact.count({ where }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async create(
    projectId: string,
    input: CreateContactDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    const email = input.email?.trim().toLowerCase() || null;
    const phone = input.phone?.trim() || null;
    const normalizedPhone = phone ? phone.replace(/\D/g, '') : null;
    const identityPredicates: Prisma.ContactWhereInput[] = [
      ...(email ? [{ normalizedEmail: email }] : []),
      ...(normalizedPhone ? [{ normalizedPhone }] : []),
    ];
    if (identityPredicates.length) {
      const existing = await this.database.client.contact.findFirst({
        select: { id: true },
        where: { OR: identityPredicates, projectId, status: { not: 'MERGED' } },
      });
      if (existing)
        throw new ConflictException({
          code: 'CONTACT_IDENTITY_EXISTS',
          message: 'A contact with this email or phone already exists',
        });
    }
    const contact = await this.database.client.$transaction(async (transaction) => {
      const created = await transaction.contact.create({
        data: {
          displayName: input.displayName.trim(),
          email,
          firstName: input.firstName?.trim() || null,
          lastName: input.lastName?.trim() || null,
          normalizedEmail: email,
          normalizedPhone,
          phone,
          projectId,
          username: input.username?.trim() || null,
        },
        select: contactSelect,
      });
      await this.queueCrmContactSync(
        transaction,
        projectId,
        created.id,
        created.updatedAt,
        context.correlationId,
        'contact_manual_create',
      );
      return created;
    });
    await this.audit.record({
      action: 'contact.created',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      afterSafeJson: { source: 'manual', status: contact.status },
      correlationId: context.correlationId,
      entityId: contact.id,
      entityType: 'Contact',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return contact;
  }

  async get(projectId: string, contactId: string) {
    const contact = await this.database.client.contact.findUnique({
      include: {
        channelIdentities: true,
        tags: { include: { tag: true } },
      },
      where: { projectId_id: { id: contactId, projectId } },
    });
    if (!contact)
      throw new NotFoundException({ code: 'CONTACT_NOT_FOUND', message: 'Contact was not found' });
    return contact;
  }

  async update(
    projectId: string,
    contactId: string,
    input: UpdateContactDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    const before = await this.get(projectId, contactId);
    if (input.customFields) await this.assertCustomFields(projectId, input.customFields);
    if (before.status === 'MERGED')
      throw new ConflictException({
        code: 'CONTACT_MERGED',
        message: 'Merged contacts are read-only',
      });
    const nextCustomFields =
      input.customFields === undefined
        ? undefined
        : { ...this.jsonObject(before.customFields), ...input.customFields };
    const contact = await this.database.client.$transaction(async (transaction) => {
      const updated = await transaction.contact.update({
        data: {
          ...(input.automationMode === undefined ? {} : { automationMode: input.automationMode }),
          ...(nextCustomFields === undefined
            ? {}
            : { customFields: nextCustomFields as Prisma.InputJsonValue }),
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.email === undefined
            ? {}
            : {
                email: input.email,
                normalizedEmail: input.email?.trim().toLowerCase() || null,
              }),
          ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
          ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
          ...(input.phone === undefined
            ? {}
            : {
                normalizedPhone: input.phone?.trim() ? input.phone.replace(/\D/g, '') : null,
                phone: input.phone,
              }),
          ...(input.status === undefined
            ? {}
            : {
                archivedAt: input.status === 'ARCHIVED' ? new Date() : null,
                status: input.status,
              }),
          ...(input.whatsAppConsentStatus === undefined
            ? {}
            : input.whatsAppConsentStatus === 'GRANTED'
              ? {
                  whatsAppConsentAt: new Date(),
                  whatsAppConsentSource: 'manual_contact_update',
                  whatsAppConsentStatus: 'GRANTED',
                  whatsAppOptOutAt: null,
                }
              : input.whatsAppConsentStatus === 'REVOKED'
                ? {
                    whatsAppConsentSource: 'manual_contact_update',
                    whatsAppConsentStatus: 'REVOKED',
                    whatsAppOptOutAt: new Date(),
                  }
                : {
                    whatsAppConsentAt: null,
                    whatsAppConsentSource: null,
                    whatsAppConsentStatus: 'UNKNOWN',
                    whatsAppOptOutAt: null,
                  }),
          ...(input.username === undefined ? {} : { username: input.username }),
        },
        select: contactSelect,
        where: { projectId_id: { id: contactId, projectId } },
      });
      if (input.customFields)
        await this.syncCustomFieldValues(transaction, projectId, contactId, input.customFields);
      await this.queueCrmContactSync(
        transaction,
        projectId,
        contactId,
        updated.updatedAt,
        context.correlationId,
        'contact_manual_update',
      );
      return updated;
    });
    await this.audit.record({
      action:
        input.automationMode !== undefined
          ? 'contact.automation_mode_changed'
          : input.status !== undefined
            ? 'contact.status_changed'
            : input.customFields !== undefined
              ? 'custom_field.value_changed'
              : 'contact.updated',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      afterSafeJson: { automationMode: contact.automationMode, status: contact.status },
      beforeSafeJson: { automationMode: before.automationMode, status: before.status },
      correlationId: context.correlationId,
      entityId: contactId,
      entityType: 'Contact',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return contact;
  }

  async timeline(projectId: string, contactId: string) {
    const contact = await this.get(projectId, contactId);
    const [audit, clicks, emailClicks] = await Promise.all([
      this.database.client.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        where: { entityId: contactId, entityType: 'Contact', projectId },
      }),
      this.database.client.trackedLinkClick.findMany({
        orderBy: { occurredAt: 'desc' },
        select: {
          id: true,
          isLikelyBot: true,
          occurredAt: true,
          trackedLinkId: true,
        },
        take: 100,
        where: { contactId, projectId },
      }),
      this.database.client.emailEvent.findMany({
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          delivery: {
            select: {
              campaign: { select: { id: true, name: true } },
              nodeId: true,
              scenarioExecutionId: true,
              source: true,
            },
          },
          id: true,
          occurredAt: true,
          providerPayload: true,
          targetUrl: true,
        },
        take: 100,
        where: {
          delivery: { contactId, projectId },
          projectId,
          targetUrl: { not: null },
          type: 'CLICKED',
        },
      }),
    ]);
    const trackedLinkIds = [...new Set(clicks.map((click) => click.trackedLinkId))];
    const links = trackedLinkIds.length
      ? await this.database.client.trackedLink.findMany({
          select: {
            id: true,
            nodeId: true,
            scenarioExecutionId: true,
            targetUrl: true,
          },
          where: { id: { in: trackedLinkIds }, projectId },
        })
      : [];
    const executionIds = [
      ...new Set([
        ...links.map((link) => link.scenarioExecutionId),
        ...emailClicks.flatMap((click) =>
          click.delivery.scenarioExecutionId ? [click.delivery.scenarioExecutionId] : [],
        ),
      ]),
    ];
    const executions = executionIds.length
      ? await this.database.client.scenarioExecution.findMany({
          select: {
            id: true,
            scenario: { select: { id: true, name: true } },
            triggerType: true,
          },
          where: { id: { in: executionIds }, projectId },
        })
      : [];
    const linksById = new Map(links.map((link) => [link.id, link]));
    const executionsById = new Map(executions.map((execution) => [execution.id, execution]));
    const automationLinkClicks = clicks.flatMap((click) => {
      const link = linksById.get(click.trackedLinkId);
      if (!link) return [];
      const execution = executionsById.get(link.scenarioExecutionId);
      return [
        {
          id: click.id,
          isLikelyBot: click.isLikelyBot,
          nodeId: link.nodeId,
          occurredAt: click.occurredAt,
          scenario: execution?.scenario ?? null,
          scenarioExecutionId: link.scenarioExecutionId,
          targetUrl: link.targetUrl,
          trackedLinkId: link.id,
          triggerType: execution?.triggerType ?? null,
        },
      ];
    });
    const emailLinkClicks = emailClicks.flatMap((click) => {
      if (!click.targetUrl) return [];
      const scenarioExecutionId = click.delivery.scenarioExecutionId ?? '';
      const execution = scenarioExecutionId ? executionsById.get(scenarioExecutionId) : undefined;
      return [
        {
          id: `email-event:${click.id}`,
          isLikelyBot: this.emailClickIsLikelyBot(click.providerPayload),
          nodeId: click.delivery.nodeId ?? '',
          occurredAt: click.occurredAt,
          scenario: execution?.scenario ?? click.delivery.campaign ?? null,
          scenarioExecutionId,
          targetUrl: click.targetUrl,
          trackedLinkId: `email-event:${click.id}`,
          triggerType: execution?.triggerType ?? `EMAIL_${click.delivery.source}`,
        },
      ];
    });
    const trackedLinkClicks = [...automationLinkClicks, ...emailLinkClicks]
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
      .slice(0, 100);
    return { audit, createdAt: contact.createdAt, trackedLinkClicks };
  }

  async listTags(projectId: string) {
    return this.database.client.tag.findMany({
      orderBy: { name: 'asc' },
      where: { archivedAt: null, projectId },
    });
  }

  async createTag(
    projectId: string,
    input: CreateTagDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    const normalizedName = input.name.trim().toLocaleLowerCase('en-US');
    try {
      const tag = await this.database.client.tag.create({
        data: {
          color: input.color ?? null,
          description: input.description ?? null,
          name: input.name.trim(),
          normalizedName,
          projectId,
        },
      });
      await this.audit.record({
        action: 'tag.created',
        actorEmailSnapshot: context.actorEmail,
        actorUserId: context.actorUserId,
        afterSafeJson: { name: tag.name },
        correlationId: context.correlationId,
        entityId: tag.id,
        entityType: 'Tag',
        ip: context.ip,
        projectId,
        userAgent: context.userAgent,
      });
      return tag;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException({
          code: 'TAG_NAME_EXISTS',
          message: 'Tag name already exists',
        });
      throw error;
    }
  }

  async updateTag(
    projectId: string,
    tagId: string,
    input: UpdateTagDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    await this.assertTag(projectId, tagId);
    const tag = await this.database.client.tag.update({
      data: {
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.name === undefined
          ? {}
          : {
              name: input.name.trim(),
              normalizedName: input.name.trim().toLocaleLowerCase('en-US'),
            }),
      },
      where: { projectId_id: { id: tagId, projectId } },
    });
    await this.audit.record({
      action: 'tag.updated',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      correlationId: context.correlationId,
      entityId: tagId,
      entityType: 'Tag',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return tag;
  }

  async archiveTag(
    projectId: string,
    tagId: string,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    await this.assertTag(projectId, tagId);
    await this.database.client.tag.update({
      data: { archivedAt: new Date() },
      where: { projectId_id: { id: tagId, projectId } },
    });
    await this.audit.record({
      action: 'tag.deleted',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      correlationId: context.correlationId,
      entityId: tagId,
      entityType: 'Tag',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
  }

  async addTag(
    projectId: string,
    contactId: string,
    input: AddTagDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    await Promise.all([this.get(projectId, contactId), this.assertTag(projectId, input.tagId)]);
    const result = await this.database.client.contactTag.createMany({
      data: { contactId, projectId, source: 'MANUAL', tagId: input.tagId },
      skipDuplicates: true,
    });
    if (result.count)
      await this.audit.record({
        action: 'contact.tag_added',
        actorEmailSnapshot: context.actorEmail,
        actorUserId: context.actorUserId,
        correlationId: context.correlationId,
        entityId: contactId,
        entityType: 'Contact',
        ip: context.ip,
        projectId,
        userAgent: context.userAgent,
      });
  }

  async removeTag(
    projectId: string,
    contactId: string,
    tagId: string,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    const result = await this.database.client.contactTag.deleteMany({
      where: { contactId, projectId, tagId },
    });
    if (result.count)
      await this.audit.record({
        action: 'contact.tag_removed',
        actorEmailSnapshot: context.actorEmail,
        actorUserId: context.actorUserId,
        correlationId: context.correlationId,
        entityId: contactId,
        entityType: 'Contact',
        ip: context.ip,
        projectId,
        userAgent: context.userAgent,
      });
  }

  async bulkTags(
    projectId: string,
    input: BulkTagsDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    const [contacts, tags] = await Promise.all([
      this.database.client.contact.count({ where: { id: { in: input.contactIds }, projectId } }),
      this.database.client.tag.count({
        where: { archivedAt: null, id: { in: input.tagIds }, projectId },
      }),
    ]);
    if (contacts !== new Set(input.contactIds).size || tags !== new Set(input.tagIds).size)
      throw new NotFoundException({
        code: 'PROJECT_RESOURCE_NOT_FOUND',
        message: 'Contact or tag was not found',
      });
    if (input.add)
      await this.database.client.contactTag.createMany({
        data: input.contactIds.flatMap((contactId) =>
          input.tagIds.map((tagId) => ({ contactId, projectId, source: 'MANUAL_BULK', tagId })),
        ),
        skipDuplicates: true,
      });
    else
      await this.database.client.contactTag.deleteMany({
        where: { contactId: { in: input.contactIds }, projectId, tagId: { in: input.tagIds } },
      });
    await this.audit.record({
      action: 'contact.bulk_tags',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      afterSafeJson: {
        add: input.add,
        contactCount: input.contactIds.length,
        tagCount: input.tagIds.length,
      },
      correlationId: context.correlationId,
      entityType: 'Contact',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
  }

  async listCustomFields(projectId: string, archived = false) {
    return this.database.client.customFieldDefinition.findMany({
      orderBy: { name: 'asc' },
      where: { archivedAt: archived ? { not: null } : null, projectId },
    });
  }

  async createCustomField(
    projectId: string,
    input: CreateCustomFieldDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    this.assertOptions(input.type as CustomFieldType, input.options);
    try {
      const field = await this.database.client.customFieldDefinition.create({
        data: {
          description: input.description ?? null,
          key: input.key,
          name: input.name,
          ...(input.options === undefined
            ? {}
            : { options: input.options as Prisma.InputJsonValue }),
          projectId,
          type: input.type as CustomFieldType,
        },
      });
      await this.audit.record({
        action: 'custom_field.created',
        actorEmailSnapshot: context.actorEmail,
        actorUserId: context.actorUserId,
        correlationId: context.correlationId,
        entityId: field.id,
        entityType: 'CustomFieldDefinition',
        ip: context.ip,
        projectId,
        userAgent: context.userAgent,
      });
      return field;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException({
          code: 'CUSTOM_FIELD_KEY_EXISTS',
          message: 'Custom field key already exists',
        });
      throw error;
    }
  }

  async updateCustomField(
    projectId: string,
    fieldId: string,
    input: UpdateCustomFieldDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    const before = await this.assertCustomField(projectId, fieldId);
    this.assertOptions(
      before.type,
      input.options ?? (before.options as string[] | null | undefined),
    );
    const field = await this.database.client.customFieldDefinition.update({
      data: {
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.options === undefined ? {} : { options: input.options as Prisma.InputJsonValue }),
      },
      where: { projectId_id: { id: fieldId, projectId } },
    });
    await this.audit.record({
      action: 'custom_field.updated',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      correlationId: context.correlationId,
      entityId: fieldId,
      entityType: 'CustomFieldDefinition',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return field;
  }

  async archiveCustomField(
    projectId: string,
    fieldId: string,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    await this.assertCustomField(projectId, fieldId);
    await this.database.client.customFieldDefinition.update({
      data: { archivedAt: new Date() },
      where: { projectId_id: { id: fieldId, projectId } },
    });
    await this.audit.record({
      action: 'custom_field.deleted',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      correlationId: context.correlationId,
      entityId: fieldId,
      entityType: 'CustomFieldDefinition',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
  }

  async restoreCustomField(
    projectId: string,
    fieldId: string,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    const field = await this.database.client.customFieldDefinition.findUnique({
      where: { projectId_id: { id: fieldId, projectId } },
    });
    if (!field || !field.archivedAt)
      throw new NotFoundException({
        code: 'ARCHIVED_CUSTOM_FIELD_NOT_FOUND',
        message: 'Archived custom field was not found',
      });
    const restored = await this.database.client.customFieldDefinition.update({
      data: { archivedAt: null },
      where: { projectId_id: { id: fieldId, projectId } },
    });
    await this.audit.record({
      action: 'custom_field.restored',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      correlationId: context.correlationId,
      entityId: fieldId,
      entityType: 'CustomFieldDefinition',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return restored;
  }

  async listSegments(projectId: string) {
    return this.database.client.segment.findMany({
      orderBy: { name: 'asc' },
      where: { archivedAt: null, projectId, status: 'ACTIVE' },
    });
  }

  async createSegment(
    projectId: string,
    input: CreateSegmentDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    const filter = await this.validateSegmentFilter(projectId, input.filter);
    try {
      const segment = await this.database.client.segment.create({
        data: { createdById: context.actorUserId, filter, name: input.name.trim(), projectId },
      });
      await this.audit.record({
        action: 'segment.created',
        actorEmailSnapshot: context.actorEmail,
        actorUserId: context.actorUserId,
        afterSafeJson: { name: segment.name },
        correlationId: context.correlationId,
        entityId: segment.id,
        entityType: 'Segment',
        ip: context.ip,
        projectId,
        userAgent: context.userAgent,
      });
      return segment;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException({
          code: 'SEGMENT_NAME_EXISTS',
          message: 'Segment name already exists',
        });
      throw error;
    }
  }

  async updateSegment(
    projectId: string,
    segmentId: string,
    input: UpdateSegmentDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    await this.assertSegment(projectId, segmentId);
    const filter =
      input.filter === undefined
        ? undefined
        : await this.validateSegmentFilter(projectId, input.filter);
    const segment = await this.database.client.segment.update({
      data: {
        ...(filter === undefined ? {} : { filter }),
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
      },
      where: { projectId_id: { id: segmentId, projectId } },
    });
    await this.audit.record({
      action: 'segment.updated',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      correlationId: context.correlationId,
      entityId: segmentId,
      entityType: 'Segment',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return segment;
  }

  async archiveSegment(
    projectId: string,
    segmentId: string,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    await this.assertSegment(projectId, segmentId);
    await this.database.client.segment.update({
      data: { archivedAt: new Date(), status: 'ARCHIVED' },
      where: { projectId_id: { id: segmentId, projectId } },
    });
    await this.audit.record({
      action: 'segment.archived',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      correlationId: context.correlationId,
      entityId: segmentId,
      entityType: 'Segment',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
  }

  async merge(
    projectId: string,
    input: MergeContactsDto,
    context: RequestSecurityContext & { actorUserId: string; actorEmail: string },
  ) {
    if (input.primaryContactId === input.secondaryContactId)
      throw new ConflictException({
        code: 'CONTACT_MERGE_IDENTICAL',
        message: 'Contacts must be different',
      });
    const merged = await this.database.client.$transaction(async (transaction) => {
      const contacts = await transaction.contact.findMany({
        include: { channelIdentities: true, tags: true },
        where: { id: { in: [input.primaryContactId, input.secondaryContactId] }, projectId },
      });
      const primary = contacts.find((contact) => contact.id === input.primaryContactId);
      const secondary = contacts.find((contact) => contact.id === input.secondaryContactId);
      if (!primary || !secondary || primary.status === 'MERGED' || secondary.status === 'MERGED')
        throw new NotFoundException({
          code: 'CONTACT_NOT_FOUND',
          message: 'Active contact was not found',
        });
      const primaryIdentityByKey = new Map(
        primary.channelIdentities.map((identity) => [
          `${identity.connectionId}:${identity.externalUserId}`,
          identity,
        ]),
      );
      const duplicateIdentities = secondary.channelIdentities.flatMap((identity) => {
        const survivor = primaryIdentityByKey.get(
          `${identity.connectionId}:${identity.externalUserId}`,
        );
        return survivor ? [{ duplicate: identity, survivor }] : [];
      });
      for (const { duplicate, survivor } of duplicateIdentities)
        await Promise.all([
          transaction.channelIdentity.update({
            data: {
              whatsAppLastErrorCode:
                survivor.whatsAppReachability === 'AVAILABLE'
                  ? null
                  : (survivor.whatsAppLastErrorCode ?? duplicate.whatsAppLastErrorCode),
              whatsAppReachability:
                survivor.whatsAppReachability === 'AVAILABLE' ||
                duplicate.whatsAppReachability === 'AVAILABLE'
                  ? 'AVAILABLE'
                  : (survivor.whatsAppReachability ?? duplicate.whatsAppReachability),
              whatsAppReachabilityCheckedAt:
                survivor.whatsAppReachabilityCheckedAt && duplicate.whatsAppReachabilityCheckedAt
                  ? new Date(
                      Math.max(
                        survivor.whatsAppReachabilityCheckedAt.getTime(),
                        duplicate.whatsAppReachabilityCheckedAt.getTime(),
                      ),
                    )
                  : (survivor.whatsAppReachabilityCheckedAt ??
                    duplicate.whatsAppReachabilityCheckedAt),
            },
            where: { projectId_id: { id: survivor.id, projectId } },
          }),
          transaction.broadcastRecipient.updateMany({
            data: { channelIdentityId: survivor.id, contactId: primary.id },
            where: { channelIdentityId: duplicate.id, projectId },
          }),
          transaction.scheduledMessage.updateMany({
            data: { channelIdentityId: survivor.id, contactId: primary.id },
            where: { channelIdentityId: duplicate.id, projectId },
          }),
          transaction.telegramMediaGroup.updateMany({
            data: { channelIdentityId: survivor.id, contactId: primary.id },
            where: { channelIdentityId: duplicate.id, projectId },
          }),
        ]);
      const duplicateIdentityIds = duplicateIdentities.map(({ duplicate }) => duplicate.id);
      if (duplicateIdentityIds.length)
        await transaction.channelIdentity.deleteMany({
          where: { id: { in: duplicateIdentityIds }, projectId },
        });
      await transaction.channelIdentity.updateMany({
        where: { contactId: secondary.id, projectId },
        data: { contactId: primary.id },
      });
      await transaction.contactTag.createMany({
        data: secondary.tags.map((tag) => ({
          contactId: primary.id,
          projectId,
          source: 'MERGE',
          tagId: tag.tagId,
        })),
        skipDuplicates: true,
      });
      await transaction.contactTag.deleteMany({ where: { contactId: secondary.id, projectId } });
      await Promise.all([
        transaction.conversation.updateMany({
          where: { contactId: secondary.id, projectId },
          data: { contactId: primary.id },
        }),
        transaction.message.updateMany({
          where: { contactId: secondary.id, projectId },
          data: { contactId: primary.id },
        }),
        transaction.scenarioExecution.updateMany({
          where: { contactId: secondary.id, projectId },
          data: { contactId: primary.id },
        }),
        transaction.crmOperation.updateMany({
          where: { contactId: secondary.id, projectId },
          data: { contactId: primary.id },
        }),
        transaction.broadcastRecipient.updateMany({
          where: { contactId: secondary.id, projectId },
          data: { contactId: primary.id },
        }),
        transaction.scheduledMessage.updateMany({
          where: { contactId: secondary.id, projectId },
          data: { contactId: primary.id },
        }),
        transaction.telegramMediaGroup.updateMany({
          where: { contactId: secondary.id, projectId },
          data: { contactId: primary.id },
        }),
      ]);
      const mergedFields = {
        ...this.jsonObject(secondary.customFields),
        ...this.jsonObject(primary.customFields),
      };
      const whatsAppConsentStatus =
        primary.whatsAppConsentStatus === 'REVOKED' || secondary.whatsAppConsentStatus === 'REVOKED'
          ? 'REVOKED'
          : primary.whatsAppConsentStatus === 'GRANTED' ||
              secondary.whatsAppConsentStatus === 'GRANTED'
            ? 'GRANTED'
            : 'UNKNOWN';
      const consentSourceContact =
        primary.whatsAppConsentStatus === whatsAppConsentStatus ? primary : secondary;
      await transaction.contact.update({
        data: {
          crmContactId: primary.crmContactId ?? secondary.crmContactId,
          crmLeadId: primary.crmLeadId ?? secondary.crmLeadId,
          crmManagerId: primary.crmManagerId ?? secondary.crmManagerId,
          customFields: mergedFields as Prisma.InputJsonValue,
          displayName: primary.displayName ?? secondary.displayName,
          email: primary.email ?? secondary.email,
          firstInteractionAt:
            primary.firstInteractionAt && secondary.firstInteractionAt
              ? new Date(
                  Math.min(
                    primary.firstInteractionAt.getTime(),
                    secondary.firstInteractionAt.getTime(),
                  ),
                )
              : (primary.firstInteractionAt ?? secondary.firstInteractionAt),
          firstName: primary.firstName ?? secondary.firstName,
          lastInteractionAt:
            primary.lastInteractionAt && secondary.lastInteractionAt
              ? new Date(
                  Math.max(
                    primary.lastInteractionAt.getTime(),
                    secondary.lastInteractionAt.getTime(),
                  ),
                )
              : (primary.lastInteractionAt ?? secondary.lastInteractionAt),
          lastName: primary.lastName ?? secondary.lastName,
          phone: primary.phone ?? secondary.phone,
          username: primary.username ?? secondary.username,
          whatsAppConsentAt:
            whatsAppConsentStatus === 'GRANTED'
              ? (consentSourceContact.whatsAppConsentAt ??
                primary.whatsAppConsentAt ??
                secondary.whatsAppConsentAt)
              : null,
          whatsAppConsentSource:
            whatsAppConsentStatus === 'UNKNOWN'
              ? null
              : (consentSourceContact.whatsAppConsentSource ?? 'contact_merge'),
          whatsAppConsentStatus,
          whatsAppOptOutAt:
            whatsAppConsentStatus === 'REVOKED'
              ? (consentSourceContact.whatsAppOptOutAt ??
                primary.whatsAppOptOutAt ??
                secondary.whatsAppOptOutAt ??
                new Date())
              : null,
        },
        where: { projectId_id: { id: primary.id, projectId } },
      });
      await this.syncCustomFieldValues(transaction, projectId, primary.id, mergedFields);
      await transaction.contact.update({
        data: { archivedAt: new Date(), mergedIntoContactId: primary.id, status: 'MERGED' },
        where: { projectId_id: { id: secondary.id, projectId } },
      });
      let crmOperationId: string | null = null;
      const crmConfig = await transaction.crmProjectConfig.findUnique({
        select: { enabled: true },
        where: { projectId },
      });
      if (crmConfig?.enabled) {
        const identity = primary.channelIdentities[0] ?? secondary.channelIdentities[0];
        const outbox = await transaction.outboxRecord.create({
          data: {
            idempotencyKey: `crm-contact-merge-${primary.id}-${secondary.id}`,
            kind: 'CRM',
            nextAttemptAt: new Date(),
            payload: {
              operationType: 'MERGE_CONTACTS',
              primaryContactId: primary.id,
              secondaryContactId: secondary.id,
            },
            projectId,
          },
        });
        const operation = await transaction.crmOperation.create({
          data: {
            contactId: primary.id,
            inputSafe: {
              ...(identity ? { connectionId: identity.connectionId } : {}),
              correlationId: context.correlationId,
              primaryContactId: primary.id,
              ...(primary.crmLeadId ? { primaryCrmLeadId: primary.crmLeadId } : {}),
              secondaryContactId: secondary.id,
              ...(secondary.crmLeadId ? { secondaryCrmLeadId: secondary.crmLeadId } : {}),
            },
            outboxRecordId: outbox.id,
            projectId,
            type: 'MERGE_CONTACTS',
          },
        });
        crmOperationId = operation.id;
      }
      return {
        crmOperationId,
        primaryContactId: primary.id,
        secondaryContactId: secondary.id,
      };
    });
    await this.audit.record({
      action: 'contact.merged',
      actorEmailSnapshot: context.actorEmail,
      actorUserId: context.actorUserId,
      afterSafeJson: merged,
      correlationId: context.correlationId,
      entityId: merged.primaryContactId,
      entityType: 'Contact',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
    return merged;
  }

  private async queueCrmContactSync(
    transaction: Prisma.TransactionClient,
    projectId: string,
    contactId: string,
    updatedAt: Date,
    correlationId: string,
    source: 'contact_manual_create' | 'contact_manual_update',
  ): Promise<void> {
    const crmConfig = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId },
    });
    if (!crmConfig?.enabled || crmConfig.status !== 'ACTIVE') return;
    const outbox = await transaction.outboxRecord.create({
      data: {
        idempotencyKey: `crm-contact-sync-${contactId}-${updatedAt.toISOString()}`,
        kind: 'CRM',
        nextAttemptAt: new Date(),
        payload: { contactId, operationType: 'CREATE_OR_UPDATE_LEAD' },
        projectId,
      },
    });
    await transaction.crmOperation.create({
      data: {
        contactId,
        inputSafe: { correlationId, source },
        outboxRecordId: outbox.id,
        projectId,
        type: 'CREATE_OR_UPDATE_LEAD',
      },
    });
  }

  private async assertSegment(projectId: string, segmentId: string) {
    const segment = await this.database.client.segment.findUnique({
      where: { projectId_id: { id: segmentId, projectId } },
    });
    if (!segment || segment.archivedAt || segment.status !== 'ACTIVE')
      throw new NotFoundException({ code: 'SEGMENT_NOT_FOUND', message: 'Segment was not found' });
    return segment;
  }

  private async validateSegmentFilter(projectId: string, input: Record<string, unknown>) {
    const allowed = new Set([
      'channel',
      'customFieldKey',
      'customFieldValue',
      'hasCrmLeadId',
      'status',
      'tagId',
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw new ConflictException({
        code: 'SEGMENT_FILTER_INVALID',
        message: 'Segment filter contains an unsupported predicate',
      });
    if (
      input.status !== undefined &&
      !['ACTIVE', 'BLOCKED', 'UNSUBSCRIBED', 'ARCHIVED'].includes(String(input.status))
    )
      throw new ConflictException({
        code: 'SEGMENT_FILTER_INVALID',
        message: 'Segment status is invalid',
      });
    if (input.hasCrmLeadId !== undefined && typeof input.hasCrmLeadId !== 'boolean')
      throw new ConflictException({
        code: 'SEGMENT_FILTER_INVALID',
        message: 'CRM lead predicate must be boolean',
      });
    if (input.customFieldKey !== undefined) {
      if (typeof input.customFieldKey !== 'string')
        throw new ConflictException({
          code: 'SEGMENT_FILTER_INVALID',
          message: 'Custom field key is invalid',
        });
      const definition = await this.database.client.customFieldDefinition.findFirst({
        where: { archivedAt: null, key: input.customFieldKey, projectId },
      });
      if (!definition)
        throw new NotFoundException({
          code: 'CUSTOM_FIELD_NOT_FOUND',
          message: 'Custom field was not found',
        });
      if (input.customFieldValue === undefined)
        throw new ConflictException({
          code: 'SEGMENT_FILTER_INVALID',
          message: 'Custom field value is required',
        });
      if (!this.isFieldValueValid(definition.type, input.customFieldValue, definition.options))
        throw new ConflictException({
          code: 'SEGMENT_FILTER_INVALID',
          message: 'Custom field value is invalid',
        });
    } else if (input.customFieldValue !== undefined) {
      throw new ConflictException({
        code: 'SEGMENT_FILTER_INVALID',
        message: 'Custom field key is required',
      });
    }
    return input as Prisma.InputJsonValue;
  }

  private async whereForSegment(
    projectId: string,
    filterValue: Prisma.JsonValue,
  ): Promise<Prisma.ContactWhereInput> {
    const filter = this.jsonObject(filterValue);
    const where: Prisma.ContactWhereInput = {
      ...(typeof filter.status === 'string' ? { status: filter.status as never } : {}),
      ...(typeof filter.channel === 'string'
        ? { channelIdentities: { some: { channel: filter.channel as never } } }
        : {}),
      ...(typeof filter.tagId === 'string' ? { tags: { some: { tagId: filter.tagId } } } : {}),
      ...(typeof filter.hasCrmLeadId === 'boolean'
        ? { crmLeadId: filter.hasCrmLeadId ? { not: null } : null }
        : {}),
    };
    if (typeof filter.customFieldKey === 'string') {
      const definition = await this.database.client.customFieldDefinition.findFirst({
        where: { archivedAt: null, key: filter.customFieldKey, projectId },
      });
      if (!definition) return { id: '__missing_segment_definition__' };
      const value = filter.customFieldValue;
      const projection =
        typeof value === 'number'
          ? { valueNumber: value }
          : typeof value === 'boolean'
            ? { valueBoolean: value }
            : { valueText: String(value) };
      where.customFieldValues = { some: { definitionId: definition.id, projectId, ...projection } };
    }
    return where;
  }

  private jsonObject(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, Prisma.JsonValue>)
      : {};
  }

  private emailClickIsLikelyBot(providerPayload: Prisma.JsonValue): boolean {
    const data = this.jsonObject(this.jsonObject(providerPayload).data ?? null);
    const click = this.jsonObject(data.click ?? null);
    const rawUserAgent = click.userAgent ?? click.user_agent;
    const userAgent = typeof rawUserAgent === 'string' ? rawUserAgent : undefined;
    return (
      !userAgent ||
      /bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegrambot|slackbot|discordbot/i.test(
        userAgent,
      )
    );
  }

  private async assertTag(projectId: string, tagId: string) {
    const tag = await this.database.client.tag.findUnique({
      where: { projectId_id: { id: tagId, projectId } },
    });
    if (!tag || tag.archivedAt)
      throw new NotFoundException({ code: 'TAG_NOT_FOUND', message: 'Tag was not found' });
    return tag;
  }
  private async assertCustomField(projectId: string, fieldId: string) {
    const field = await this.database.client.customFieldDefinition.findUnique({
      where: { projectId_id: { id: fieldId, projectId } },
    });
    if (!field || field.archivedAt)
      throw new NotFoundException({
        code: 'CUSTOM_FIELD_NOT_FOUND',
        message: 'Custom field was not found',
      });
    return field;
  }
  private assertOptions(type: CustomFieldType, options: string[] | null | undefined) {
    const required = type === 'SELECT' || type === 'MULTI_SELECT';
    if (required && (!options || !options.length || new Set(options).size !== options.length))
      throw new ConflictException({
        code: 'CUSTOM_FIELD_OPTIONS_REQUIRED',
        message: 'Select fields require unique options',
      });
    if (!required && options?.length)
      throw new ConflictException({
        code: 'CUSTOM_FIELD_OPTIONS_NOT_ALLOWED',
        message: 'Options are only allowed for select fields',
      });
  }
  private async assertCustomFields(projectId: string, values: Record<string, unknown>) {
    const definitions = await this.database.client.customFieldDefinition.findMany({
      where: { archivedAt: null, key: { in: Object.keys(values) }, projectId },
    });
    if (definitions.length !== Object.keys(values).length)
      throw new ConflictException({
        code: 'CUSTOM_FIELD_UNKNOWN',
        message: 'Unknown custom field key',
      });
    for (const definition of definitions) {
      const value = values[definition.key];
      if (!this.isFieldValueValid(definition.type, value, definition.options))
        throw new ConflictException({
          code: 'CUSTOM_FIELD_VALUE_INVALID',
          message: `Invalid value for ${definition.key}`,
        });
    }
  }
  private async syncCustomFieldValues(
    transaction: Prisma.TransactionClient,
    projectId: string,
    contactId: string,
    values: Record<string, unknown>,
  ) {
    const definitions = await transaction.customFieldDefinition.findMany({
      where: { archivedAt: null, key: { in: Object.keys(values) }, projectId },
    });
    for (const definition of definitions) {
      const value = values[definition.key];
      const projections = this.customFieldProjections(definition.type, value);
      await transaction.contactCustomFieldValue.upsert({
        create: {
          contactId,
          definitionId: definition.id,
          projectId,
          valueJson: value as Prisma.InputJsonValue,
          ...projections,
        },
        update: { valueJson: value as Prisma.InputJsonValue, ...projections },
        where: {
          projectId_contactId_definitionId: { contactId, definitionId: definition.id, projectId },
        },
      });
    }
  }
  private customFieldProjections(type: CustomFieldType, value: unknown) {
    if (value === null)
      return { valueBoolean: null, valueDateTime: null, valueNumber: null, valueText: null };
    if (type === 'NUMBER')
      return {
        valueBoolean: null,
        valueDateTime: null,
        valueNumber: new Prisma.Decimal(value as number),
        valueText: null,
      };
    if (type === 'BOOLEAN')
      return {
        valueBoolean: value as boolean,
        valueDateTime: null,
        valueNumber: null,
        valueText: null,
      };
    return {
      valueBoolean: null,
      valueDateTime: null,
      valueNumber: null,
      valueText: typeof value === 'string' ? value : null,
    };
  }
  private isFieldValueValid(
    type: CustomFieldType,
    value: unknown,
    options: Prisma.JsonValue | null,
  ) {
    if (value === null) return true;
    if (type === 'TEXT') return typeof value === 'string';
    if (type === 'NUMBER') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'BOOLEAN') return typeof value === 'boolean';
    if (type === 'DATE') return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (type === 'DATETIME') return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    if (type === 'JSON') return typeof value === 'object';
    const allowed = Array.isArray(options) ? options : [];
    return type === 'SELECT'
      ? typeof value === 'string' && allowed.includes(value)
      : Array.isArray(value) &&
          value.every((entry) => typeof entry === 'string' && allowed.includes(entry));
  }
}
