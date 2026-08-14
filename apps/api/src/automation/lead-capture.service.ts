import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiEnvironment } from '@omnicus/config/server';
import { Prisma } from '@omnicus/database';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { DatabaseService } from '../database/database.service';
import type { CaptureLeadDto } from './lead-capture.dto';

const sourcePattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;

@Injectable()
export class LeadCaptureService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<ApiEnvironment, true>,
  ) {}

  async configuration(projectId: string, sourceKeyInput: string) {
    const sourceKey = this.sourceKey(sourceKeyInput);
    const project = await this.database.client.project.findUnique({
      select: { id: true },
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('project_not_found');
    const baseUrl = this.config.get('API_PUBLIC_URL', { infer: true }).replace(/\/$/, '');
    return {
      bodyExample: {
        consents: { email: true, sms: true, whatsApp: true },
        consentSource: 'webinar_registration',
        email: 'lead@example.com',
        externalId: 'registration-id',
        firstName: 'Alex',
        phone: '+15551234567',
      },
      endpointUrl: `${baseUrl}/api/v1/public/projects/${projectId}/leads/${sourceKey}`,
      headers: {
        'Idempotency-Key': '<unique-registration-id>',
        'X-Omnicus-Ingest-Key': this.secret(projectId, sourceKey),
      },
      sourceKey,
    };
  }

  async capture(
    projectId: string,
    sourceKeyInput: string,
    suppliedSecret: string | undefined,
    headerIdempotencyKey: string | undefined,
    input: CaptureLeadDto,
  ) {
    const sourceKey = this.sourceKey(sourceKeyInput);
    if (!suppliedSecret || !this.equalSecret(suppliedSecret, this.secret(projectId, sourceKey)))
      throw new ForbiddenException('lead_capture_key_invalid');
    const email = input.email?.trim().toLowerCase();
    const phone = input.phone?.trim();
    const normalizedEmail = email || null;
    const normalizedPhone = this.normalizePhone(phone);
    if (!normalizedEmail && !normalizedPhone)
      throw new BadRequestException('lead_capture_email_or_phone_required');
    const idempotencyKey = (
      headerIdempotencyKey ??
      input.idempotencyKey ??
      input.externalId
    )?.trim();
    if (!idempotencyKey) throw new BadRequestException('lead_capture_idempotency_key_required');
    if (idempotencyKey.length > 160)
      throw new BadRequestException('lead_capture_idempotency_key_too_long');
    const suppliedConsentSource = input.consentSource?.trim();
    const consentSource = suppliedConsentSource || `website:${sourceKey}`;
    const stablePayload = {
      consents: input.consents ?? {},
      ...(suppliedConsentSource ? { consentSource: suppliedConsentSource } : {}),
      displayName: input.displayName?.trim() || undefined,
      email: normalizedEmail ?? undefined,
      externalId: input.externalId?.trim() || undefined,
      firstName: input.firstName?.trim() || undefined,
      lastName: input.lastName?.trim() || undefined,
      metadata: input.metadata ?? {},
      phone: phone || undefined,
      sourceKey,
    };
    const serialized = JSON.stringify(stablePayload);
    if (Buffer.byteLength(serialized, 'utf8') > 32_768)
      throw new BadRequestException('lead_capture_payload_too_large');
    const requestHash = createHash('sha256').update(serialized).digest('hex');
    const registeredAt = new Date();
    const payload = { ...stablePayload, registeredAt: registeredAt.toISOString() };

    return this.database.client.$transaction(async (transaction) => {
      const existingEvent = await transaction.leadCaptureEvent.findUnique({
        where: { projectId_sourceKey_idempotencyKey: { idempotencyKey, projectId, sourceKey } },
      });
      if (existingEvent) {
        if (existingEvent.requestHash !== requestHash)
          throw new ConflictException('lead_capture_idempotency_conflict');
        return { contactId: existingEvent.contactId, eventId: existingEvent.id, reused: true };
      }
      const project = await transaction.project.findUnique({
        select: { id: true },
        where: { id: projectId },
      });
      if (!project) throw new NotFoundException('project_not_found');
      const lockKey = `lead-capture:${projectId}:${normalizedPhone ?? ''}:${normalizedEmail ?? ''}`;
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
      const concurrentEvent = await transaction.leadCaptureEvent.findUnique({
        where: { projectId_sourceKey_idempotencyKey: { idempotencyKey, projectId, sourceKey } },
      });
      if (concurrentEvent) {
        if (concurrentEvent.requestHash !== requestHash)
          throw new ConflictException('lead_capture_idempotency_conflict');
        return { contactId: concurrentEvent.contactId, eventId: concurrentEvent.id, reused: true };
      }
      const matchedContact = await transaction.contact.findFirst({
        orderBy: { createdAt: 'asc' },
        where: {
          projectId,
          OR: [
            ...(normalizedPhone ? [{ normalizedPhone }] : []),
            ...(normalizedEmail ? [{ normalizedEmail }] : []),
          ],
        },
      });
      const contact = matchedContact?.mergedIntoContactId
        ? await transaction.contact.findUnique({
            where: { projectId_id: { id: matchedContact.mergedIntoContactId, projectId } },
          })
        : matchedContact;
      const displayName =
        input.displayName?.trim() ||
        [input.firstName?.trim(), input.lastName?.trim()].filter(Boolean).join(' ') ||
        email ||
        phone ||
        'Website lead';
      const contactData = {
        customFields: this.json({
          ...this.record(contact?.customFields),
          leadRegistration: {
            consents: input.consents ?? {},
            consentSource,
            externalId: input.externalId?.trim() || null,
            metadata: input.metadata ?? {},
            registeredAt: payload.registeredAt,
            sourceKey,
          },
        }),
        displayName,
        ...(email ? { email, normalizedEmail } : {}),
        ...(input.firstName?.trim() ? { firstName: input.firstName.trim() } : {}),
        ...(input.lastName?.trim() ? { lastName: input.lastName.trim() } : {}),
        ...(phone ? { normalizedPhone, phone } : {}),
        ...(input.consents?.email === true
          ? {
              emailConsentAt: registeredAt,
              emailConsentSource: consentSource,
              emailConsentStatus: 'GRANTED' as const,
              emailOptOutAt: null,
            }
          : input.consents?.email === false
            ? {
                emailConsentSource: consentSource,
                emailConsentStatus: 'REVOKED' as const,
                emailOptOutAt: registeredAt,
              }
            : {}),
        ...(input.consents?.whatsApp === true
          ? {
              whatsAppConsentAt: registeredAt,
              whatsAppConsentSource: consentSource,
              whatsAppConsentStatus: 'GRANTED' as const,
              whatsAppOptOutAt: null,
            }
          : input.consents?.whatsApp === false
            ? {
                whatsAppConsentSource: consentSource,
                whatsAppConsentStatus: 'REVOKED' as const,
                whatsAppOptOutAt: registeredAt,
              }
            : {}),
      };
      const savedContact = contact
        ? await transaction.contact.update({ data: contactData, where: { id: contact.id } })
        : await transaction.contact.create({ data: { ...contactData, projectId } });
      const event = await transaction.leadCaptureEvent.create({
        data: {
          contactId: savedContact.id,
          idempotencyKey,
          payload: this.json(payload),
          projectId,
          requestHash,
          sourceKey,
        },
      });
      await this.queueCrmLead(transaction, projectId, savedContact.id, event.id, sourceKey);
      return { contactId: savedContact.id, eventId: event.id, reused: false };
    });
  }

  private async queueCrmLead(
    transaction: Prisma.TransactionClient,
    projectId: string,
    contactId: string,
    eventId: string,
    sourceKey: string,
  ): Promise<void> {
    const crmConfig = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId },
    });
    if (!crmConfig?.enabled || crmConfig.status !== 'ACTIVE') return;
    const outbox = await transaction.outboxRecord.create({
      data: {
        idempotencyKey: `lead-capture:${eventId}`,
        kind: 'CRM',
        maxAttempts: 12,
        nextAttemptAt: new Date(),
        payload: { contactId, eventId, sourceKey, type: 'lead.capture' },
        projectId,
      },
    });
    await transaction.crmOperation.create({
      data: {
        contactId,
        inputSafe: { eventId, sourceKey },
        outboxRecordId: outbox.id,
        projectId,
        type: 'CREATE_OR_UPDATE_LEAD',
      },
    });
  }

  private sourceKey(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!sourcePattern.test(normalized))
      throw new BadRequestException('lead_capture_source_invalid');
    return normalized;
  }

  private secret(projectId: string, sourceKey: string): string {
    return createHmac('sha256', this.config.get('CHANNEL_SECRETS_KEY', { infer: true }))
      .update(`lead-capture:v1:${projectId}:${sourceKey}`)
      .digest('base64url');
  }

  private equalSecret(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  private normalizePhone(value: string | undefined): string | null {
    if (!value) return null;
    const digits = value.replace(/\D/g, '');
    if (digits.length < 5) throw new BadRequestException('lead_capture_phone_invalid');
    return digits;
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
