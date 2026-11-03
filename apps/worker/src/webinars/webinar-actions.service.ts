import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CrmClientError } from '@omnicus/crm-core';
import { object } from '@omnicus/webinar-core';
import { DatabaseService } from '../database/database.service';
import { AutomationRuntimeService } from '../automation/automation-runtime.service';
import { ProjectCrmClient } from '../crm/project-crm.client';

@Injectable()
export class WebinarActionsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(WebinarActionsService.name);
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AutomationRuntimeService) private readonly automation: AutomationRuntimeService,
    @Inject(ProjectCrmClient) private readonly crm: ProjectCrmClient,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 3000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const rows = await this.database.client.webinarAction.findMany({
        where: {
          project: { webinarConnection: { is: { enabled: true, connected: true } } },
          state: { in: ['PENDING', 'RETRY', 'PROCESSING', 'UNKNOWN'] },
          attempts: { lt: 8 },
          dueAt: { lte: now },
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      for (const row of rows) await this.process(row.id);
    } catch {
      this.logger.warn('WEBINAR_ACTION_PUMP_UNAVAILABLE');
    } finally {
      this.running = false;
    }
  }
  async process(id: string) {
    const db = this.database.client,
      row = await db.webinarAction.findUnique({ where: { id } });
    if (
      !row ||
      row.attempts >= 8 ||
      !['PENDING', 'RETRY', 'PROCESSING', 'UNKNOWN'].includes(row.state) ||
      row.dueAt > new Date()
    )
      return;
    const connection = await db.webinarConnection.findUnique({
      where: { projectId: row.projectId },
    });
    if (!connection?.enabled || !connection.connected) return;
    const owner = randomUUID(),
      now = new Date(),
      previous = row.state;
    const won = await db.webinarAction.updateMany({
      where: { id, state: previous, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: {
        state: 'PROCESSING',
        lockedBy: owner,
        lockedUntil: new Date(Date.now() + 120000),
        attempts: { increment: 1 },
      },
    });
    if (!won.count) return;
    let externalStarted = false;
    let mustReconcile = previous === 'UNKNOWN' || (previous === 'PROCESSING' && row.kind === 'CRM');
    try {
      const payload = object(row.payload),
        webinar = object(payload.webinar),
        eventId = typeof webinar.eventId === 'string' ? webinar.eventId : null;
      const event = eventId
        ? await db.webinarEvent.findFirst({
            where: { id: eventId, projectId: row.projectId },
            include: {
              imports: {
                where: { state: { in: ['COMPLETED', 'PARTIAL'] } },
                select: { id: true },
                take: 1,
              },
            },
          })
        : null;
      const invitation = object(payload.invitation);
      const cancelledInvitation =
        typeof invitation.id === 'string'
          ? await db.webinarInvitation.findFirst({
              where: { id: invitation.id, projectId: row.projectId, cancelledAt: { not: null } },
            })
          : null;
      if (
        event?.cancelledAt ||
        cancelledInvitation ||
        (['WEBINAR_REMINDER', 'WEBINAR_STARTED'].includes(row.eventType) &&
          (!event ||
            event.imports.length ||
            event.endsAt < now ||
            (row.eventType === 'WEBINAR_REMINDER' && event.scheduledAt <= now)))
      ) {
        await db.webinarAction.updateMany({
          where: { id, lockedBy: owner },
          data: {
            state: 'CANCELLED',
            lastError: 'WEBINAR_SESSION_FINISHED_OR_CANCELLED',
            lockedBy: null,
            lockedUntil: null,
          },
        });
        return;
      }
      if (row.kind === 'AUTOMATION') {
        await this.automation.triggerWebinar(id, owner);
        return;
      }
      const route = await db.crmProjectConfig.findUnique({ where: { projectId: row.projectId } });
      if (
        !route?.enabled ||
        route.status !== 'ACTIVE' ||
        object(route.capabilities).webinarContractVersion !== 'webinars/v1'
      )
        throw new CrmClientError('PERMANENT_FAILURE', 'crm_webinar_contract_not_ready');
      const contact = await db.contact.findUnique({
        where: { projectId_id: { projectId: row.projectId, id: row.contactId } },
      });
      if (!contact?.crmLeadId)
        throw new CrmClientError('RETRYABLE_FAILURE', 'crm_webinar_contact_not_linked');
      const context = {
        projectId: row.projectId,
        crmProjectId: route.crmProjectId,
        idempotencyKey: `webinar:${row.id}`,
        correlationId: `webinar:${row.id}`,
      };
      if (mustReconcile) {
        const reconciled = await this.crm.reconcile(context);
        if (reconciled.status === 'SUCCEEDED') {
          await db.webinarAction.updateMany({
            where: { id, lockedBy: owner },
            data: {
              state: 'SUCCEEDED',
              completedAt: new Date(),
              lastError: null,
              lockedBy: null,
              lockedUntil: null,
            },
          });
          return;
        }
        if (reconciled.status === 'PROCESSING')
          throw new CrmClientError('UNKNOWN', 'crm_operation_in_progress');
        if (reconciled.status === 'FAILED')
          throw new CrmClientError(
            'PERMANENT_FAILURE',
            reconciled.errorCode ?? 'crm_operation_failed',
          );
        mustReconcile = false;
      }
      const result = Object.fromEntries(
        [
          'status',
          'attended',
          'watchedMinutes',
          'watchedPercentage',
          'completed',
          'ctaClicked',
          'bannerClicked',
          'comments',
          'commentsCount',
          'utm',
          'distributorId',
          'webinar',
        ]
          .filter((k) => payload[k] !== undefined)
          .map((k) => [k, payload[k]]),
      );
      externalStarted = true;
      await this.crm.forwardWebinarActivity(context, {
        contactId: row.contactId,
        activityId: String(payload.attendanceId),
        version: typeof payload.version === 'number' ? payload.version : 1,
        reportedAt: row.createdAt.toISOString(),
        result,
        ...(row.eventType === 'WEBINAR_COMMAND' ? { command: object(payload.command) } : {}),
      });
      await db.webinarAction.updateMany({
        where: { id, lockedBy: owner },
        data: {
          state: 'SUCCEEDED',
          completedAt: new Date(),
          lastError: null,
          lockedBy: null,
          lockedUntil: null,
        },
      });
    } catch (error) {
      const classified =
        error instanceof CrmClientError
          ? error.outcome
          : externalStarted
            ? 'UNKNOWN'
            : 'RETRYABLE_FAILURE';
      const outcome = mustReconcile && classified !== 'PERMANENT_FAILURE' ? 'UNKNOWN' : classified;
      const safe =
        error instanceof CrmClientError
          ? error.safeCode
          : error instanceof Error && /^[a-z_]{1,100}$/.test(error.message)
            ? error.message
            : 'WEBINAR_ACTION_FAILED';
      await db.webinarAction.updateMany({
        where: { id, lockedBy: owner },
        data: {
          state:
            outcome === 'UNKNOWN'
              ? 'UNKNOWN'
              : outcome === 'PERMANENT_FAILURE' || row.attempts + 1 >= 8
                ? 'FAILED'
                : 'RETRY',
          dueAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** row.attempts)),
          lastError: safe,
          lockedBy: null,
          lockedUntil: null,
        },
      });
    }
  }
}
