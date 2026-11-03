import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
import {
  defaultWebinarSettings,
  fingerprint,
  object,
  participantDestination,
  settings,
  validTimezone,
  type WebinarSettings,
} from '@omnicus/webinar-core';
import { DatabaseService } from '../database/database.service';
import { WebinarStarsService } from './webinar-stars.service';
import type {
  WebinarEventDto,
  WebinarImportDto,
  WebinarInviteDto,
  WebinarMatchDto,
} from './webinar-lifecycle.dto';
import type { CreateContactDto } from '../contacts/dto';

export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const failure = (code: string): never => {
  throw new BadRequestException({ code, message: code.replaceAll('_', ' ').toLowerCase() });
};

@Injectable()
export class WebinarLifecycleService {
  constructor(
    @Inject(DatabaseService) readonly database: DatabaseService,
    @Inject(WebinarStarsService) readonly stars: WebinarStarsService,
    @Inject(ConfigService) private readonly config: ConfigService<ApiEnvironment, true>,
  ) {}
  private base() {
    return this.config.get('API_PUBLIC_URL', { infer: true }).replace(/\/$/, '');
  }
  async enable(projectId: string, enabled: boolean) {
    const { row } = await this.stars.connection(projectId);
    if (enabled && !row.verifiedAt)
      throw new ConflictException({
        code: 'WEBINAR_STARS_TEST_REQUIRED',
        message: 'Test the saved connection first',
      });
    await this.database.client.webinarConnection.update({
      where: { projectId },
      data: {
        enabled,
        ...(enabled && !row.enabledAt ? { enabledAt: new Date() } : {}),
        nextPollAt: new Date(),
      },
    });
    return this.stars.config(projectId);
  }
  async rotateWebhook(projectId: string) {
    await this.stars.connection(projectId);
    const secret = randomBytes(32).toString('hex');
    await this.database.client.webinarConnection.update({
      where: { projectId },
      data: { webhookSecretHash: createHash('sha256').update(secret).digest('hex') },
    });
    return { url: `${this.base()}/webhooks/webinar-stars/${projectId}/${secret}` };
  }
  async receive(projectId: string, secret: string, body: unknown) {
    const connection = await this.database.client.webinarConnection.findUnique({
      where: { projectId },
    });
    const supplied = createHash('sha256').update(secret).digest('hex');
    if (
      !connection?.connected ||
      !connection.enabled ||
      !connection.webhookSecretHash ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(connection.webhookSecretHash))
    )
      throw new ForbiddenException();
    const payload = object(body),
      data = object(payload.data),
      reportId = String(data.id ?? '');
    if (
      payload.action !== 'webinar_end' ||
      !/^\d{1,30}$/.test(reportId) ||
      JSON.stringify(body).length > 65536
    )
      failure('WEBINAR_WEBHOOK_INVALID');
    // Persist only the documented bounded summary, never unvalidated raw input.
    const metadata = Object.fromEntries(
      [
        'id',
        'webinar_id',
        'date_start',
        'date_end',
        'duration',
        'once',
        'visitors_count',
        'visitors_peak',
      ]
        .filter((k) => ['string', 'number'].includes(typeof data[k]))
        .map((k) => [k, String(data[k]).slice(0, 100)]),
    );
    await this.database.client.$transaction(async (tx) => {
      const receipt = await tx.webinarWebhookReceipt.createMany({
        data: [
          {
            projectId,
            connectionId: connection.id,
            fingerprint: fingerprint(metadata),
            metadata: json(metadata),
          },
        ],
        skipDuplicates: true,
      });
      if (!receipt.count) return;
      await tx.webinarReportImport.upsert({
        where: {
          projectId_connectionId_externalReportId: {
            projectId,
            connectionId: connection.id,
            externalReportId: reportId,
          },
        },
        create: {
          projectId,
          connectionId: connection.id,
          externalReportId: reportId,
          origin: 'WEBHOOK',
          nextAttemptAt: new Date(Date.now() + 60000),
        },
        update: {
          state: 'PENDING',
          attempts: 0,
          requestedVersion: { increment: 1 },
          nextAttemptAt: new Date(Date.now() + 60000),
        },
      });
    });
    return { ok: true };
  }
  validateSettings(input: unknown): WebinarSettings {
    const value = object(input),
      allowed = new Set(Object.keys(defaultWebinarSettings));
    if (Object.keys(value).some((k) => !allowed.has(k))) failure('WEBINAR_SETTINGS_INVALID');
    const result = settings(value);
    if (
      result.registrationSourceKey !== null &&
      (typeof result.registrationSourceKey !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(result.registrationSourceKey))
    )
      failure('WEBINAR_SETTINGS_INVALID');
    if (result.replay !== null && typeof result.replay !== 'boolean')
      failure('WEBINAR_SETTINGS_INVALID');
    for (const [map, type] of [
      [result.parameters, 'parameters'],
      [result.constants, 'constants'],
    ] as const) {
      if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 20)
        failure('WEBINAR_SETTINGS_INVALID');
      for (const [key, v] of Object.entries(map)) {
        if (
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
          typeof v !== 'string' ||
          v.length > 500 ||
          ['token', '__proto__', 'constructor', 'prototype'].includes(key)
        )
          failure('WEBINAR_SETTINGS_INVALID');
        if (
          type === 'parameters' &&
          !['name', 'email', 'phone', 'trackingToken', 'distributorId'].includes(v)
        )
          failure('WEBINAR_SETTINGS_INVALID');
      }
    }
    if (
      result.trackingParameter !== null &&
      (typeof result.trackingParameter !== 'string' || !/^\w{1,64}$/.test(result.trackingParameter))
    )
      failure('WEBINAR_SETTINGS_INVALID');
    for (const values of [result.clickStatuses, result.seenStatuses])
      if (
        !Array.isArray(values) ||
        values.length > 20 ||
        values.some((x) => typeof x !== 'string' || x.length > 100)
      )
        failure('WEBINAR_SETTINGS_INVALID');
    if (
      !Array.isArray(result.reminderMinutes) ||
      result.reminderMinutes.length > 5 ||
      result.reminderMinutes.some((x) => !Number.isInteger(x) || x < 1 || x > 43200) ||
      !Number.isInteger(result.completedPercentage) ||
      result.completedPercentage < 1 ||
      result.completedPercentage > 100 ||
      typeof result.crmEnabled !== 'boolean'
    )
      failure('WEBINAR_SETTINGS_INVALID');
    return result;
  }
  async createEvent(projectId: string, input: WebinarEventDto) {
    const { row } = await this.stars.connection(projectId),
      config = this.validateSettings(input.settings);
    if (
      !input.title.trim() ||
      !validTimezone(input.timezone) ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(input.scheduledAt) ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(input.endsAt)
    )
      failure('WEBINAR_EVENT_INVALID');
    const scheduledAt = new Date(input.scheduledAt),
      endsAt = new Date(input.endsAt);
    if (endsAt <= scheduledAt || endsAt.getTime() - scheduledAt.getTime() > 7 * 86400000)
      failure('WEBINAR_EVENT_INVALID');
    try {
      participantDestination(input.roomUrl, config, {}, {});
    } catch {
      failure('WEBINAR_ROOM_URL_INVALID');
    }
    return this.database.client.webinarEvent.create({
      data: {
        projectId,
        connectionId: row.id,
        providerWebinarId: input.providerWebinarId,
        title: input.title.trim(),
        roomUrl: input.roomUrl,
        timezone: input.timezone,
        scheduledAt,
        endsAt,
        settings: json(config),
      },
    });
  }
  async events(projectId: string) {
    return this.database.client.webinarEvent.findMany({
      where: { projectId },
      orderBy: { scheduledAt: 'desc' },
      take: 100,
      include: { _count: { select: { invitations: true, imports: true } } },
    });
  }
  async cancelEvent(projectId: string, id: string) {
    await this.database.client.$transaction(async (tx) => {
      const event = await tx.webinarEvent.updateMany({
        where: { projectId, id },
        data: { cancelledAt: new Date() },
      });
      if (!event.count) throw new NotFoundException();
      await tx.webinarInvitation.updateMany({
        where: { projectId, eventId: id },
        data: { cancelledAt: new Date() },
      });
    });
    return { cancelled: true };
  }
  async importReport(projectId: string, input: WebinarImportDto) {
    const { row } = await this.stars.connection(projectId);
    const event = input.eventId
      ? await this.database.client.webinarEvent.findFirst({
          where: { id: input.eventId, projectId, connectionId: row.id, cancelledAt: null },
        })
      : null;
    if (input.eventId && !event) throw new NotFoundException();
    if (
      !input.historical &&
      (!row.enabled || !row.enabledAt || !event || event.scheduledAt < row.enabledAt)
    )
      failure('WEBINAR_LIVE_IMPORT_INVALID');
    const old = await this.database.client.webinarReportImport.findUnique({
      where: {
        projectId_connectionId_externalReportId: {
          projectId,
          connectionId: row.id,
          externalReportId: input.reportId,
        },
      },
    });
    if (old?.state === 'PROCESSING')
      throw new ConflictException({
        message: 'Wait for the current import before changing its binding',
      });
    if (old?.eventId && old.eventId !== input.eventId)
      throw new ConflictException({
        message: 'A report already bound to a session cannot be rebound',
      });
    return this.database.client.webinarReportImport.upsert({
      where: {
        projectId_connectionId_externalReportId: {
          projectId,
          connectionId: row.id,
          externalReportId: input.reportId,
        },
      },
      create: {
        projectId,
        connectionId: row.id,
        externalReportId: input.reportId,
        origin: 'MANUAL',
        eventId: event?.id ?? null,
        historical: input.historical,
      },
      update: {
        origin: 'MANUAL',
        eventId: event?.id ?? null,
        historical: input.historical,
        state: 'PENDING',
        attempts: 0,
        requestedVersion: { increment: 1 },
        nextAttemptAt: new Date(),
      },
    });
  }
  async imports(projectId: string) {
    return this.database.client.webinarReportImport.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: { _count: { select: { attendances: true } } },
    });
  }
  async retry(projectId: string, id: string) {
    const updated = await this.database.client.webinarReportImport.updateMany({
      where: { id, projectId, state: { in: ['FAILED', 'COMPLETED', 'PARTIAL'] } },
      data: {
        state: 'PENDING',
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
        requestedVersion: { increment: 1 },
      },
    });
    if (!updated.count)
      throw new ConflictException({ message: 'This import is unavailable or is still processing' });
    return { queued: true };
  }
  async attendances(projectId: string, importId?: string) {
    return this.database.client.webinarAttendance.findMany({
      where: { projectId, ...(importId ? { importId } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 500,
      include: {
        contact: { select: { id: true, displayName: true } },
        report: { select: { externalReportId: true, eventId: true, historical: true } },
      },
    });
  }
  async match(projectId: string, id: string, input: WebinarMatchDto) {
    const attendance = await this.database.client.webinarAttendance.findFirst({
      where: { id, projectId },
    });
    if (!attendance) throw new NotFoundException();
    if (input.ignore === true) {
      return this.database.client.$transaction(async (tx) => {
        const won = await tx.webinarAttendance.updateMany({
          where: { projectId, id, version: attendance.version, contactId: null },
          data: { matchState: 'IGNORED', matchReason: 'MANUAL_IGNORE', version: { increment: 1 } },
        });
        if (!won.count)
          throw new ConflictException({ message: 'This participant changed; refresh the list' });
        await tx.webinarReportImport.updateMany({
          where: { projectId, id: attendance.importId },
          data: { requestedVersion: { increment: 1 }, nextAttemptAt: new Date() },
        });
        await tx.webinarReportImport.updateMany({
          where: { projectId, id: attendance.importId, state: { not: 'PROCESSING' } },
          data: { state: 'PENDING', attempts: 0 },
        });
        return { ignored: true };
      });
    }
    const contact = await this.database.client.contact.findFirst({
      where: { id: input.contactId ?? '', projectId, status: 'ACTIVE' },
    });
    if (!contact)
      throw new NotFoundException({ message: 'Choose an active contact from this project' });
    await this.database.client.$transaction(async (tx) => {
      const won = await tx.webinarAttendance.updateMany({
        where: { projectId, id, version: attendance.version, contactId: null },
        data: {
          contactId: contact.id,
          matchState: 'MANUAL',
          matchReason: 'MANUAL_MATCH',
          version: { increment: 1 },
        },
      });
      if (!won.count)
        throw new ConflictException({
          message: 'This participant is already matched; refresh the list',
        });
      await tx.webinarReportImport.updateMany({
        where: { projectId, id: attendance.importId },
        data: {
          nextAttemptAt: new Date(),
          requestedVersion: { increment: 1 },
        },
      });
      await tx.webinarReportImport.updateMany({
        where: { projectId, id: attendance.importId, state: { not: 'PROCESSING' } },
        data: { state: 'PENDING', attempts: 0 },
      });
    });
    return { matched: true };
  }
  async invite(projectId: string, eventId: string, input: WebinarInviteDto) {
    if (!input.contactIds.length) failure('WEBINAR_CONTACTS_REQUIRED');
    const event = await this.database.client.webinarEvent.findFirst({
      where: { id: eventId, projectId, cancelledAt: null },
      include: { connection: true },
    });
    if (!event || event.endsAt < new Date() || !event.connection.connected)
      throw new NotFoundException({ message: 'Choose an upcoming webinar session' });
    const contacts = await this.database.client.contact.findMany({
      where: { projectId, id: { in: [...new Set(input.contactIds)] }, status: 'ACTIVE' },
    });
    if (contacts.length !== new Set(input.contactIds).size) failure('WEBINAR_CONTACTS_INVALID');
    const attribution = object(input.attribution);
    if (
      Object.keys(attribution).length > 6 ||
      Object.entries(attribution).some(
        ([k, v]) =>
          ![
            'utm_source',
            'utm_medium',
            'utm_campaign',
            'utm_content',
            'utm_term',
            'distributorId',
          ].includes(k) ||
          typeof v !== 'string' ||
          v.length > 500,
      )
    )
      failure('WEBINAR_ATTRIBUTION_INVALID');
    const results = [];
    for (const contact of contacts) {
      const invitation = await this.database.client.$transaction(async (tx) => {
        const row = await tx.webinarInvitation.upsert({
          where: { projectId_eventId_contactId: { projectId, eventId, contactId: contact.id } },
          create: {
            projectId,
            eventId,
            contactId: contact.id,
            token: randomBytes(24).toString('hex'),
            attribution: json(attribution),
          },
          update: {},
        });
        const payload = {
          webinar: {
            eventId,
            title: event.title,
            externalWebinarId: event.providerWebinarId,
            scheduledAt: event.scheduledAt.toISOString(),
            endsAt: event.endsAt.toISOString(),
            timezone: event.timezone,
          },
          invitation: {
            id: row.id,
            participantUrl: `${this.base()}/public/webinar-invitations/${row.token}`,
          },
          attribution: row.attribution,
        };
        if (event.connection.enabled) {
          const schedule = [
            { eventType: 'WEBINAR_REGISTERED', dueAt: new Date() },
            ...settings(event.settings).reminderMinutes.map((minutes) => ({
              eventType: 'WEBINAR_REMINDER',
              dueAt: new Date(event.scheduledAt.getTime() - minutes * 60000),
            })),
            { eventType: 'WEBINAR_STARTED', dueAt: event.scheduledAt },
          ].filter((x) => x.eventType === 'WEBINAR_REGISTERED' || x.dueAt > new Date());
          await tx.webinarAction.createMany({
            data: schedule.map((x) => ({
              projectId,
              contactId: contact.id,
              kind: 'AUTOMATION',
              eventType: x.eventType,
              dedupeKey: `invitation:${row.id}:${x.eventType}:${x.dueAt.toISOString().slice(0, x.eventType === 'WEBINAR_REGISTERED' ? 0 : 24)}`,
              payload: json({ ...payload, type: x.eventType }),
              dueAt: x.dueAt,
            })),
            skipDuplicates: true,
          });
        }
        return {
          ...row,
          contact: {
            id: contact.id,
            displayName: contact.displayName,
            email: contact.email,
            phone: contact.phone,
          },
          participantUrl: payload.invitation.participantUrl,
        };
      });
      results.push(invitation);
    }
    return results;
  }
  async invitations(projectId: string, eventId: string) {
    return this.database.client.webinarInvitation
      .findMany({
        where: { projectId, eventId },
        take: 500,
        include: { contact: { select: { id: true, displayName: true, email: true } } },
      })
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          participantUrl: `${this.base()}/public/webinar-invitations/${row.token}`,
        })),
      );
  }
  async redirect(token: string) {
    if (!/^[a-f0-9]{48}$/.test(token)) throw new NotFoundException();
    const invitation = await this.database.client.webinarInvitation.findUnique({
      where: { token },
      include: { event: { include: { connection: true } }, contact: true },
    });
    if (
      !invitation ||
      invitation.cancelledAt ||
      invitation.event.cancelledAt ||
      !invitation.event.connection.connected ||
      invitation.contact.status !== 'ACTIVE' ||
      invitation.event.endsAt.getTime() + 7 * 86400000 < Date.now()
    )
      throw new NotFoundException();
    await this.database.client.webinarInvitation.updateMany({
      where: { id: invitation.id, openedAt: null },
      data: { openedAt: new Date() },
    });
    return participantDestination(
      invitation.event.roomUrl,
      settings(invitation.event.settings),
      {
        name: invitation.contact.displayName,
        email: invitation.contact.email,
        phone: invitation.contact.phone,
        trackingToken: invitation.token,
        distributorId:
          typeof object(invitation.attribution).distributorId === 'string'
            ? (object(invitation.attribution).distributorId as string)
            : null,
      },
      object(invitation.attribution),
    );
  }
  async actions(projectId: string) {
    return this.database.client.webinarAction.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        contactId: true,
        kind: true,
        eventType: true,
        state: true,
        dueAt: true,
        attempts: true,
        lastError: true,
        completedAt: true,
        createdAt: true,
      },
    });
  }
  async contactOptions(projectId: string, search = '') {
    return this.database.client.contact.findMany({
      where: {
        projectId,
        status: 'ACTIVE',
        ...(search
          ? {
              OR: [
                { displayName: { contains: search.slice(0, 120), mode: 'insensitive' as const } },
                { email: { contains: search.slice(0, 120), mode: 'insensitive' as const } },
                { phone: { contains: search.slice(0, 120) } },
              ],
            }
          : {}),
      },
      take: 50,
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true, email: true, phone: true },
    });
  }
  async createParticipantContact(projectId: string, id: string, input: CreateContactDto) {
    return this.database.client.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT id FROM webinar_attendances WHERE id=${id} AND "projectId"=${projectId} FOR UPDATE`,
      );
      const attendance = await tx.webinarAttendance.findFirst({ where: { id, projectId } });
      if (!attendance) throw new NotFoundException();
      if (attendance.contactId) return { id: attendance.contactId, reused: true };
      const email = input.email?.trim().toLowerCase() || null,
        phone = input.phone?.trim() || null,
        normalizedPhone = phone?.replace(/\D/g, '') || null;
      if (normalizedPhone && !/^\d{6,15}$/.test(normalizedPhone))
        failure('WEBINAR_CONTACT_PHONE_INVALID');
      if (email || normalizedPhone) {
        const existing = await tx.contact.findFirst({
          where: {
            projectId,
            OR: [
              ...(email ? [{ normalizedEmail: email }] : []),
              ...(normalizedPhone ? [{ normalizedPhone }] : []),
            ],
          },
        });
        if (existing)
          throw new ConflictException({
            message: 'A contact with these details already exists; use Match contact',
          });
      }
      const contact = await tx.contact.create({
        data: {
          projectId,
          displayName: input.displayName.trim(),
          email,
          normalizedEmail: email,
          phone,
          normalizedPhone,
          ...(input.firstName ? { firstName: input.firstName.trim() } : {}),
          ...(input.lastName ? { lastName: input.lastName.trim() } : {}),
          ...(input.username ? { username: input.username.trim() } : {}),
        },
      });
      await tx.webinarAttendance.update({
        where: { projectId_id: { projectId, id } },
        data: {
          contactId: contact.id,
          matchState: 'MANUAL',
          matchReason: 'MANUAL_CONTACT_CREATED',
          version: { increment: 1 },
        },
      });
      const route = await tx.crmProjectConfig.findUnique({ where: { projectId } });
      if (route?.enabled && route.status === 'ACTIVE') {
        const outbox = await tx.outboxRecord.create({
          data: {
            projectId,
            kind: 'CRM',
            idempotencyKey: `webinar-contact:${id}`,
            payload: { contactId: contact.id, operationType: 'CREATE_OR_UPDATE_LEAD' },
            nextAttemptAt: new Date(),
          },
        });
        await tx.crmOperation.create({
          data: {
            projectId,
            contactId: contact.id,
            type: 'CREATE_OR_UPDATE_LEAD',
            outboxRecordId: outbox.id,
            inputSafe: { source: 'webinar.manual_match' },
          },
        });
      }
      await tx.webinarReportImport.updateMany({
        where: { projectId, id: attendance.importId },
        data: { requestedVersion: { increment: 1 }, nextAttemptAt: new Date() },
      });
      await tx.webinarReportImport.updateMany({
        where: { projectId, id: attendance.importId, state: { not: 'PROCESSING' } },
        data: { state: 'PENDING', attempts: 0 },
      });
      return { id: contact.id, reused: false };
    });
  }
  async updateSettings(projectId: string, eventId: string, value: unknown) {
    const config = this.validateSettings(value);
    const row = await this.database.client.webinarEvent.updateMany({
      where: { id: eventId, projectId, cancelledAt: null },
      data: { settings: json(config) },
    });
    if (!row.count) throw new NotFoundException();
    return { saved: true };
  }
  async retryAction(projectId: string, id: string) {
    const row = await this.database.client.webinarAction.findFirst({
      where: { id, projectId, state: { in: ['FAILED', 'UNKNOWN'] } },
    });
    if (!row)
      throw new ConflictException({ message: 'Only failed or uncertain actions can be retried' });
    await this.database.client.webinarAction.updateMany({
      where: { id, projectId, state: row.state, updatedAt: row.updatedAt },
      data: {
        state: row.state === 'UNKNOWN' ? 'UNKNOWN' : 'PENDING',
        attempts: 0,
        dueAt: new Date(),
        lockedBy: null,
        lockedUntil: null,
        lastError: null,
      },
    });
    return { queued: true };
  }
}
