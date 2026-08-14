import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiEnvironment } from '@omnicus/config/server';
import {
  emailAssetReferences,
  emailDocumentSchema,
  type EmailDocument,
} from '@omnicus/email-core';
import { Prisma, type EmailCampaignStatus } from '@omnicus/database';

import { AuditService } from '../audit/audit.service';
import type { RequestSecurityContext } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import type {
  CreateEmailCampaignDto,
  CreateEmailSuppressionDto,
  CreateEmailTemplateDto,
  TestEmailDto,
  UpdateEmailCampaignDto,
  UpdateEmailTemplateDraftDto,
} from './dto';

type Audience = {
  mode: 'ALL_ACTIVE' | 'SEGMENT' | 'CONTACTS';
  segmentId?: string;
  contactIds?: string[];
  includeTagIds?: string[];
  excludeTagIds?: string[];
};

type JsonRecord = Record<string, Prisma.JsonValue>;

function jsonRecord(value: Prisma.JsonValue | undefined): JsonRecord | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
  return value as JsonRecord;
}

function jsonText(value: Prisma.JsonValue | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

@Injectable()
export class EmailService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService<ApiEnvironment, true>,
  ) {}

  async listCampaigns(projectId: string) {
    const campaigns = await this.database.client.emailCampaign.findMany({
      orderBy: { updatedAt: 'desc' },
      where: { projectId },
    });
    return Promise.all(campaigns.map((campaign) => this.campaignView(campaign)));
  }

  async createCampaign(
    projectId: string,
    input: CreateEmailCampaignDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const design = this.design(input.design);
    const audience = this.audience(input.audience);
    const references = await this.assertAssets(projectId, design);
    try {
      const campaign = await this.database.client.emailCampaign.create({
        data: {
          audience: this.json(audience),
          createdById: actor.userId,
          design: this.json(design),
          name: input.name.trim(),
          preheader: input.preheader?.trim() || null,
          projectId,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          sourceTemplateVersionId: input.sourceTemplateVersionId ?? null,
          subject: input.subject.trim(),
        },
      });
      await this.syncAssetReferences(projectId, 'EMAIL_CAMPAIGN', campaign.id, references);
      await this.recordAudit(
        'email.campaign_created',
        projectId,
        campaign.id,
        'EmailCampaign',
        actor,
        context,
        { name: campaign.name, status: campaign.status },
      );
      return this.campaignView(campaign);
    } catch (error) {
      this.rethrowNameConflict(error, 'EMAIL_CAMPAIGN_NAME_EXISTS');
    }
  }

  async getCampaign(projectId: string, campaignId: string) {
    return this.campaignView(await this.campaign(projectId, campaignId));
  }

  async updateCampaign(
    projectId: string,
    campaignId: string,
    input: UpdateEmailCampaignDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const current = await this.campaign(projectId, campaignId);
    if (current.status !== 'DRAFT')
      throw new ConflictException({
        code: 'EMAIL_CAMPAIGN_NOT_EDITABLE',
        message: 'Only a draft email campaign can be edited',
      });
    const design = input.design
      ? this.design(input.design)
      : this.design(current.design);
    const audience = input.audience
      ? this.audience(input.audience)
      : this.audience(current.audience);
    const references = await this.assertAssets(projectId, design);
    try {
      const campaign = await this.database.client.emailCampaign.update({
        data: {
          audience: this.json(audience),
          design: this.json(design),
          ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(input.preheader === undefined
            ? {}
            : { preheader: input.preheader?.trim() || null }),
          ...(input.scheduledAt === undefined
            ? {}
            : { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null }),
          ...(input.sourceTemplateVersionId === undefined
            ? {}
            : { sourceTemplateVersionId: input.sourceTemplateVersionId }),
          ...(input.subject === undefined ? {} : { subject: input.subject.trim() }),
        },
        where: { projectId_id: { id: campaignId, projectId } },
      });
      await this.syncAssetReferences(projectId, 'EMAIL_CAMPAIGN', campaign.id, references);
      await this.recordAudit(
        'email.campaign_updated',
        projectId,
        campaign.id,
        'EmailCampaign',
        actor,
        context,
      );
      return this.campaignView(campaign);
    } catch (error) {
      this.rethrowNameConflict(error, 'EMAIL_CAMPAIGN_NAME_EXISTS');
    }
  }

  async deleteCampaign(
    projectId: string,
    campaignId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const campaign = await this.campaign(projectId, campaignId);
    if (campaign.status !== 'DRAFT')
      throw new ConflictException({
        code: 'EMAIL_CAMPAIGN_NOT_DELETABLE',
        message: 'Only a draft email campaign can be deleted',
      });
    await this.database.client.$transaction(async (transaction) => {
      await transaction.emailAssetReference.deleteMany({
        where: { ownerId: campaignId, ownerType: 'EMAIL_CAMPAIGN', projectId },
      });
      await transaction.emailCampaign.delete({
        where: { projectId_id: { id: campaignId, projectId } },
      });
    });
    await this.recordAudit(
      'email.campaign_deleted',
      projectId,
      campaignId,
      'EmailCampaign',
      actor,
      context,
      { name: campaign.name, status: campaign.status },
    );
    return { deleted: true };
  }

  async estimateCampaign(projectId: string, campaignId: string) {
    const campaign = await this.campaign(projectId, campaignId);
    return this.estimateAudience(projectId, this.audience(campaign.audience));
  }

  async launchCampaign(
    projectId: string,
    campaignId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const campaign = await this.campaign(projectId, campaignId);
    if (!['DRAFT', 'FAILED'].includes(campaign.status))
      throw new ConflictException({
        code: 'EMAIL_CAMPAIGN_CANNOT_LAUNCH',
        message: 'This email campaign cannot be launched',
      });
    if (!campaign.subject.trim())
      throw new BadRequestException({
        code: 'EMAIL_CAMPAIGN_SUBJECT_REQUIRED',
        message: 'Email subject is required',
      });
    await this.assertAssets(projectId, this.design(campaign.design));
    this.audience(campaign.audience);
    const scheduled = Boolean(campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now());
    const updated = await this.database.client.emailCampaign.update({
      data: {
        completedAt: null,
        errorCode: null,
        failedAt: null,
        status: scheduled ? 'SCHEDULED' : 'PREPARING',
        ...(!scheduled ? { scheduledAt: null, startedAt: new Date() } : {}),
      },
      where: { projectId_id: { id: campaignId, projectId } },
    });
    await this.recordAudit(
      scheduled ? 'email.campaign_scheduled' : 'email.campaign_launched',
      projectId,
      campaignId,
      'EmailCampaign',
      actor,
      context,
    );
    return this.campaignView(updated);
  }

  async pauseCampaign(
    projectId: string,
    campaignId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    return this.transition(
      projectId,
      campaignId,
      ['RUNNING'],
      'PAUSED',
      'email.campaign_paused',
      actor,
      context,
    );
  }

  async resumeCampaign(
    projectId: string,
    campaignId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    return this.transition(
      projectId,
      campaignId,
      ['PAUSED'],
      'RUNNING',
      'email.campaign_resumed',
      actor,
      context,
    );
  }

  async cancelCampaign(
    projectId: string,
    campaignId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const campaign = await this.campaign(projectId, campaignId);
    if (!['DRAFT', 'SCHEDULED', 'PREPARING', 'RUNNING', 'PAUSED'].includes(campaign.status))
      throw new ConflictException({
        code: 'EMAIL_CAMPAIGN_CANNOT_CANCEL',
        message: 'This email campaign cannot be cancelled',
      });
    const now = new Date();
    await this.database.client.$transaction([
      this.database.client.emailDelivery.updateMany({
        data: { completedAt: now, status: 'CANCELLED' },
        where: { campaignId, projectId, status: { in: ['PENDING', 'RETRY'] } },
      }),
      this.database.client.emailCampaign.update({
        data: { cancelledAt: now, status: 'CANCELLED' },
        where: { projectId_id: { id: campaignId, projectId } },
      }),
    ]);
    await this.recordAudit(
      'email.campaign_cancelled',
      projectId,
      campaignId,
      'EmailCampaign',
      actor,
      context,
    );
    return this.getCampaign(projectId, campaignId);
  }

  async retryFailed(
    projectId: string,
    campaignId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    await this.campaign(projectId, campaignId);
    const retried = await this.database.client.emailDelivery.updateMany({
      data: {
        attempts: 0,
        completedAt: null,
        failedAt: null,
        lastError: null,
        nextAttemptAt: new Date(),
        status: 'PENDING',
      },
      where: {
        campaignId,
        projectId,
        status: { in: ['FAILED', 'BOUNCED', 'SUPPRESSED'] },
      },
    });
    if (!retried.count)
      throw new ConflictException({
        code: 'EMAIL_CAMPAIGN_NO_FAILED_RECIPIENTS',
        message: 'There are no failed email recipients to retry',
      });
    await this.database.client.emailCampaign.update({
      data: { completedAt: null, errorCode: null, failedAt: null, status: 'RUNNING' },
      where: { projectId_id: { id: campaignId, projectId } },
    });
    await this.recordAudit(
      'email.campaign_failed_retried',
      projectId,
      campaignId,
      'EmailCampaign',
      actor,
      context,
      { recipients: retried.count },
    );
    return this.getCampaign(projectId, campaignId);
  }

  async listDeliveries(projectId: string, campaignId: string) {
    await this.campaign(projectId, campaignId);
    return this.database.client.emailDelivery.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
      where: { campaignId, projectId },
    });
  }

  async listAnalytics(projectId: string, requestedPage: string, requestedPageSize: string) {
    const parsedPage = Number.parseInt(requestedPage, 10);
    const parsedPageSize = Number.parseInt(requestedPageSize, 10);
    const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
    const pageSize = Number.isFinite(parsedPageSize)
      ? Math.min(100, Math.max(10, parsedPageSize))
      : 25;
    const where = { projectId };
    const [events, total] = await this.database.client.$transaction([
      this.database.client.emailEvent.findMany({
        include: {
          delivery: {
            select: {
              campaign: { select: { id: true, name: true } },
              contact: { select: { displayName: true, id: true } },
              id: true,
              source: true,
              subject: true,
              toEmail: true,
            },
          },
        },
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where,
      }),
      this.database.client.emailEvent.count({ where }),
    ]);

    return {
      items: events.map((event) => {
        const payload = jsonRecord(event.providerPayload);
        const data = jsonRecord(payload?.data);
        const click = jsonRecord(data?.click);
        const client = click ?? data;
        return {
          campaignId: event.delivery.campaign?.id ?? null,
          campaignName: event.delivery.campaign?.name ?? null,
          contactId: event.delivery.contact?.id ?? null,
          contactName: event.delivery.contact?.displayName ?? null,
          deliveryId: event.delivery.id,
          email: event.delivery.toEmail,
          id: event.id,
          ipAddress:
            jsonText(client?.ipAddress) ??
            jsonText(client?.ip_address) ??
            null,
          occurredAt: event.occurredAt,
          source: event.delivery.source,
          subject: event.delivery.subject,
          targetUrl: event.targetUrl,
          type: event.type,
          userAgent:
            jsonText(client?.userAgent) ??
            jsonText(client?.user_agent) ??
            null,
        };
      }),
      page,
      pageSize,
      total,
    };
  }

  async getDelivery(projectId: string, deliveryId: string) {
    const delivery = await this.database.client.emailDelivery.findUnique({
      include: { events: { orderBy: { occurredAt: 'desc' } } },
      where: { projectId_id: { id: deliveryId, projectId } },
    });
    if (!delivery)
      throw new NotFoundException({
        code: 'EMAIL_DELIVERY_NOT_FOUND',
        message: 'Email delivery was not found',
      });
    return delivery;
  }

  async testSend(
    projectId: string,
    input: TestEmailDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const design = this.design(input.design);
    const references = await this.assertAssets(projectId, design);
    const email = this.normalizeEmail(input.to);
    const delivery = await this.database.client.emailDelivery.create({
      data: {
        attachmentAssetIds: this.json(references.map((reference) => reference.assetId)),
        designSnapshot: this.json(design),
        normalizedEmail: email,
        preheader: input.preheader?.trim() || null,
        projectId,
        source: 'TEST',
        subject: input.subject.trim() || 'Omnicus email preview',
        toEmail: email,
      },
    });
    await this.syncAssetReferences(projectId, 'EMAIL_DELIVERY', delivery.id, references);
    await this.recordAudit(
      'email.test_queued',
      projectId,
      delivery.id,
      'EmailDelivery',
      actor,
      context,
      { recipientDomain: email.split('@')[1] ?? 'unknown' },
    );
    return delivery;
  }

  async listTemplates(projectId: string) {
    const templates = await this.database.client.emailTemplate.findMany({
      include: { versions: { orderBy: { version: 'desc' } } },
      orderBy: { updatedAt: 'desc' },
      where: { projectId, status: { not: 'ARCHIVED' } },
    });
    return templates.map((template) => this.templateView(template));
  }

  async createTemplate(
    projectId: string,
    input: CreateEmailTemplateDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const design = this.design(input.design);
    const references = await this.assertAssets(projectId, design);
    try {
      const result = await this.database.client.$transaction(async (transaction) => {
        const template = await transaction.emailTemplate.create({
          data: {
            createdById: actor.userId,
            description: input.description?.trim() || null,
            name: input.name.trim(),
            projectId,
          },
        });
        const version = await transaction.emailTemplateVersion.create({
          data: {
            contentHash: this.contentHash(input.subject, input.preheader, design),
            createdById: actor.userId,
            design: this.json(design),
            preheader: input.preheader?.trim() || null,
            projectId,
            subject: input.subject.trim(),
            templateId: template.id,
            version: 1,
          },
        });
        await transaction.emailTemplate.update({
          data: { draftVersionId: version.id },
          where: { projectId_id: { id: template.id, projectId } },
        });
        return { template, version };
      });
      await this.syncAssetReferences(
        projectId,
        'EMAIL_TEMPLATE_VERSION',
        result.version.id,
        references,
      );
      await this.recordAudit(
        'email.template_created',
        projectId,
        result.template.id,
        'EmailTemplate',
        actor,
        context,
      );
      return this.template(projectId, result.template.id);
    } catch (error) {
      this.rethrowNameConflict(error, 'EMAIL_TEMPLATE_NAME_EXISTS');
    }
  }

  async updateTemplateDraft(
    projectId: string,
    templateId: string,
    input: UpdateEmailTemplateDraftDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const template = await this.templateRecord(projectId, templateId);
    if (template.status === 'ARCHIVED')
      throw new ConflictException({
        code: 'EMAIL_TEMPLATE_ARCHIVED',
        message: 'Archived email templates cannot be edited',
      });
    const design = this.design(input.design);
    const references = await this.assertAssets(projectId, design);
    try {
      const version = await this.database.client.$transaction(async (transaction) => {
        await transaction.emailTemplate.update({
          data: {
            ...(input.description === undefined
              ? {}
              : { description: input.description?.trim() || null }),
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
          },
          where: { projectId_id: { id: templateId, projectId } },
        });
        if (template.draftVersionId)
          return transaction.emailTemplateVersion.update({
            data: {
              contentHash: this.contentHash(input.subject, input.preheader ?? undefined, design),
              design: this.json(design),
              preheader: input.preheader?.trim() || null,
              subject: input.subject.trim(),
            },
            where: { projectId_id: { id: template.draftVersionId, projectId } },
          });
        const latest = await transaction.emailTemplateVersion.aggregate({
          _max: { version: true },
          where: { projectId, templateId },
        });
        const draft = await transaction.emailTemplateVersion.create({
          data: {
            contentHash: this.contentHash(input.subject, input.preheader ?? undefined, design),
            createdById: actor.userId,
            design: this.json(design),
            preheader: input.preheader?.trim() || null,
            projectId,
            subject: input.subject.trim(),
            templateId,
            version: (latest._max.version ?? 0) + 1,
          },
        });
        await transaction.emailTemplate.update({
          data: { draftVersionId: draft.id },
          where: { projectId_id: { id: templateId, projectId } },
        });
        return draft;
      });
      await this.syncAssetReferences(
        projectId,
        'EMAIL_TEMPLATE_VERSION',
        version.id,
        references,
      );
      await this.recordAudit(
        'email.template_draft_saved',
        projectId,
        templateId,
        'EmailTemplate',
        actor,
        context,
      );
      return this.template(projectId, templateId);
    } catch (error) {
      this.rethrowNameConflict(error, 'EMAIL_TEMPLATE_NAME_EXISTS');
    }
  }

  async publishTemplate(
    projectId: string,
    templateId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const template = await this.templateRecord(projectId, templateId);
    if (!template.draftVersionId)
      throw new ConflictException({
        code: 'EMAIL_TEMPLATE_DRAFT_REQUIRED',
        message: 'Save a template draft before publishing',
      });
    const draft = await this.database.client.emailTemplateVersion.findUnique({
      where: { projectId_id: { id: template.draftVersionId, projectId } },
    });
    if (!draft)
      throw new NotFoundException({
        code: 'EMAIL_TEMPLATE_VERSION_NOT_FOUND',
        message: 'Email template draft was not found',
      });
    await this.assertAssets(projectId, this.design(draft.design));
    await this.database.client.$transaction(async (transaction) => {
      if (template.activeVersionId)
        await transaction.emailTemplateVersion.updateMany({
          data: { status: 'SUPERSEDED' },
          where: { id: template.activeVersionId, projectId, status: 'PUBLISHED' },
        });
      await transaction.emailTemplateVersion.update({
        data: { publishedAt: new Date(), status: 'PUBLISHED' },
        where: { projectId_id: { id: draft.id, projectId } },
      });
      await transaction.emailTemplate.update({
        data: { activeVersionId: draft.id, draftVersionId: null, status: 'PUBLISHED' },
        where: { projectId_id: { id: templateId, projectId } },
      });
    });
    await this.recordAudit(
      'email.template_published',
      projectId,
      templateId,
      'EmailTemplate',
      actor,
      context,
      { version: draft.version },
    );
    return this.template(projectId, templateId);
  }

  async duplicateTemplate(
    projectId: string,
    templateId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const source = await this.template(projectId, templateId);
    const version = source.activeVersion ?? source.draftVersion;
    if (!version)
      throw new ConflictException({
        code: 'EMAIL_TEMPLATE_VERSION_NOT_FOUND',
        message: 'Email template content was not found',
      });
    return this.createTemplate(
      projectId,
      {
        design: version.design as Record<string, unknown>,
        ...(source.description === null ? {} : { description: source.description }),
        name: await this.availableTemplateName(projectId, source.name + ' copy'),
        ...(version.preheader === null ? {} : { preheader: version.preheader }),
        subject: version.subject,
      },
      actor,
      context,
    );
  }

  async archiveTemplate(
    projectId: string,
    templateId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    await this.templateRecord(projectId, templateId);
    await this.database.client.emailTemplate.update({
      data: { status: 'ARCHIVED' },
      where: { projectId_id: { id: templateId, projectId } },
    });
    await this.recordAudit(
      'email.template_archived',
      projectId,
      templateId,
      'EmailTemplate',
      actor,
      context,
    );
    return { archived: true };
  }

  async audienceOptions(projectId: string) {
    const [contacts, segments, tags, suppressions] = await Promise.all([
      this.database.client.contact.findMany({
        orderBy: { displayName: 'asc' },
        select: {
          displayName: true,
          email: true,
          id: true,
          normalizedEmail: true,
        },
        take: 2_000,
        where: { email: { not: null }, projectId, status: 'ACTIVE' },
      }),
      this.database.client.segment.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
        where: { archivedAt: null, projectId, status: 'ACTIVE' },
      }),
      this.database.client.tag.findMany({
        orderBy: { name: 'asc' },
        select: { color: true, id: true, name: true },
        where: { archivedAt: null, projectId },
      }),
      this.database.client.emailSuppression.findMany({
        select: { normalizedEmail: true },
        where: { projectId },
      }),
    ]);
    const suppressed = new Set(suppressions.map((item) => item.normalizedEmail));
    return {
      contacts: contacts.map((contact) => ({
        ...contact,
        eligible:
          Boolean(contact.normalizedEmail) && !suppressed.has(contact.normalizedEmail ?? ''),
      })),
      segments,
      tags,
    };
  }

  async listSuppressions(projectId: string) {
    return this.database.client.emailSuppression.findMany({
      orderBy: { createdAt: 'desc' },
      where: { projectId },
    });
  }

  async addSuppression(
    projectId: string,
    input: CreateEmailSuppressionDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const normalizedEmail = this.normalizeEmail(input.email);
    const suppression = await this.database.client.$transaction(async (transaction) => {
      const saved = await transaction.emailSuppression.upsert({
        create: {
          detail: input.detail?.trim() || null,
          normalizedEmail,
          projectId,
          reason: input.reason ?? 'MANUAL',
          source: 'project_user',
        },
        update: {
          detail: input.detail?.trim() || null,
          reason: input.reason ?? 'MANUAL',
          source: 'project_user',
        },
        where: { projectId_normalizedEmail: { normalizedEmail, projectId } },
      });
      await transaction.emailDelivery.updateMany({
        data: { completedAt: new Date(), lastError: 'email_suppressed', status: 'SUPPRESSED' },
        where: { normalizedEmail, projectId, status: { in: ['PENDING', 'RETRY'] } },
      });
      return saved;
    });
    await this.recordAudit(
      'email.suppression_added',
      projectId,
      suppression.id,
      'EmailSuppression',
      actor,
      context,
      { reason: suppression.reason },
    );
    return suppression;
  }

  async removeSuppression(
    projectId: string,
    suppressionId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const removed = await this.database.client.emailSuppression.deleteMany({
      where: { id: suppressionId, projectId },
    });
    if (!removed.count)
      throw new NotFoundException({
        code: 'EMAIL_SUPPRESSION_NOT_FOUND',
        message: 'Email suppression was not found',
      });
    await this.recordAudit(
      'email.suppression_removed',
      projectId,
      suppressionId,
      'EmailSuppression',
      actor,
      context,
    );
    return { removed: true };
  }

  async unsubscribeView(token: string) {
    const delivery = await this.database.client.emailDelivery.findUnique({
      select: { source: true, toEmail: true },
      where: { unsubscribeToken: token },
    });
    if (!delivery || delivery.source === 'TEST')
      throw new NotFoundException('unsubscribe_link_not_found');
    return { html: this.unsubscribeHtml(token, this.maskEmail(delivery.toEmail), false) };
  }

  async unsubscribe(token: string) {
    const delivery = await this.database.client.emailDelivery.findUnique({
      where: { unsubscribeToken: token },
    });
    if (!delivery || delivery.source === 'TEST')
      throw new NotFoundException('unsubscribe_link_not_found');
    const now = new Date();
    await this.database.client.$transaction(async (transaction) => {
      await transaction.emailSuppression.upsert({
        create: {
          normalizedEmail: delivery.normalizedEmail,
          projectId: delivery.projectId,
          reason: 'UNSUBSCRIBED',
          source: 'email_unsubscribe',
        },
        update: { reason: 'UNSUBSCRIBED', source: 'email_unsubscribe' },
        where: {
          projectId_normalizedEmail: {
            normalizedEmail: delivery.normalizedEmail,
            projectId: delivery.projectId,
          },
        },
      });
      await transaction.contact.updateMany({
        data: {
          emailConsentSource: 'email_unsubscribe',
          emailConsentStatus: 'REVOKED',
          emailOptOutAt: now,
        },
        where: { normalizedEmail: delivery.normalizedEmail, projectId: delivery.projectId },
      });
      await transaction.emailDelivery.updateMany({
        data: { completedAt: now, lastError: 'email_unsubscribed', status: 'SUPPRESSED' },
        where: {
          normalizedEmail: delivery.normalizedEmail,
          projectId: delivery.projectId,
          status: { in: ['PENDING', 'RETRY'] },
        },
      });
      const event = await transaction.emailEvent.upsert({
        create: {
          deliveryId: delivery.id,
          occurredAt: now,
          projectId: delivery.projectId,
          providerEventId: 'unsubscribe:' + delivery.id,
          providerPayload: { source: 'one_click' },
          type: 'UNSUBSCRIBED',
        },
        update: {},
        where: { providerEventId: 'unsubscribe:' + delivery.id },
      });
      await this.queueCrmEvent(transaction, delivery, {
        eventId: event.id,
        eventType: 'UNSUBSCRIBED',
        occurredAt: now.toISOString(),
      });
    });
    return { html: this.unsubscribeHtml(token, this.maskEmail(delivery.toEmail), true) };
  }

  private async campaignView<T extends { id: string; projectId: string }>(campaign: T) {
    const groups = await this.database.client.emailDelivery.groupBy({
      _count: { _all: true },
      by: ['status'],
      where: { campaignId: campaign.id, projectId: campaign.projectId },
    });
    const metrics = Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
    return {
      ...campaign,
      metrics,
      totalRecipients: groups.reduce((sum, group) => sum + group._count._all, 0),
    };
  }

  private async transition(
    projectId: string,
    campaignId: string,
    from: EmailCampaignStatus[],
    to: EmailCampaignStatus,
    action: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const updated = await this.database.client.emailCampaign.updateMany({
      data: { status: to },
      where: { id: campaignId, projectId, status: { in: from } },
    });
    if (!updated.count)
      throw new ConflictException({
        code: 'EMAIL_CAMPAIGN_STATE_CHANGED',
        message: 'Email campaign state changed',
      });
    await this.recordAudit(action, projectId, campaignId, 'EmailCampaign', actor, context);
    return this.getCampaign(projectId, campaignId);
  }

  private async campaign(projectId: string, campaignId: string) {
    const campaign = await this.database.client.emailCampaign.findUnique({
      where: { projectId_id: { id: campaignId, projectId } },
    });
    if (!campaign)
      throw new NotFoundException({
        code: 'EMAIL_CAMPAIGN_NOT_FOUND',
        message: 'Email campaign was not found',
      });
    return campaign;
  }

  private async template(projectId: string, templateId: string) {
    const template = await this.database.client.emailTemplate.findUnique({
      include: { versions: { orderBy: { version: 'desc' } } },
      where: { projectId_id: { id: templateId, projectId } },
    });
    if (!template)
      throw new NotFoundException({
        code: 'EMAIL_TEMPLATE_NOT_FOUND',
        message: 'Email template was not found',
      });
    return this.templateView(template);
  }

  private templateView<T extends {
    activeVersionId: string | null;
    draftVersionId: string | null;
    versions: Array<{
      design: Prisma.JsonValue;
      id: string;
      preheader: string | null;
      subject: string;
    }>;
  }>(template: T) {
    return {
      ...template,
      activeVersion:
        template.versions.find((version) => version.id === template.activeVersionId) ?? null,
      draftVersion:
        template.versions.find((version) => version.id === template.draftVersionId) ?? null,
    };
  }

  private async templateRecord(projectId: string, templateId: string) {
    const template = await this.database.client.emailTemplate.findUnique({
      where: { projectId_id: { id: templateId, projectId } },
    });
    if (!template)
      throw new NotFoundException({
        code: 'EMAIL_TEMPLATE_NOT_FOUND',
        message: 'Email template was not found',
      });
    return template;
  }

  private async estimateAudience(projectId: string, audience: Audience) {
    const candidates = await this.audienceContacts(projectId, audience);
    const suppressions = await this.database.client.emailSuppression.findMany({
      select: { normalizedEmail: true },
      where: { projectId },
    });
    const suppressed = new Set(suppressions.map((item) => item.normalizedEmail));
    const seen = new Set<string>();
    let eligibleRecipients = 0;
    let excludedSuppressed = 0;
    let duplicateAddresses = 0;
    for (const contact of candidates) {
      if (!contact.normalizedEmail || !contact.email) continue;
      if (seen.has(contact.normalizedEmail)) {
        duplicateAddresses += 1;
        continue;
      }
      seen.add(contact.normalizedEmail);
      if (suppressed.has(contact.normalizedEmail)) excludedSuppressed += 1;
      else eligibleRecipients += 1;
    }
    return {
      duplicateAddresses,
      eligibleRecipients,
      excludedSuppressed,
      totalMatched: candidates.length,
    };
  }

  private async audienceContacts(projectId: string, audience: Audience) {
    this.assertAudience(audience);
    const where: Prisma.ContactWhereInput = {
      email: { not: null },
      normalizedEmail: { not: null },
      projectId,
      status: 'ACTIVE',
    };
    if (audience.mode === 'CONTACTS') where.id = { in: audience.contactIds ?? [] };
    if (audience.mode === 'SEGMENT') {
      const segment = await this.database.client.segment.findFirst({
        where: {
          archivedAt: null,
          id: audience.segmentId ?? '__missing__',
          projectId,
          status: 'ACTIVE',
        },
      });
      if (!segment)
        throw new NotFoundException({ code: 'SEGMENT_NOT_FOUND', message: 'Segment was not found' });
      Object.assign(where, await this.segmentWhere(projectId, segment.filter));
      where.projectId = projectId;
      where.email = { not: null };
      where.normalizedEmail = { not: null };
    }
    const clauses: Prisma.ContactWhereInput[] = [];
    for (const tagId of audience.includeTagIds ?? [])
      clauses.push({ tags: { some: { projectId, tagId } } });
    if (audience.excludeTagIds?.length)
      clauses.push({ tags: { none: { projectId, tagId: { in: audience.excludeTagIds } } } });
    if (clauses.length) where.AND = clauses;
    return this.database.client.contact.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        displayName: true,
        email: true,
        id: true,
        normalizedEmail: true,
      },
      where,
    });
  }

  private async segmentWhere(projectId: string, value: Prisma.JsonValue) {
    const filter =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, Prisma.JsonValue>)
        : {};
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
      const customValue = filter.customFieldValue;
      where.customFieldValues = {
        some: {
          definitionId: definition.id,
          projectId,
          ...(typeof customValue === 'number'
            ? { valueNumber: customValue }
            : typeof customValue === 'boolean'
              ? { valueBoolean: customValue }
              : { valueText: String(customValue) }),
        },
      };
    }
    return where;
  }

  private audience(value: unknown): Audience {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException({ code: 'EMAIL_AUDIENCE_INVALID', message: 'Email audience is invalid' });
    const audience = value as Audience;
    this.assertAudience(audience);
    return {
      mode: audience.mode,
      ...(audience.segmentId ? { segmentId: audience.segmentId } : {}),
      ...(audience.contactIds ? { contactIds: [...new Set(audience.contactIds)] } : {}),
      ...(audience.includeTagIds
        ? { includeTagIds: [...new Set(audience.includeTagIds)] }
        : {}),
      ...(audience.excludeTagIds
        ? { excludeTagIds: [...new Set(audience.excludeTagIds)] }
        : {}),
    };
  }

  private assertAudience(audience: Audience): void {
    if (!['ALL_ACTIVE', 'SEGMENT', 'CONTACTS'].includes(audience.mode))
      throw new BadRequestException({ code: 'EMAIL_AUDIENCE_INVALID', message: 'Email audience mode is invalid' });
    if (audience.mode === 'SEGMENT' && !audience.segmentId)
      throw new BadRequestException({ code: 'EMAIL_AUDIENCE_SEGMENT_REQUIRED', message: 'Choose a saved segment' });
    if (audience.mode === 'CONTACTS' && !audience.contactIds?.length)
      throw new BadRequestException({ code: 'EMAIL_AUDIENCE_CONTACTS_REQUIRED', message: 'Choose at least one contact' });
  }

  private design(value: unknown): EmailDocument {
    const parsed = emailDocumentSchema.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'EMAIL_DESIGN_INVALID',
        details: parsed.error.flatten(),
        message: 'Email design is invalid',
      });
    return parsed.data;
  }

  private async assertAssets(projectId: string, design: EmailDocument) {
    const references = emailAssetReferences(design);
    if (!references.length) return references;
    const assets = await this.database.client.mediaAsset.findMany({
      where: {
        id: { in: references.map((reference) => reference.assetId) },
        projectId,
        status: 'AVAILABLE',
      },
    });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    let rawBytes = 0n;
    for (const reference of references) {
      const asset = byId.get(reference.assetId);
      const metadata =
        asset?.providerMetadata &&
        typeof asset.providerMetadata === 'object' &&
        !Array.isArray(asset.providerMetadata)
          ? (asset.providerMetadata as Record<string, unknown>)
          : {};
      if (
        !asset ||
        metadata.validationChannel !== 'email' ||
        (reference.usage === 'INLINE' && asset.kind !== 'PHOTO') ||
        (reference.usage === 'ATTACHMENT' && asset.kind !== 'DOCUMENT')
      )
        throw new BadRequestException({
          code: 'EMAIL_ASSET_INVALID',
          message: 'Email contains an unavailable or incompatible file',
        });
      rawBytes += asset.sizeBytes ?? 0n;
    }
    if (rawBytes > 29n * 1024n * 1024n)
      throw new BadRequestException({
        code: 'EMAIL_ATTACHMENTS_TOO_LARGE',
        message: 'Email attachments exceed the safe 40 MB encoded limit',
      });
    return references;
  }

  private async syncAssetReferences(
    projectId: string,
    ownerType: string,
    ownerId: string,
    references: Array<{ assetId: string; usage: string }>,
  ) {
    await this.database.client.$transaction(async (transaction) => {
      await transaction.emailAssetReference.deleteMany({ where: { ownerId, ownerType, projectId } });
      if (references.length)
        await transaction.emailAssetReference.createMany({
          data: references.map((reference) => ({
            mediaAssetId: reference.assetId,
            ownerId,
            ownerType,
            projectId,
            usage: reference.usage,
          })),
          skipDuplicates: true,
        });
    });
  }

  private async availableTemplateName(projectId: string, base: string) {
    for (let index = 0; index < 100; index += 1) {
      const candidate = index ? base + ' ' + (index + 1) : base;
      const exists = await this.database.client.emailTemplate.findFirst({
        select: { id: true },
        where: { name: candidate, projectId },
      });
      if (!exists) return candidate;
    }
    return base + ' ' + Date.now();
  }

  private contentHash(subject: string, preheader: string | undefined, design: EmailDocument) {
    return createHash('sha256')
      .update(JSON.stringify({ design, preheader: preheader ?? null, subject }))
      .digest('hex');
  }

  private normalizeEmail(value: string) {
    return value.trim().toLowerCase();
  }

  private maskEmail(value: string) {
    const [local, domain] = value.split('@');
    return (local?.slice(0, 2) ?? '**') + '***@' + (domain ?? 'email');
  }

  private unsubscribeHtml(token: string, email: string, completed: boolean) {
    const apiUrl = this.config.get('API_PUBLIC_URL', { infer: true }).replace(/\/$/, '');
    const action = apiUrl + '/api/v1/public/email/unsubscribe/' + encodeURIComponent(token);
    const title = completed ? 'You are unsubscribed' : 'Email preferences';
    const copy = completed
      ? 'We will no longer send marketing email to ' + email + '.'
      : 'Stop marketing email to ' + email + '. Transactional messages required to operate your account are unaffected.';
    const form = completed
      ? ''
      : '<form method="post" action="' + action + '"><button style="width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#0f766e;color:#fff;font-size:15px;font-weight:700;cursor:pointer">Unsubscribe</button></form>';
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Omnicus email preferences</title></head><body style="margin:0;background:#edf3f2;font-family:Arial,sans-serif;color:#172033"><main style="width:min(520px,calc(100% - 32px));margin:12vh auto;background:#fff;border-radius:22px;padding:36px;box-shadow:0 22px 60px rgba(15,23,42,.12)"><div style="width:44px;height:5px;border-radius:99px;background:#0f766e;margin-bottom:26px"></div><h1 style="margin:0 0 12px;font-size:28px">' + title + '</h1><p style="color:#607080;line-height:1.6">' + copy + '</p>' + form + '</main></body></html>';
  }

  async queueCrmEvent(
    transaction: Prisma.TransactionClient,
    delivery: {
      campaignId: string | null;
      contactId: string | null;
      id: string;
      nodeId: string | null;
      projectId: string;
      providerEmailId: string | null;
      scenarioExecutionId: string | null;
      source: string;
      subject: string;
      toEmail: string;
    },
    event: { eventId: string; eventType: string; occurredAt: string; targetUrl?: string },
  ) {
    if (!delivery.contactId) return;
    const crm = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId: delivery.projectId },
    });
    if (!crm?.enabled || crm.status !== 'ACTIVE') return;
    const idempotencyKey = 'email-event:' + event.eventId;
    if (
      await transaction.outboxRecord.findUnique({
        where: {
          projectId_idempotencyKey: { idempotencyKey, projectId: delivery.projectId },
        },
      })
    )
      return;
    const outbox = await transaction.outboxRecord.create({
      data: {
        idempotencyKey,
        kind: 'CRM',
        maxAttempts: 12,
        nextAttemptAt: new Date(),
        payload: { deliveryId: delivery.id, eventId: event.eventId, type: 'email.event' },
        projectId: delivery.projectId,
      },
    });
    await transaction.crmOperation.create({
      data: {
        contactId: delivery.contactId,
        inputSafe: this.json({
          campaignId: delivery.campaignId,
          deliveryId: delivery.id,
          eventId: event.eventId,
          eventType: event.eventType,
          nodeId: delivery.nodeId,
          occurredAt: event.occurredAt,
          providerEmailId: delivery.providerEmailId,
          scenarioExecutionId: delivery.scenarioExecutionId,
          source: delivery.source,
          subject: delivery.subject,
          targetUrl: event.targetUrl,
          toEmail: delivery.toEmail,
        }),
        outboxRecordId: outbox.id,
        projectId: delivery.projectId,
        type: 'FORWARD_EMAIL_EVENT',
      },
    });
  }

  private async recordAudit(
    action: string,
    projectId: string,
    entityId: string,
    entityType: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
    afterSafeJson?: Prisma.InputJsonValue,
  ) {
    await this.audit.record({
      action,
      actorUserId: actor.userId,
      ...(afterSafeJson === undefined ? {} : { afterSafeJson }),
      correlationId: context.correlationId,
      entityId,
      entityType,
      projectId,
    });
  }

  private json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private rethrowNameConflict(error: unknown, code: string): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new ConflictException({ code, message: 'This name is already in use' });
    throw error;
  }
}
