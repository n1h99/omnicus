import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnvironment } from '@omnicus/config/server';
import {
  emailAssetReferences,
  emailDocumentSchema,
  renderEmailDocument,
  renderEmailTemplate,
  renderPlainEmail,
  type EmailDocument,
} from '@omnicus/email-core';
import { attachMailboxDelivery, MailboxDeliveryError, type Prisma } from '@omnicus/database';
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
    if (apiKey) this.resend = new Resend(apiKey);
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
      this.logger.warn('Email delivery is disabled: RESEND_API_KEY is missing');
      return;
    }
    const interval = this.config.get('EMAIL_DELIVERY_INTERVAL_MS', { infer: true });
    this.timer = setInterval(() => void this.drain(), interval);
    this.timer.unref();
    void this.drain();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async recoverStaleWork() {
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
  }

  private async drain() {
    if (this.draining || !this.resend) return;
    this.draining = true;
    try {
      await this.recoverStaleWork();
      await this.promoteScheduledCampaigns();
      await this.prepareCampaigns();
      const batchSize = this.config.get('EMAIL_DELIVERY_BATCH_SIZE', { infer: true });
      for (let index = 0; index < batchSize; index += 1) {
        const delivery = await this.claimDelivery();
        if (!delivery) break;
        await this.processDelivery(delivery.id);
      }
    } catch (error) {
      this.logger.error(this.message(error));
    } finally {
      this.draining = false;
    }
  }

  private async promoteScheduledCampaigns() {
    await this.database.client.emailCampaign.updateMany({
      data: { startedAt: new Date(), status: 'PREPARING' },
      where: {
        scheduledAt: { lte: new Date() },
        status: 'SCHEDULED',
        project: { status: 'ACTIVE' },
      },
    });
  }

  private async prepareCampaigns() {
    for (;;) {
      const campaign = await this.database.client.emailCampaign.findFirst({
        orderBy: { createdAt: 'asc' },
        where: { status: 'PREPARING', project: { status: 'ACTIVE' } },
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
        mailboxId: campaign.mailboxId,
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
        project: { status: 'ACTIVE' },
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
    let delivery = await this.database.client.emailDelivery.findUnique({
      include: { contact: true },
      where: { id: deliveryId },
    });
    if (!delivery) return;
    const heartbeat = setInterval(
      () => {
        void this.database.client.emailDelivery
          .updateMany({
            where: { id: deliveryId, status: 'PROCESSING', lockedBy: this.workerId },
            data: { lockedAt: new Date() },
          })
          .catch(() => undefined);
      },
      Math.max(
        1000,
        Math.min(
          10_000,
          (this.config.get('EMAIL_DELIVERY_LEASE_MS', { infer: true }) || 60_000) / 3,
        ),
      ),
    );
    heartbeat.unref();
    try {
      if (
        delivery.firstAttemptAt &&
        Date.now() - delivery.firstAttemptAt.getTime() >= 23 * 60 * 60_000
      )
        throw new UnknownEmailError();
      await this.database.client.$transaction((transaction) =>
        attachMailboxDelivery(transaction, deliveryId, { projectId: delivery!.projectId }),
      );
      delivery = await this.database.client.emailDelivery.findUniqueOrThrow({
        include: { contact: true },
        where: { id: deliveryId },
      });
      const project = await this.database.client.project.findUnique({
        where: { id: delivery.projectId },
        select: { status: true },
      });
      if (project?.status !== 'ACTIVE') throw new Error('email_project_paused');
      if (delivery.mailboxId) {
        const mailbox = await this.database.client.emailMailbox.findFirst({
          where: { id: delivery.mailboxId, projectId: delivery.projectId },
          include: { domain: true },
        });
        if (
          mailbox?.status !== 'ACTIVE' ||
          mailbox.domain.status !== 'verified' ||
          !mailbox.domain.sendingEnabled
        )
          throw new PermanentEmailError('email_sender_not_ready');
      }
      if (delivery.source !== 'TEST') await this.assertEligible(delivery);
      const design = emailDocumentSchema.parse(delivery.designSnapshot);
      const { attachments, contentIds } = await this.attachments(delivery.projectId, design);
      const variables = this.variables(delivery.contact, delivery.toEmail);
      const subject =
        delivery.source === 'MANUAL'
          ? delivery.subject
          : renderEmailTemplate(delivery.subject, variables).output.trim();
      const preheader = delivery.preheader
        ? renderEmailTemplate(delivery.preheader, variables).output
        : undefined;
      const unsubscribeUrl =
        delivery.source === 'TEST' || delivery.source === 'MANUAL'
          ? undefined
          : this.publicApiUrl() + '/api/v1/public/email/unsubscribe/' + delivery.unsubscribeToken;
      const rendered =
        delivery.source === 'MANUAL'
          ? renderPlainEmail(
              design.blocks.map((block) => (block.type === 'TEXT' ? block.content : '')).join(''),
            )
          : renderEmailDocument(design, variables, {
              assetContentIds: contentIds,
              preheader,
              unsubscribeUrl,
            });
      const from = delivery.senderSnapshot ?? this.config.get('EMAIL_FROM', { infer: true });
      if (!from) throw new PermanentEmailError('email_sender_not_ready');
      const headers = delivery.firstAttemptAt
        ? ((delivery.headersSnapshot ?? {}) as Record<string, string>)
        : {
            ...((delivery.headersSnapshot as Record<string, string> | null) ?? {}),
            ...(unsubscribeUrl
              ? {
                  'List-Unsubscribe': '<' + unsubscribeUrl + '>',
                  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                }
              : {}),
            'X-Omnicus-Delivery-Id': delivery.id,
          };
      const replyTo = delivery.mailboxId
        ? delivery.replyToSnapshot
        : this.config.get('EMAIL_REPLY_TO', { infer: true });
      const html = delivery.renderedHtml ?? rendered.html;
      const text = delivery.renderedText ?? rendered.text;
      const sentSubject = delivery.firstAttemptAt ? delivery.subject : subject || 'Omnicus message';
      const lease = await this.database.client.emailDelivery.updateMany({
        where: { id: deliveryId, status: 'PROCESSING', lockedBy: this.workerId },
        data: { lockedAt: new Date() },
      });
      if (!lease.count) return;
      if (!delivery.firstAttemptAt) {
        await this.database.client.$transaction(async (transaction) => {
          await transaction.emailDelivery.update({
            where: { id: deliveryId },
            data: {
              firstAttemptAt: new Date(),
              senderSnapshot: from,
              replyToSnapshot: replyTo ?? null,
              headersSnapshot: headers,
              renderedHtml: html,
              renderedText: text,
              subject: sentSubject,
            },
          });
          await transaction.emailMessage.updateMany({
            where: { deliveryId, projectId: delivery!.projectId },
            data: { htmlBody: html, textBody: text, subject: sentSubject },
          });
        });
      }
      // The installed SDK forwards PostOptions to fetch, including these fetch options.
      const requestOptions = {
        idempotencyKey: delivery.id,
        signal: AbortSignal.timeout(30_000),
        redirect: 'error' as const,
      };
      const result = await this.resend!.emails.send(
        {
          attachments,
          from,
          headers,
          html,
          ...(replyTo ? { replyTo } : {}),
          subject: sentSubject,
          tags: [{ name: 'omnicus_delivery_id', value: delivery.id }],
          text,
          to: [delivery.toEmail],
        },
        requestOptions,
      );
      if (result.error || !result.data?.id) throw result.error ?? new Error('resend_missing_id');
      await this.markSent(delivery, result.data.id);
    } catch (error) {
      await this.failDelivery(delivery, error);
    } finally {
      clearInterval(heartbeat);
      if (delivery.campaignId) await this.finishCampaignIfComplete(delivery.campaignId);
    }
  }

  private async assertEligible(delivery: {
    contact: { normalizedEmail: string | null } | null;
    normalizedEmail: string;
    projectId: string;
    source: string;
  }) {
    if (
      delivery.source !== 'MANUAL' &&
      (!delivery.contact || delivery.contact.normalizedEmail !== delivery.normalizedEmail)
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
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${delivery.id}), 90402)`;
      const current = await transaction.emailDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      await transaction.emailDelivery.update({
        data: {
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          providerEmailId,
          providerLastEventAt: current.providerLastEventAt ?? now,
          sentAt: current.sentAt ?? now,
          status: ['PENDING', 'PROCESSING', 'RETRY', 'UNKNOWN'].includes(current.status)
            ? 'SENT'
            : current.status,
        },
        where: { id: delivery.id },
      });
      await transaction.emailMessage.updateMany({
        where: { deliveryId: delivery.id, projectId: delivery.projectId },
        data: { providerEmailId, rfcMessageId: current.rfcMessageId },
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
      error instanceof MailboxDeliveryError ||
      this.permanentProviderError(error) ||
      delivery.attempts >= delivery.maxAttempts;
    const current = await this.database.client.emailDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    const unknown =
      error instanceof UnknownEmailError ||
      (permanent &&
        !!current.firstAttemptAt &&
        !this.permanentProviderError(error) &&
        !(error instanceof PermanentEmailError) &&
        !(error instanceof MailboxDeliveryError));
    const status = unknown
      ? 'UNKNOWN'
      : error instanceof PermanentEmailError
        ? error.status
        : permanent
          ? 'FAILED'
          : 'RETRY';
    await this.database.client.emailDelivery.updateMany({
      data: {
        ...(permanent ? { completedAt: new Date() } : {}),
        lastError: message,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: new Date(
          Date.now() + Math.min(15 * 60_000, 15_000 * 2 ** delivery.attempts),
        ),
        status,
      },
      where: { id: delivery.id, status: 'PROCESSING', lockedBy: this.workerId },
    });
    if (permanent) this.logger.warn(`Email delivery ${delivery.id} failed: ${message}`);
  }

  private async finishCampaignIfComplete(campaignId: string) {
    const campaign = await this.database.client.emailCampaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign || campaign.status !== 'RUNNING') return;
    const remaining = await this.database.client.emailDelivery.count({
      where: { campaignId, status: { in: ['PENDING', 'PROCESSING', 'RETRY'] } },
    });
    if (remaining) return;
    const failed = await this.database.client.emailDelivery.count({
      where: { campaignId, status: { in: ['FAILED', 'UNKNOWN'] } },
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
        where: {
          archivedAt: null,
          id: audience.segmentId ?? '__missing__',
          projectId,
          status: 'ACTIVE',
        },
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
    if (error instanceof Error && /^(email|resend)_[a-z0-9_]+$/.test(error.message))
      return error.message;
    if (this.permanentProviderError(error)) return 'email_provider_rejected_request';
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

class UnknownEmailError extends Error {
  constructor() {
    super('email_delivery_unknown_reconcile_before_retry');
  }
}
