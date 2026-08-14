import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiEnvironment } from '@omnicus/config/server';
import type { Prisma } from '@omnicus/database';
import { Resend } from 'resend';

import { DatabaseService } from '../database/database.service';
import { EmailService } from './email.service';

const EVENT_MAP = {
  'email.bounced': { status: 'BOUNCED', type: 'BOUNCED' },
  'email.clicked': { status: 'CLICKED', type: 'CLICKED' },
  'email.complained': { status: 'COMPLAINED', type: 'COMPLAINED' },
  'email.delivered': { status: 'DELIVERED', type: 'DELIVERED' },
  'email.delivery_delayed': { status: 'DELIVERY_DELAYED', type: 'DELIVERY_DELAYED' },
  'email.failed': { status: 'FAILED', type: 'FAILED' },
  'email.opened': { status: 'OPENED', type: 'OPENED' },
  'email.sent': { status: 'SENT', type: 'SENT' },
  'email.suppressed': { status: 'SUPPRESSED', type: 'SUPPRESSED' },
} as const;

type ResendEventType = keyof typeof EVENT_MAP;

const STATUS_PRIORITY: Record<string, number> = {
  BOUNCED: 90,
  CANCELLED: 100,
  CLICKED: 70,
  COMPLAINED: 100,
  DELIVERED: 50,
  DELIVERY_DELAYED: 45,
  FAILED: 90,
  OPENED: 60,
  PENDING: 0,
  PROCESSING: 10,
  RETRY: 10,
  SENT: 40,
  SUPPRESSED: 100,
};

@Injectable()
export class EmailWebhooksService {
  private readonly resend: Resend;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<ApiEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {
    this.resend = new Resend('re_webhook_verification_only');
  }

  async receive(
    rawBody: Buffer,
    headers: { id: string; signature: string; timestamp: string },
  ) {
    const secret = this.config.get('RESEND_WEBHOOK_SECRET', { infer: true });
    if (!secret) throw new UnauthorizedException('resend_webhook_not_configured');

    let verified: unknown;
    try {
      verified = this.resend.webhooks.verify({
        payload: rawBody.toString('utf8'),
        headers,
        webhookSecret: secret,
      });
    } catch {
      throw new UnauthorizedException('resend_webhook_signature_invalid');
    }

    const event = verified as {
      created_at?: string;
      data?: {
        click?: { link?: string };
        email_id?: string;
        error?: { message?: string } | string;
        tags?: Record<string, string>;
      };
      type?: string;
    };
    const mapped = event.type ? EVENT_MAP[event.type as ResendEventType] : undefined;
    if (!mapped || !event.data?.email_id) return { accepted: true, ignored: true };
    const providerEmailId = event.data.email_id;

    const delivery =
      (await this.database.client.emailDelivery.findUnique({
        where: { providerEmailId },
      })) ??
      (event.data.tags?.omnicus_delivery_id
        ? await this.database.client.emailDelivery.findUnique({
            where: { id: event.data.tags.omnicus_delivery_id },
          })
        : null);
    if (!delivery) return { accepted: true, ignored: true };

    const occurredAt = this.safeDate(event.created_at);
    const targetUrl = event.data.click?.link;
    const providerPayload = JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
    const terminal = ['BOUNCED', 'COMPLAINED', 'FAILED', 'SUPPRESSED'].includes(mapped.status);

    await this.database.client.$transaction(async (transaction) => {
      const existing = await transaction.emailEvent.findUnique({
        where: { providerEventId: headers.id },
      });
      if (existing) return;
      const localSent =
        mapped.type === 'SENT'
          ? await transaction.emailEvent.findUnique({
              where: { providerEventId: 'local:sent:' + delivery.id },
            })
          : null;

      const storedEvent = await transaction.emailEvent.create({
        data: {
          deliveryId: delivery.id,
          occurredAt,
          projectId: delivery.projectId,
          providerEventId: headers.id,
          providerPayload,
          targetUrl: targetUrl ?? null,
          type: mapped.type,
        },
      });

      if ((STATUS_PRIORITY[mapped.status] ?? 0) >= (STATUS_PRIORITY[delivery.status] ?? 0)) {
        await transaction.emailDelivery.update({
          data: {
            ...(terminal ? { completedAt: occurredAt } : {}),
            ...(mapped.type === 'DELIVERED' ? { deliveredAt: occurredAt } : {}),
            ...(mapped.type === 'OPENED' ? { openedAt: occurredAt } : {}),
            ...(mapped.type === 'CLICKED' ? { clickedAt: occurredAt } : {}),
            ...(mapped.type === 'BOUNCED' ? { bouncedAt: occurredAt } : {}),
            ...(mapped.type === 'COMPLAINED' ? { complainedAt: occurredAt } : {}),
            ...(mapped.type === 'FAILED' ? { failedAt: occurredAt } : {}),
            lastError: terminal ? this.errorMessage(event.data?.error, mapped.type) : null,
            providerEmailId: delivery.providerEmailId ?? providerEmailId,
            providerLastEventAt: occurredAt,
            status: mapped.status,
          },
          where: { id: delivery.id },
        });
      }

      if (['BOUNCED', 'COMPLAINED', 'SUPPRESSED'].includes(mapped.type)) {
        const reason =
          mapped.type === 'BOUNCED'
            ? 'BOUNCED'
            : mapped.type === 'COMPLAINED'
              ? 'COMPLAINT'
              : 'PROVIDER_SUPPRESSION';
        await transaction.emailSuppression.upsert({
          create: {
            normalizedEmail: delivery.normalizedEmail,
            projectId: delivery.projectId,
            reason,
            source: 'resend_webhook',
          },
          update: { reason, source: 'resend_webhook' },
          where: {
            projectId_normalizedEmail: {
              normalizedEmail: delivery.normalizedEmail,
              projectId: delivery.projectId,
            },
          },
        });
        if (mapped.type === 'COMPLAINED') {
          await transaction.contact.updateMany({
            data: {
              emailConsentSource: 'resend_complaint',
              emailConsentStatus: 'REVOKED',
              emailOptOutAt: occurredAt,
            },
            where: {
              normalizedEmail: delivery.normalizedEmail,
              projectId: delivery.projectId,
            },
          });
        }
      }

      if (!localSent)
        await this.email.queueCrmEvent(transaction, delivery, {
          eventId: storedEvent.id,
          eventType: mapped.type,
          occurredAt: occurredAt.toISOString(),
          ...(targetUrl ? { targetUrl } : {}),
        });
    });

    return { accepted: true };
  }

  private errorMessage(error: { message?: string } | string | undefined, fallback: string) {
    if (typeof error === 'string') return error.slice(0, 1_000);
    return (error?.message ?? fallback).slice(0, 1_000);
  }

  private safeDate(value: string | undefined) {
    if (!value) return new Date();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }
}
