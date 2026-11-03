import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  fingerprint,
  groupVisits,
  normalizeAttendance,
  object,
  settings,
  localToUtc,
  emailIdentity,
  phoneIdentity,
  WebinarStarsError,
} from '@omnicus/webinar-core';
import type { Prisma } from '@omnicus/database';
import { WebinarLifecycleService, json } from './webinar-lifecycle.service';

@Injectable()
export class WebinarImportRuntimeService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(WebinarImportRuntimeService.name);
  constructor(
    @Inject(WebinarLifecycleService) private readonly lifecycle: WebinarLifecycleService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private get db() {
    return this.lifecycle.database.client;
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.poll();
      const now = new Date();
      const jobs = await this.db.webinarReportImport.findMany({
        where: {
          state: { in: ['PENDING', 'RETRY', 'PROCESSING'] },
          nextAttemptAt: { lte: now },
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
          connection: { enabled: true, connected: true },
        },
        take: 5,
        orderBy: { nextAttemptAt: 'asc' },
      });
      for (const job of jobs) await this.process(job.id);
      await this.db.webinarWebhookReceipt.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - 30 * 86400000) } },
      });
    } catch {
      this.logger.warn('WEBINAR_IMPORT_PUMP_UNAVAILABLE');
    } finally {
      this.running = false;
    }
  }
  async poll() {
    const now = new Date(),
      connection = await this.db.webinarConnection.findFirst({
        where: {
          enabled: true,
          connected: true,
          nextPollAt: { lte: now },
          OR: [{ pollLockedUntil: null }, { pollLockedUntil: { lt: now } }],
        },
        orderBy: { nextPollAt: 'asc' },
      });
    if (!connection) return;
    const owner = randomUUID();
    const won = await this.db.webinarConnection.updateMany({
      where: {
        id: connection.id,
        enabled: true,
        OR: [{ pollLockedUntil: null }, { pollLockedUntil: { lt: now } }],
      },
      data: {
        pollLockedBy: owner,
        pollLockedUntil: new Date(Date.now() + 60000),
        pollStartedAt: connection.pollStartedAt ?? now,
      },
    });
    if (!won.count) return;
    try {
      const { client } = await this.lifecycle.stars.connection(connection.projectId);
      const until = connection.pollStartedAt ?? now;
      const page = await client.reports({
        limit: 50,
        offset: connection.pollOffset,
        from: new Date(until.getTime() - 7 * 86400000).toISOString().slice(0, 10),
        to: new Date(until.getTime() + 86400000).toISOString().slice(0, 10),
      });
      await this.db.$transaction(async (tx) => {
        const fenced = await tx.webinarConnection.updateMany({
          where: {
            id: connection.id,
            pollLockedBy: owner,
            revision: connection.revision,
            enabled: true,
          },
          data: {
            pollOffset: page.hasMore ? connection.pollOffset + 50 : 0,
            pollStartedAt: page.hasMore ? until : null,
            nextPollAt: new Date(Date.now() + (page.hasMore ? 5000 : 15 * 60000)),
            lastPollError: null,
            pollLockedBy: null,
            pollLockedUntil: null,
          },
        });
        if (!fenced.count) return;
        for (const item of page.items) {
          // Refresh mutable recent reports, but never erase a manual binding or live flag.
          await tx.webinarReportImport.upsert({
            where: {
              projectId_connectionId_externalReportId: {
                projectId: connection.projectId,
                connectionId: connection.id,
                externalReportId: item.id,
              },
            },
            create: {
              projectId: connection.projectId,
              connectionId: connection.id,
              externalReportId: item.id,
            },
            update: {},
          });
          await tx.webinarReportImport.updateMany({
            where: {
              projectId: connection.projectId,
              connectionId: connection.id,
              externalReportId: item.id,
              state: { in: ['COMPLETED', 'PARTIAL'] },
            },
            data: {
              state: 'PENDING',
              attempts: 0,
              nextAttemptAt: new Date(),
              requestedVersion: { increment: 1 },
            },
          });
        }
      });
    } catch (error) {
      await this.db.webinarConnection.updateMany({
        where: { id: connection.id, pollLockedBy: owner },
        data: {
          pollLockedBy: null,
          pollLockedUntil: null,
          nextPollAt: new Date(Date.now() + 60000),
          lastPollError: error instanceof WebinarStarsError ? error.code : 'WEBINAR_POLL_FAILED',
        },
      });
    }
  }
  async process(id: string) {
    const job = await this.db.webinarReportImport.findUnique({
      where: { id },
      include: { connection: true, event: true },
    });
    if (!job || !job.connection.connected || !job.connection.enabled) return;
    const owner = randomUUID(),
      now = new Date();
    const won = await this.db.webinarReportImport.updateMany({
      where: {
        id,
        nextAttemptAt: { lte: now },
        state: { in: ['PENDING', 'RETRY', 'PROCESSING'] },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: {
        lockedBy: owner,
        lockedUntil: new Date(Date.now() + 120000),
        state: 'PROCESSING',
        attempts: { increment: 1 },
      },
    });
    if (!won.count) return;
    try {
      const { client } = await this.lifecycle.stars.connection(job.projectId);
      const report = await client.report(job.externalReportId);
      if (
        report.visitorsCount !== null &&
        report.visitorsCount > 0 &&
        report.participants.length === 0
      )
        throw new WebinarStarsError('WEBINAR_REPORT_NOT_READY');
      let event = job.event;
      if (!event && job.origin !== 'MANUAL') {
        const candidates = await this.db.webinarEvent.findMany({
          where: {
            projectId: job.projectId,
            connectionId: job.connectionId,
            providerWebinarId: report.webinarId,
            cancelledAt: null,
          },
          take: 100,
        });
        const matched = candidates.filter((item) => {
          const at = localToUtc(report.startedAtLocal, item.timezone);
          return (
            at !== null &&
            at >= item.scheduledAt.getTime() - 30 * 60000 &&
            at < item.endsAt.getTime()
          );
        });
        if (matched.length === 1) event = matched[0]!;
      }
      // An operator may explicitly select a session to interpret a historical report
      // whose provider ID changed when a recording was created. This grants no live effects.
      const historicalBinding = job.origin === 'MANUAL' && job.historical;
      if (
        event &&
        (event.cancelledAt || (event.providerWebinarId !== report.webinarId && !historicalBinding))
      )
        throw new WebinarStarsError('WEBINAR_REPORT_EVENT_MISMATCH');
      const historical =
        job.origin === 'MANUAL'
          ? job.historical
          : !event || !job.connection.enabledAt || event.scheduledAt < job.connection.enabledAt;
      if (
        event &&
        report.participants.length === 0 &&
        job.attempts < 3 &&
        (await this.db.webinarInvitation.count({
          where: { projectId: job.projectId, eventId: event.id, cancelledAt: null },
        }))
      )
        throw new WebinarStarsError('WEBINAR_REPORT_NOT_READY');
      const config = settings(event?.settings),
        groups = groupVisits(report, config);
      const summary = {
        id: report.id,
        webinarId: report.webinarId,
        name: report.name,
        startedAtLocal: report.startedAtLocal,
        endedAtLocal: report.endedAtLocal,
        visitorsCount: report.visitorsCount,
        visitorsPeak: report.visitorsPeak,
      };
      const touched = new Set<string>();
      for (const [identityKey, visits] of groups) {
        await this.db.$transaction(
          async (tx) => {
            await this.fence(tx, id, owner, job.connectionId, job.connection.revision);
            const reportFrom = event ? localToUtc(report.startedAtLocal, event.timezone) : null;
            const reportTo = event ? localToUtc(report.endedAtLocal, event.timezone) : null;
            const interval =
              event &&
              reportFrom !== null &&
              reportTo !== null &&
              reportTo > reportFrom &&
              reportTo - reportFrom <= 7 * 86400000
                ? {
                    timezone: event.timezone,
                    scheduledAt: new Date(reportFrom),
                    endsAt: new Date(reportTo),
                  }
                : undefined;
            const normalized = normalizeAttendance(visits, config, interval);
            let old = await tx.webinarAttendance.findUnique({
              where: {
                projectId_importId_identityKey: {
                  projectId: job.projectId,
                  importId: id,
                  identityKey,
                },
              },
            });
            let contactId: string | null = old?.matchState === 'MANUAL' ? old.contactId : null,
              invitationId: string | null = old?.invitationId ?? null,
              reason =
                old?.matchState === 'MANUAL' ? (old.matchReason ?? 'MANUAL_MATCH') : 'NO_CONTACT';
            const trackingTokens = new Set(
              config.trackingParameter
                ? visits
                    .map((visit) =>
                      new URLSearchParams(visit.utm ?? '').get(config.trackingParameter!),
                    )
                    .filter(Boolean)
                : [],
            );
            const trackingConflict = trackingTokens.size > 1;
            if (trackingConflict && !contactId) reason = 'AMBIGUOUS_TRACKING';
            if (
              old?.matchState !== 'IGNORED' &&
              !contactId &&
              !trackingConflict &&
              normalized.trackingToken &&
              event
            ) {
              const invitation = await tx.webinarInvitation.findFirst({
                where: {
                  projectId: job.projectId,
                  eventId: event.id,
                  token: normalized.trackingToken,
                  cancelledAt: null,
                  contact: { status: 'ACTIVE' },
                },
              });
              if (invitation) {
                contactId = invitation.contactId;
                invitationId = invitation.id;
                reason = 'TRACKING_TOKEN';
              }
            }
            if (old?.matchState !== 'IGNORED' && !contactId && !trackingConflict) {
              const emails = [
                  ...new Set(
                    visits
                      .map((x) => emailIdentity(x.email))
                      .filter((x): x is string => Boolean(x)),
                  ),
                ],
                phones = [
                  ...new Set(
                    visits
                      .map((x) => phoneIdentity(x.phone))
                      .filter((x): x is string => Boolean(x)),
                  ),
                ];
              const candidates =
                emails.length || phones.length
                  ? await tx.contact.findMany({
                      where: {
                        projectId: job.projectId,
                        status: 'ACTIVE',
                        OR: [
                          ...(emails.length ? [{ normalizedEmail: { in: emails } }] : []),
                          ...(phones.length ? [{ normalizedPhone: { in: phones } }] : []),
                        ],
                      },
                      select: { id: true },
                      take: 3,
                    })
                  : [];
              if (candidates.length === 1 && emails.length <= 1 && phones.length <= 1) {
                contactId = candidates[0]!.id;
                reason = 'EXACT_IDENTITY';
              } else reason = candidates.length ? 'AMBIGUOUS_CONTACT' : 'NO_CONTACT';
            }
            if (contactId && event && !invitationId) {
              const invitation = await tx.webinarInvitation.findUnique({
                where: {
                  projectId_eventId_contactId: {
                    projectId: job.projectId,
                    eventId: event.id,
                    contactId,
                  },
                },
              });
              invitationId = invitation?.id ?? null;
            }
            const result = {
              ...normalized,
              webinar: {
                ...summary,
                eventId: event?.id ?? null,
                title: event?.title ?? report.name,
                scheduledAt: event?.scheduledAt.toISOString() ?? null,
                endsAt: event?.endsAt.toISOString() ?? null,
                timezone: event?.timezone ?? null,
              },
              distributorId: null as string | null,
            };
            if (invitationId) {
              const invitation = await tx.webinarInvitation.findUnique({
                where: { id: invitationId },
              });
              const distributor = object(invitation?.attribution).distributorId;
              result.distributorId = typeof distributor === 'string' ? distributor : null;
            }
            // Keep the manually resolved row and its operator decision on refresh.
            const stableIdentity =
              old?.matchState === 'MANUAL'
                ? old.identityKey
                : invitationId
                  ? `invitation:${invitationId}`
                  : contactId
                    ? `contact:${contactId}`
                    : identityKey;
            const previousIdentity = old;
            if (stableIdentity !== identityKey)
              old =
                (await tx.webinarAttendance.findUnique({
                  where: {
                    projectId_importId_identityKey: {
                      projectId: job.projectId,
                      importId: id,
                      identityKey: stableIdentity,
                    },
                  },
                })) ?? old;
            const hash = fingerprint(result),
              changed = !old || old.fingerprint !== hash;
            const attendance = await tx.webinarAttendance.upsert({
              where: {
                projectId_importId_identityKey: {
                  projectId: job.projectId,
                  importId: id,
                  identityKey: stableIdentity,
                },
              },
              create: {
                projectId: job.projectId,
                importId: id,
                identityKey: stableIdentity,
                contactId,
                invitationId,
                matchState: contactId ? 'MATCHED' : 'UNMATCHED',
                matchReason: reason,
                result: json(result),
                fingerprint: hash,
              },
              update: {
                ...(old?.matchState === 'IGNORED'
                  ? {}
                  : {
                      contactId,
                      invitationId,
                      matchState:
                        old?.matchState === 'MANUAL'
                          ? 'MANUAL'
                          : contactId
                            ? 'MATCHED'
                            : 'UNMATCHED',
                      matchReason: reason,
                    }),
                ...(changed
                  ? { result: json(result), fingerprint: hash, version: { increment: 1 } }
                  : {}),
              },
            });
            touched.add(attendance.id);
            if (previousIdentity && previousIdentity.id !== attendance.id)
              await tx.webinarAttendance.update({
                where: { id: previousIdentity.id },
                data: { matchState: 'IGNORED', matchReason: 'SUPERSEDED_BY_INVITATION_MATCH' },
              });
            if (contactId && !historical && old?.matchState !== 'IGNORED')
              await this.actions(tx, {
                projectId: job.projectId,
                contactId,
                attendanceId: attendance.id,
                version: attendance.version,
                hash,
                changed: changed && Boolean(old),
                crmEnabled: config.crmEnabled,
                payload: result,
              });
          },
          { timeout: 30000 },
        );
      }
      const ended = event ? localToUtc(report.endedAtLocal, event.timezone) : null;
      if (
        event &&
        ended !== null &&
        ended < Date.now() &&
        !historical &&
        (await this.db.webinarAttendance.count({
          where: { projectId: job.projectId, importId: id, matchState: 'UNMATCHED' },
        })) === 0
      ) {
        const invitations = await this.db.webinarInvitation.findMany({
          where: {
            projectId: job.projectId,
            eventId: event.id,
            cancelledAt: null,
            contact: { status: 'ACTIVE' },
          },
          take: 10000,
        });
        for (const invitation of invitations) {
          if (
            await this.db.webinarAttendance.findFirst({
              where: { projectId: job.projectId, importId: id, contactId: invitation.contactId },
            })
          )
            continue;
          await this.db.$transaction(async (tx) => {
            await this.fence(tx, id, owner, job.connectionId, job.connection.revision);
            const result = {
              status: 'MISSED',
              attended: false,
              completed: false,
              watchedMinutes: 0,
              watchedPercentage: 0,
              ctaClicked: null,
              bannerClicked: null,
              comments: [],
              commentsCount: 0,
              utm: Object.fromEntries(
                Object.entries(object(invitation.attribution)).filter(
                  ([key, value]) => key.startsWith('utm_') && typeof value === 'string',
                ),
              ),
              webinar: { ...summary, eventId: event!.id, title: event!.title },
              invitation: { id: invitation.id },
              distributorId: object(invitation.attribution).distributorId ?? null,
            };
            const identityKey = `invitation:${invitation.id}`,
              hash = fingerprint(result);
            const attendance = await tx.webinarAttendance.upsert({
              where: {
                projectId_importId_identityKey: {
                  projectId: job.projectId,
                  importId: id,
                  identityKey,
                },
              },
              create: {
                projectId: job.projectId,
                importId: id,
                identityKey,
                contactId: invitation.contactId,
                invitationId: invitation.id,
                matchState: 'MATCHED',
                matchReason: 'INVITED_ABSENT_FROM_FINAL_REPORT',
                result: json(result),
                fingerprint: hash,
              },
              update: {},
            });
            touched.add(attendance.id);
            await this.actions(tx, {
              projectId: job.projectId,
              contactId: invitation.contactId,
              attendanceId: attendance.id,
              version: attendance.version,
              hash,
              changed: false,
              crmEnabled: config.crmEnabled,
              payload: result,
            });
          });
        }
      }
      await this.db.$transaction(async (tx) => {
        await this.fence(tx, id, owner, job.connectionId, job.connection.revision);
        const current = await tx.webinarReportImport.findUniqueOrThrow({ where: { id } });
        const unmatched = await tx.webinarAttendance.count({
          where: { projectId: job.projectId, importId: id, matchState: 'UNMATCHED' },
        });
        await tx.webinarReportImport.updateMany({
          where: { id, lockedBy: owner },
          data: {
            eventId: event?.id ?? null,
            historical,
            summary: json(summary),
            fingerprint: fingerprint(report),
            state:
              current.requestedVersion !== job.requestedVersion
                ? 'PENDING'
                : unmatched
                  ? 'PARTIAL'
                  : 'COMPLETED',
            lastError: null,
            processedAt: new Date(),
            lockedBy: null,
            lockedUntil: null,
            nextAttemptAt: new Date(),
          },
        });
      });
    } catch (error) {
      const safe = error instanceof WebinarStarsError ? error.code : 'WEBINAR_IMPORT_FAILED';
      await this.db.webinarReportImport.updateMany({
        where: { id, lockedBy: owner },
        data: {
          state:
            job.attempts + 1 >= 8 ||
            ['WEBINAR_STARS_ACCESS_DENIED', 'WEBINAR_REPORT_EVENT_MISMATCH'].includes(safe)
              ? 'FAILED'
              : 'RETRY',
          lockedBy: null,
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** job.attempts)),
          lastError: safe,
        },
      });
    }
  }
  private async fence(
    tx: Prisma.TransactionClient,
    id: string,
    owner: string,
    connectionId: string,
    revision: number,
  ) {
    const updated = await tx.webinarReportImport.updateMany({
      where: {
        id,
        lockedBy: owner,
        connection: { id: connectionId, enabled: true, connected: true, revision },
      },
      data: { lockedUntil: new Date(Date.now() + 120000) },
    });
    if (!updated.count) throw new Error('WEBINAR_IMPORT_LEASE_LOST');
  }
  private async actions(
    tx: Prisma.TransactionClient,
    input: {
      projectId: string;
      contactId: string;
      attendanceId: string;
      version: number;
      hash: string;
      changed: boolean;
      crmEnabled: boolean;
      payload: Record<string, unknown>;
    },
  ) {
    const p = input.payload,
      events = [
        'WEBINAR_REPORT_RECEIVED',
        ...(p.attended === true
          ? ['WEBINAR_ATTENDED']
          : p.status === 'MISSED'
            ? ['WEBINAR_MISSED']
            : []),
        ...(p.completed === true
          ? ['WEBINAR_COMPLETED']
          : p.status === 'PARTIALLY_WATCHED'
            ? ['WEBINAR_PARTIALLY_WATCHED']
            : []),
        ...(p.ctaClicked === true ? ['WEBINAR_CTA_CLICKED'] : []),
        ...(p.bannerClicked === true ? ['WEBINAR_BANNER_CLICKED'] : []),
        ...(Number(p.commentsCount) > 0 ? ['WEBINAR_COMMENTED'] : []),
        ...(p.isReplay === true ? ['WEBINAR_REPLAY_VIEWED'] : []),
        ...(input.changed ? ['WEBINAR_REPORT_UPDATED'] : []),
      ];
    await tx.webinarAction.createMany({
      data: [
        ...events.map((eventType) => ({
          projectId: input.projectId,
          contactId: input.contactId,
          kind: 'AUTOMATION',
          eventType,
          dedupeKey: `attendance:${input.attendanceId}:${eventType}${eventType === 'WEBINAR_REPORT_UPDATED' ? `:${input.hash}` : ''}`,
          payload: json({
            ...p,
            attendanceId: input.attendanceId,
            version: input.version,
            type: eventType,
          }),
        })),
        ...(input.crmEnabled
          ? [
              {
                projectId: input.projectId,
                contactId: input.contactId,
                kind: 'CRM',
                eventType: 'WEBINAR_ACTIVITY',
                dedupeKey: `attendance:${input.attendanceId}:crm:${input.hash}`,
                payload: json({
                  ...p,
                  attendanceId: input.attendanceId,
                  revision: input.hash,
                  version: input.version,
                }),
              },
            ]
          : []),
      ],
      skipDuplicates: true,
    });
  }
}
