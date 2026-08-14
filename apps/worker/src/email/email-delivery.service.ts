import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnvironment } from '@omnicus/config/server';
import {
  emailAssetReferences,
  emailDocumentSchema,
  renderEmailDocument,
  renderEmailTemplate,
  type EmailDocument,
} from '@omnicus/email-core';
import type { Prisma } from '@omnicus/database';
import { S3MediaStorage } from '@omnicus/media-core';
import { Resend } from 'resend';

import { DatabaseService } from '../database/database.service';

type Audience = {
  contactIds?: string[];
  excludeTagIds?: string[];
  includeTagIds?: string[];
  mode: 'ALL_ACTIVE' | 'CONTACTS' | 'SEGMENT';
  segmentId?: string;
};

type StoredAttachment = {
  content: Buffer;
  contentId?: string;
  contentType?: string;
  filename: string;
};

@Injectable()
export class EmailDeliveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(EmailDeliveryService.name);
  private readonly resend: Resend | undefined;
  private readonly storage: S3MediaStorage | undefined;
  private readonly workerId = `email:${process.pid}:${randomUUID()}`;
  private timer: NodeJS.Timeout | undefined;
  private draining = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {
    const apiKey = config.get('RESEND_API_KEY', { infer: true });
    const from = config.get('EMAIL_FROM', { infer: true });
    if (apiKey && from) this.resend = new Resend(apiKey);
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

  onApplicationBootstrap() {
    if (!this.resend) {
      this.logger.warn('Email delivery is disabled: RESEND_API_KEY or EMAIL_FROM is missing');
      return;
    }
    const interval = this.config.get('EMAIL_DELIVERY_INTERVAL_MS', { infer: true });
    this.timer = setInterval(() => void this.drain(), interval);
    this.timer.unref();
    void this.recoverAndDrain().catch((error) =>
      this.logger.error(error instanceof Error ? error.stack : String(error)),
    );
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async recoverAndDrain() {
    const expired = new Date(
      Date.now() - this.config.get('EMAIL_DELIVERY_LEASE_MS', { infer: true }),
    );
    await this.database.client.emailDelivery.updateMany({
      data: {
        lastError: 'email_worker_recovered_interrupted_delivery',
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: new Date(),
        status: 'RETRY',
      },
      where: { lockedAt: { lt: expired }, status: 'PROCESSING' },
    });
    await this.database.client.emailCampaign.updateMany({
      data: {
        preparationLockedAt: null,
        preparationLockedBy: null,
        status: 'PREPARING',
      },
      where: {
        OR: [
          { preparationLockedAt: { lt: expired } },
          { preparationLockedAt: null, updatedAt: { lt: expired } },
        ],
        deliveries: { none: {} },
        status: 'RUNNING',
      },
    });
    await this.drain();
  }

  private async drain() {
    if (this.draining || !this.resend) return;
    this.draining = true;
    try {
      await this.promoteScheduledCampaigns();
      await this.prepareCampaigns();
      const batchSize = this.config.get('EMAIL_DELIVERY_BATCH_SIZE', { infer: true });
      for (let index = 0; index < batchSize; index += 1) {
        const delivery = await this.claimDelivery();
        if (!delivery) break;
        await this.processDelivery(delivery.id);
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.stack : String(error));
    } finally {
      this.draining = false;
    }
  }

  private async promoteScheduledCampaigns() {
    await this.database.client.emailCampaign.updateMany({
      data: { startedAt: new Date(), status: 'PREPARING' },
      where: { scheduledAt: { lte: new Date() }, status: 'SCHEDULED' },
    });
  }

  private async prepareCampaigns() {
    for (;;) {
      const campaign = await this.database.client.emailCampaign.findFirst({
        orderBy: { createdAt: 'asc' },
        where: { status: 'PREPARING' },
      });
      if (!campaign) return;
      const claimed = await this.database.client.emailCampaign.updateMany({
        data: {
          preparationLockedAt: new Date(),
          preparationLockedBy: this.workerId,
          status: 'RUNNING',
        },
        where: { id: campaign.id, status: 'PREPARING' },
      });
      if (!claimed.count) continue;
      try {
        await this.materializeCampaign(campaign.id);
      } catch (error) {
        await this.database.client.emailCampaign.update({
          data: {
            errorCode: this.message(error),
            failedAt: new Date(),
            preparationLockedAt: null,
            preparationLockedBy: null,
            status: 'FAILED',
          },
          where: { id: campaign.id },
        });
      }
    }
  }

  private async materializeCampaign(campaignId: string) {
    const campaign = await this.database.client.emailCampaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    const design = emailDocumentSchema.parse(campaign.design);
    const audience = this.audience(campaign.audience);
    const [contacts, suppressions] = await Promise.all([
      this.audienceContacts(campaign.projectId, audience),
      this.database.client.emailSuppression.findMany({
        select: { normalizedEmail: true },
        where: { projectId: campaign.projectId },
      }),
    ]);
    const suppressed = new Set(suppressions.map((item) => item.normalizedEmail));
    const seen = new Set<string>();
    const attachmentAssetIds = emailAssetReferences(design).map((item) => item.assetId);
    const rows: Prisma.EmailDeliveryCreateManyInput[] = [];
    for (const contact of contacts) {
      if (
        !contact.email ||
        !contact.normalizedEmail ||
        suppressed.has(contact.normalizedEmail) ||
        seen.has(contact.normalizedEmail)
      )
        continue;
      seen.add(contact.normalizedEmail);
      rows.push({
        attachmentAssetIds: this.json(attachmentAssetIds),
        campaignId: campaign.id,
        contactId: contact.id,
        designSnapshot: this.json(design),
        normalizedEmail: contact.normalizedEmail,
        preheader: campaign.preheader,
        projectId: campaign.projectId,
        source: 'CAMPAIGN',
        subject: campaign.subject,
        toEmail: contact.email,
      });
    }
    if (rows.length)
      await this.database.client.emailDelivery.createMany({ data: rows, skipDuplicates: true });
    await this.database.client.emailCampaign.update({
      data: { preparationLockedAt: null, preparationLockedBy: null },
      where: { id: campaign.id },
    });
    await this.finishCampaignIfComplete(campaign.id);
  }

  private async claimDelivery() {
    const delivery = await this.database.client.emailDelivery.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true },
      where: {
        OR: [{ campaignId: null }, { campaign: { is: { status: 'RUNNING' } } }],
        nextAttemptAt: { lte: new Date() },
        status: { in: ['PENDING', 'RETRY'] },
      },
    });
    if (!delivery) return null;
    const claimed = await this.database.client.emailDelivery.updateMany({
      data: {
        attempts: { increment: 1 },
        lastError: null,
        lockedAt: new Date(),
        lockedBy: this.workerId,
        status: 'PROCESSING',
      },
      where: { id: delivery.id, status: delivery.status },
    });
    return claimed.count ? delivery : null;
  }

  private async processDelivery(deliveryId: string) {
    const delivery = await this.database.client.emailDelivery.findUnique({
      include: { contact: true },
      where: { id: deliveryId },
    });
    if (!delivery) return;
    try {
      if (delivery.source !== 'TEST') await this.assertEligible(delivery);
      const design = emailDocumentSchema.parse(delivery.designSnapshot);
      const { attachments, contentIds } = await this.attachments(delivery.projectId, design);
      const variables = this.variables(delivery.contact, delivery.toEmail);
      const subject = renderEmailTemplate(delivery.subject, variables).output.trim();
      const preheader = delivery.preheader
        ? renderEmailTemplate(delivery.preheader, variables).output
        : undefined;
      const unsubscribeUrl =
        delivery.source === 'TEST'
          ? undefined
          : this.publicApiUrl() + '/api/v1/public/email/unsubscribe/' + delivery.unsubscribeToken;
      const rendered = renderEmailDocument(design, variables, {
        assetContentIds: contentIds,
        preheader,
        unsubscribeUrl,
      });
      const result = await this.resend!.emails.send(
        {
          attachments,
          from: this.config.get('EMAIL_FROM', { infer: true })!,
          headers: {
            ...(unsubscribeUrl
              ? {
                  'List-Unsubscribe': '<' + unsubscribeUrl + '>',
                  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                }
              : {}),
            'X-Omnicus-Delivery-Id': delivery.id,
          },
          html: rendered.html,
          ...(this.config.get('EMAIL_REPLY_TO', { infer: true })
            ? { replyTo: this.config.get('EMAIL_REPLY_TO', { infer: true }) }
            : {}),
          subject: subject || 'Omnicus message',
          tags: [{ name: 'omnicus_delivery_id', value: delivery.id }],
          text: rendered.text,
          to: [delivery.toEmail],
        },
        { idempotencyKey: delivery.id },
      );
      if (result.error || !result.data?.id) throw result.error ?? new Error('resend_missing_id');
      await this.markSent(delivery, result.data.id);
    } catch (error) {
      await this.failDelivery(delivery, error);
    } finally {
      if (delivery.campaignId) await this.finishCampaignIfComplete(delivery.campaignId);
    }
  }

  private async assertEligible(delivery: {
    contact: { normalizedEmail: string | null } | null;
    normalizedEmail: string;
    projectId: string;
  }) {
    if (
      !delivery.contact || delivery.contact.normalizedEmail !== delivery.normalizedEmail
    )
      throw new PermanentEmailError('email_contact_unavailable', 'SUPPRESSED');
    const suppression = await this.database.client.emailSuppression.findUnique({
      where: {
        projectId_normalizedEmail: {
          normalizedEmail: delivery.normalizedEmail,
          projectId: delivery.projectId,
        },
      },
    });
    if (suppression) throw new PermanentEmailError('email_address_suppressed', 'SUPPRESSED');
  }

  private async attachments(projectId: string, design: EmailDocument) {
    const references = emailAssetReferences(design);
    if (!references.length) return { attachments: [] as StoredAttachment[], contentIds: {} };
    if (!this.storage) throw new PermanentEmailError('email_media_storage_unavailable');
    const assets = await this.database.client.mediaAsset.findMany({
      where: { id: { in: references.map((item) => item.assetId) }, projectId },
    });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const attachments: StoredAttachment[] = [];
    const contentIds: Record<string, string> = {};
    let totalBytes = 0;
    for (const reference of references) {
      const asset = byId.get(reference.assetId);
      if (!asset?.bucketKey || asset.status !== 'AVAILABLE')
        throw new PermanentEmailError('email_asset_unavailable');
      const object = await this.storage.getObject(asset.bucketKey);
      const content = Buffer.from(object.bytes);
      totalBytes += content.length;
      if (totalBytes > 29 * 1024 * 1024)
        throw new PermanentEmailError('email_attachments_too_large');
      const contentId =
        reference.usage === 'INLINE' ? `omnicus-${asset.id}@mail.omnicus.app` : undefined;
      if (contentId) contentIds[asset.id] = contentId;
      const contentType = asset.detectedMimeType ?? asset.declaredMimeType ?? object.contentType;
      attachments.push({
        content,
        ...(contentId ? { contentId } : {}),
        ...(contentType ? { contentType } : {}),
        filename: asset.originalFilename ?? asset.id,
      });
    }
    return { attachments, contentIds };
  }

  private async markSent(
    delivery: {
      campaignId: string | null;
      contactId: string | null;
      id: string;
      nodeId: string | null;
      projectId: string;
      scenarioExecutionId: string | null;
      source: string;
      subject: string;
      toEmail: string;
    },
    providerEmailId: string,
  ) {
    const now = new Date();
    await this.database.client.$transaction(async (transaction) => {
      await transaction.emailDelivery.update({
        data: {
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          providerEmailId,
          providerLastEventAt: now,
          sentAt: now,
          status: 'SENT',
        },
        where: { id: delivery.id },
      });
      const event = await transaction.emailEvent.upsert({
        create: {
          deliveryId: delivery.id,
          occurredAt: now,
          projectId: delivery.projectId,
          providerEventId: 'local:sent:' + delivery.id,
          providerPayload: { workerId: this.workerId },
          type: 'SENT',
        },
        update: {},
        where: { providerEventId: 'local:sent:' + delivery.id },
      });
      const providerSent = await transaction.emailEvent.findFirst({
        where: {
          deliveryId: delivery.id,
          providerEventId: { not: 'local:sent:' + delivery.id },
          type: 'SENT',
        },
      });
      if (!providerSent)
        await this.queueCrmEvent(
          transaction,
          { ...delivery, providerEmailId },
          event.id,
          'SENT',
          now,
        );
    });
  }

  private async failDelivery(
    delivery: {
      attempts: number;
      campaignId: string | null;
      id: string;
      maxAttempts: number;
      projectId: string;
    },
    error: unknown,
  ) {
    const message = this.message(error);
    const permanent =
      error instanceof PermanentEmailError ||
      this.permanentProviderError(error) ||
      delivery.attempts >= delivery.maxAttempts;
    const status = error instanceof PermanentEmailError ? error.status : permanent ? 'FAILED' : 'RETRY';
    await this.database.client.emailDelivery.update({
      data: {
        ...(permanent ? { completedAt: new Date() } : {}),
        lastError: message,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: new Date(Date.now() + Math.min(15 * 60_000, 15_000 * 2 ** delivery.attempts)),
        status,
      },
      where: { id: delivery.id },
    });
    if (permanent) this.logger.warn(`Email delivery ${delivery.id} failed: ${message}`);
  }

  private async finishCampaignIfComplete(campaignId: string) {
    const campaign = await this.database.client.emailCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status !== 'RUNNING') return;
    const remaining = await this.database.client.emailDelivery.count({
      where: { campaignId, status: { in: ['PENDING', 'PROCESSING', 'RETRY'] } },
    });
    if (remaining) return;
    const failed = await this.database.client.emailDelivery.count({
      where: { campaignId, status: 'FAILED' },
    });
    await this.database.client.emailCampaign.update({
      data: {
        completedAt: new Date(),
        errorCode: failed ? `${failed}_deliveries_failed` : null,
        status: 'COMPLETED',
      },
      where: { id: campaignId },
    });
  }

  private async queueCrmEvent(
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
    eventId: string,
    eventType: string,
    occurredAt: Date,
  ) {
    if (!delivery.contactId) return;
    const crm = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId: delivery.projectId },
    });
    if (!crm?.enabled || crm.status !== 'ACTIVE') return;
    const idempotencyKey = 'email-event:' + eventId;
    const outbox = await transaction.outboxRecord.create({
      data: {
        idempotencyKey,
        kind: 'CRM',
        maxAttempts: 12,
        nextAttemptAt: new Date(),
        payload: { deliveryId: delivery.id, eventId, type: 'email.event' },
        projectId: delivery.projectId,
      },
    });
    await transaction.crmOperation.create({
      data: {
        contactId: delivery.contactId,
        inputSafe: this.json({
          campaignId: delivery.campaignId,
          deliveryId: delivery.id,
          eventId,
          eventType,
          nodeId: delivery.nodeId,
          occurredAt: occurredAt.toISOString(),
          providerEmailId: delivery.providerEmailId,
          scenarioExecutionId: delivery.scenarioExecutionId,
          source: delivery.source,
          subject: delivery.subject,
          toEmail: delivery.toEmail,
        }),
        outboxRecordId: outbox.id,
        projectId: delivery.projectId,
        type: 'FORWARD_EMAIL_EVENT',
      },
    });
  }

  private async audienceContacts(projectId: string, audience: Audience) {
    const where: Prisma.ContactWhereInput = {
      email: { not: null },
      normalizedEmail: { not: null },
      projectId,
      status: 'ACTIVE',
    };
    if (audience.mode === 'CONTACTS') where.id = { in: audience.contactIds ?? [] };
    if (audience.mode === 'SEGMENT') {
      const segment = await this.database.client.segment.findFirst({
        where: { archivedAt: null, id: audience.segmentId ?? '__missing__', projectId, status: 'ACTIVE' },
      });
      if (!segment) throw new PermanentEmailError('email_segment_not_found');
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

  private audience(value: Prisma.JsonValue): Audience {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new PermanentEmailError('email_audience_invalid');
    const audience = value as unknown as Audience;
    if (!['ALL_ACTIVE', 'CONTACTS', 'SEGMENT'].includes(audience.mode))
      throw new PermanentEmailError('email_audience_invalid');
    return audience;
  }

  private variables(
    contact: { displayName: string; id: string } | null,
    email: string,
  ): Record<string, unknown> {
    const displayName = contact?.displayName?.trim() || email.split('@')[0] || email;
    return {
      contact: {
        email,
        firstName: displayName.split(/\s+/)[0] ?? displayName,
        fullName: displayName,
        id: contact?.id ?? null,
      },
    };
  }

  private publicApiUrl() {
    const value = this.config.get('API_PUBLIC_URL', { infer: true });
    if (!value) throw new PermanentEmailError('email_public_api_url_missing');
    return value.replace(/\/$/, '');
  }

  private json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private message(error: unknown) {
    if (error instanceof Error) return error.message.slice(0, 1_000);
    if (error && typeof error === 'object' && 'message' in error)
      return String((error as { message: unknown }).message).slice(0, 1_000);
    return 'email_delivery_failed';
  }

  private permanentProviderError(error: unknown) {
    if (!error || typeof error !== 'object') return false;
    const statusCode = Number(
      'statusCode' in error
        ? (error as { statusCode: unknown }).statusCode
        : 'status' in error
          ? (error as { status: unknown }).status
          : 0,
    );
    return statusCode >= 400 && statusCode < 500 && ![408, 409, 429].includes(statusCode);
  }
}

class PermanentEmailError extends Error {
  constructor(
    message: string,
    readonly status: 'FAILED' | 'SUPPRESSED' = 'FAILED',
  ) {
    super(message);
  }
}
