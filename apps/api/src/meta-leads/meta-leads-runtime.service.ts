import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Prisma, MetaLeadSubmission } from '@omnicus/database';
import { MetaGraphError, normalizeMetaLead, record } from './meta-graph.client';
import { json, MetaCrmBusyError, MetaLeadsService } from './meta-leads.service';

@Injectable()
export class MetaLeadsRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetaLeadsRuntimeService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(@Inject(MetaLeadsService) private readonly leads: MetaLeadsService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.poll();
      for (let count = 0; count < 10; count++) {
        const row = await this.claim();
        if (!row) break;
        await this.process(row);
      }
    } catch {
      // Never log raw Graph responses, contact data, tokens or request URLs.
      this.logger.warn('META_LEADS_PUMP_UNAVAILABLE');
    } finally {
      this.running = false;
    }
  }

  private get db() {
    return this.leads.database.client;
  }

  private async claim() {
    const now = new Date();
    const candidate = await this.db.metaLeadSubmission.findFirst({
      where: {
        state: { in: ['FETCH', 'READY', 'DELIVERING', 'UNKNOWN'] },
        nextAttemptAt: { lte: now },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        config: { enabled: true },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    });
    if (!candidate) return null;
    const owner = randomUUID();
    const result = await this.db.metaLeadSubmission.updateMany({
      where: {
        id: candidate.id,
        state: candidate.state,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: {
        lockedBy: owner,
        lockedUntil: new Date(Date.now() + 90_000),
        attempts: { increment: 1 },
      },
    });
    return result.count
      ? { ...candidate, attempts: candidate.attempts + 1, lockedBy: owner }
      : null;
  }

  private async update(
    row: MetaLeadSubmission,
    data: Prisma.MetaLeadSubmissionUpdateManyMutationInput,
  ) {
    await this.db.metaLeadSubmission.updateMany({
      where: { id: row.id, lockedBy: row.lockedBy },
      data: { ...data, lockedBy: null, lockedUntil: null },
    });
  }

  async process(row: MetaLeadSubmission) {
    let writing = row.state === 'DELIVERING' || row.state === 'UNKNOWN';
    try {
      let config = await this.leads.configuration(row.projectId);
      if (!config.enabled || !config.formIds.includes(row.formId)) {
        await this.update(row, { state: 'REVIEW', lastError: 'META_LEADS_ROUTE_DISABLED' });
        return;
      }
      if (writing) {
        const result = await this.leads.crm(row.projectId, 'reconcile', record(row.payload));
        await this.update(
          row,
          result.outcome === 'LINKED'
            ? { state: 'DONE', result: json(result), lastError: null }
            : {
                state: 'UNKNOWN',
                lastError: 'META_LEADS_CONFIRM_RETRY_REQUIRED',
                nextAttemptAt: new Date(Date.now() + 60_000),
              },
        );
        return;
      }
      const payload = row.payload
        ? record(row.payload)
        : await this.leads.graph(config).lead(row.leadId, row.pageId, row.formId);
      if (
        payload.leadId !== row.leadId ||
        payload.formId !== row.formId ||
        payload.pageId !== row.pageId
      )
        throw new MetaGraphError('META_LEAD_ID_MISMATCH');
      const historical =
        row.historical ||
        !config.liveFrom ||
        Date.parse(String(payload.createdAt)) < config.liveFrom.getTime();
      // Freeze normalized fields before the first external write; later retries reuse them.
      await this.db.metaLeadSubmission.updateMany({
        where: { id: row.id, lockedBy: row.lockedBy },
        data: { payload: json(payload), historical, state: 'READY' },
      });
      const result = await this.leads.crm(row.projectId, 'preview', payload);
      if (result.outcome === 'REVIEW') {
        await this.update(row, { state: 'REVIEW', result: json(result), lastError: null });
        return;
      }
      if (result.outcome === 'LINKED') {
        await this.update(row, { state: 'DONE', result: json(result), lastError: null });
        return;
      }
      config = await this.leads.configuration(row.projectId);
      const deliver = config.enabled && (row.approved || (!historical && config.deliveryEnabled));
      if (!deliver) {
        await this.update(row, {
          state: result.outcome === 'NEW' ? 'PREVIEW_NEW' : 'PREVIEW_MATCH',
          result: json(result),
          historical,
          lastError: null,
        });
        return;
      }
      const notify = !historical && !row.approved && result.outcome === 'NEW';
      const frozen = { ...payload, notify };
      const claimed = await this.db.metaLeadSubmission.updateMany({
        where: { id: row.id, lockedBy: row.lockedBy, lockedUntil: { gt: new Date() } },
        data: { state: 'DELIVERING', notify, payload: json(frozen) },
      });
      if (!claimed.count) return;
      writing = true;
      const applied = await this.leads.crm(row.projectId, 'apply', frozen);
      await this.update(row, {
        state: applied.outcome === 'REVIEW' ? 'REVIEW' : 'DONE',
        result: json(applied),
        lastError: null,
      });
    } catch (error) {
      if (error instanceof MetaCrmBusyError) writing = false;
      const code =
        error instanceof MetaGraphError
          ? error.code
          : error instanceof MetaCrmBusyError
            ? 'META_LEADS_CRM_BUSY'
            : 'META_LEADS_PROCESSING_FAILED';
      await this.update(row, {
        state: writing ? 'UNKNOWN' : row.attempts >= 12 ? 'ERROR' : row.payload ? 'READY' : 'FETCH',
        lastError: code,
        nextAttemptAt: new Date(
          Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(row.attempts, 6)),
        ),
      });
    }
  }

  async poll() {
    const now = new Date();
    const poll = await this.db.metaLeadPoll.findFirst({
      where: {
        completed: false,
        nextAttemptAt: { lte: now },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        config: { enabled: true },
      },
      orderBy: { nextAttemptAt: 'asc' },
    });
    if (!poll) return;
    const owner = randomUUID();
    const claimed = await this.db.metaLeadPoll.updateMany({
      where: { id: poll.id, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: { lockedBy: owner, lockedUntil: new Date(Date.now() + 90_000) },
    });
    if (!claimed.count) return;
    try {
      const config = await this.leads.configuration(poll.projectId);
      if (!config.formIds.includes(poll.formId)) {
        await this.db.metaLeadPoll.updateMany({
          where: { id: poll.id, lockedBy: owner },
          data: {
            completed: true,
            lastError: 'META_LEADS_FORM_DISABLED',
            lockedBy: null,
            lockedUntil: null,
          },
        });
        return;
      }
      const page = await this.leads.graph(config).page(poll.formId, poll.cursor);
      const rows: Prisma.MetaLeadSubmissionCreateManyInput[] = [];
      for (const item of page.items) {
        const payload = normalizeMetaLead(item, config.pageId, poll.formId);
        const time = Date.parse(payload.createdAt);
        if (time < poll.from.getTime() || (poll.until && time >= poll.until.getTime())) continue;
        rows.push({
          configId: config.id,
          projectId: config.projectId,
          pageId: config.pageId,
          formId: poll.formId,
          leadId: payload.leadId,
          payload: json(payload),
          state: 'READY',
          historical: poll.historical,
        });
      }
      // Cursor advances only atomically with all page receipts, including on restart.
      await this.db.$transaction(async (tx) => {
        const owned = await tx.metaLeadPoll.updateMany({
          where: { id: poll.id, lockedBy: owner, lockedUntil: { gt: new Date() } },
          data: {
            cursor: page.after,
            completed: !page.after && poll.historical,
            lastError: null,
            nextAttemptAt: new Date(Date.now() + (page.after ? 1_000 : 300_000)),
            lockedBy: null,
            lockedUntil: null,
          },
        });
        if (owned.count)
          await tx.metaLeadSubmission.createMany({ data: rows, skipDuplicates: true });
      });
    } catch (error) {
      await this.db.metaLeadPoll.updateMany({
        where: { id: poll.id, lockedBy: owner },
        data: {
          lastError: error instanceof MetaGraphError ? error.code : 'META_LEADS_POLL_FAILED',
          nextAttemptAt: new Date(Date.now() + 300_000),
          lockedBy: null,
          lockedUntil: null,
        },
      });
    }
  }
}
