import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebinarLifecycleService } from './webinar-lifecycle.service';
import { WebinarImportRuntimeService } from './webinar-import-runtime.service';
import { defaultWebinarSettings, type ProviderReport } from '@omnicus/webinar-core';

function fixture() {
  const connection = {
    id: 'connection',
    projectId: 'project',
    connected: true,
    enabled: true,
    enabledAt: new Date('2026-11-01T00:00:00Z'),
    revision: 1,
  };
  const event = {
    id: 'event',
    projectId: 'project',
    connectionId: 'connection',
    providerWebinarId: '7',
    title: 'Test',
    timezone: 'Asia/Baku',
    scheduledAt: new Date('2026-11-03T06:00:00Z'),
    endsAt: new Date('2026-11-03T07:00:00Z'),
    cancelledAt: null as Date | null,
    settings: { ...defaultWebinarSettings, clickStatuses: ['clicked'], crmEnabled: true },
  };
  const job = {
    id: 'job',
    projectId: 'project',
    connectionId: 'connection',
    externalReportId: '42',
    eventId: 'event' as string | null,
    summary: null as unknown,
    origin: 'MANUAL',
    historical: false,
    state: 'PENDING',
    attempts: 0,
    requestedVersion: 1,
    lockedBy: null as string | null,
    lockedUntil: null as Date | null,
    nextAttemptAt: new Date(0),
  };
  const report: ProviderReport = {
    id: '42',
    webinarId: '7',
    name: 'Test',
    startedAtLocal: '2026-11-03 10:00:00',
    endedAtLocal: '2026-11-03 11:00:00',
    visitorsCount: 1,
    visitorsPeak: 1,
    participants: [
      {
        rowKey: '0',
        visitorId: '-7',
        name: 'Viewer',
        email: 'viewer@example.test',
        phone: null,
        joinedAtLocal: '2026-11-03 10:05:00',
        leftAtLocal: '2026-11-03 10:55:00',
        utm: null,
        device: null,
        country: null,
        city: null,
        actions: [{ type: 'button_1', status: 'clicked', label: 'Click', showNumber: 1 }],
        comments: [{ atLocal: null, text: 'Question' }],
      },
    ],
  };
  const attendances = new Map<string, Record<string, unknown>>(),
    actions = new Map<string, Record<string, unknown>>();
  const contacts = [{ id: 'contact' }];
  const db = {
    webinarReportImport: {
      findUnique: vi.fn(async () => ({
        ...job,
        connection: { ...connection },
        event: job.eventId ? event : null,
      })),
      findUniqueOrThrow: vi.fn(async () => ({ ...job })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (where.lockedBy && where.lockedBy !== job.lockedBy) return { count: 0 };
          const scope = where.connection as { revision?: number } | undefined;
          if (scope?.revision && scope.revision !== connection.revision) return { count: 0 };
          if (where.OR && job.lockedUntil && job.lockedUntil > new Date()) return { count: 0 };
          const updates = Object.fromEntries(
            Object.entries(data).map(([key, value]) => [
              key,
              value && typeof value === 'object' && 'increment' in value
                ? Number(job[key as keyof typeof job]) + Number(value.increment)
                : value,
            ]),
          );
          Object.assign(job, updates);
          return { count: 1 };
        },
      ),
    },
    webinarEvent: {
      findMany: vi.fn(async ({ where }: { where: { providerWebinarId: string } }) =>
        where.providerWebinarId === event.providerWebinarId ? [event] : [],
      ),
    },
    webinarWebhookReceipt: {
      findMany: vi.fn(async (): Promise<Array<{ id: string; metadata: unknown }>> => []),
    },
    webinarAttendance: {
      findUnique: vi.fn(
        async ({ where }: { where: { projectId_importId_identityKey: { identityKey: string } } }) =>
          attendances.get(where.projectId_importId_identityKey.identityKey) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { projectId_importId_identityKey: { identityKey: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const key = where.projectId_importId_identityKey.identityKey,
            old = attendances.get(key);
          const row = old
            ? {
                ...old,
                ...update,
                version: typeof update.version === 'object' ? Number(old.version) + 1 : old.version,
              }
            : { ...create, id: `attendance-${attendances.size}`, version: 1 };
          attendances.set(key, row);
          return row;
        },
      ),
      count: vi.fn(
        async ({ where }: { where: { matchState?: string } }) =>
          [...attendances.values()].filter(
            (row) => !where.matchState || row.matchState === where.matchState,
          ).length,
      ),
      findFirst: vi.fn(async () => null),
      update: vi.fn(),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { identityKey: string; matchState: string };
          data: Record<string, unknown>;
        }) => {
          const row = attendances.get(where.identityKey);
          if (!row || row.matchState !== where.matchState) return { count: 0 };
          Object.assign(row, data, { version: Number(row.version) + 1 });
          return { count: 1 };
        },
      ),
    },
    contact: { findMany: vi.fn(async () => contacts) },
    webinarInvitation: {
      findUnique: vi.fn(
        async (): Promise<{ id: string; attribution: Record<string, unknown> } | null> => null,
      ),
      findFirst: vi.fn(
        async (): Promise<{
          id: string;
          contactId?: string;
          attribution?: Record<string, unknown>;
        } | null> => null,
      ),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    webinarAction: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const row of data) {
          const key = `${row.kind}:${row.dedupeKey}`;
          if (!actions.has(key)) actions.set(key, row);
        }
        return { count: data.length };
      }),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(db),
  );
  const provider = { report: vi.fn(async () => report) };
  const lifecycle = {
    database: { client: db },
    stars: { connection: vi.fn(async () => ({ row: connection, client: provider })) },
  } as unknown as WebinarLifecycleService;
  const runtime = new WebinarImportRuntimeService(lifecycle);
  const refresh = () => {
    Object.assign(job, {
      state: 'PENDING',
      lockedBy: null,
      lockedUntil: null,
      nextAttemptAt: new Date(0),
      attempts: 0,
      requestedVersion: job.requestedVersion + 1,
    });
  };
  return {
    runtime,
    job,
    report,
    event,
    connection,
    contacts,
    provider,
    attendances,
    actions,
    db,
    refresh,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
describe('durable webinar import', () => {
  it('automatically binds a recording report using its scoped completion receipt and keeps proof on refresh', async () => {
    const f = fixture();
    f.job.origin = 'POLL';
    f.job.eventId = null;
    f.report.webinarId = '8';
    f.db.webinarWebhookReceipt.findMany.mockResolvedValue([
      {
        id: 'receipt',
        metadata: {
          id: '42',
          webinar_id: '7',
          date_start: f.report.startedAtLocal,
          date_end: f.report.endedAtLocal,
        },
      },
    ]);
    await f.runtime.process('job');
    expect(f.job).toMatchObject({
      state: 'COMPLETED',
      eventId: 'event',
      historical: false,
      summary: {
        webinarId: '8',
        bindingProof: { receiptId: 'receipt', sourceWebinarId: '7', reportId: '42' },
      },
    });
    expect(f.db.webinarWebhookReceipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: 'project',
          connectionId: 'connection',
          metadata: { path: ['id'], equals: '42' },
        },
      }),
    );
    const count = f.actions.size;
    f.db.webinarWebhookReceipt.findMany.mockResolvedValue([]);
    f.refresh();
    await f.runtime.process('job');
    expect(f.job.state).toBe('COMPLETED');
    expect(f.actions.size).toBe(count);
  });
  it('does not use a receipt for a different report window', async () => {
    const f = fixture();
    f.report.webinarId = '8';
    f.db.webinarWebhookReceipt.findMany.mockResolvedValue([
      {
        id: 'receipt',
        metadata: {
          id: '42',
          webinar_id: '7',
          date_start: f.report.startedAtLocal,
          date_end: '2026-11-03 10:59:59',
        },
      },
    ]);
    await f.runtime.process('job');
    expect(f.job.state).toBe('FAILED');
    expect(f.actions.size).toBe(0);
  });
  it('blocks conflicting completion references before creating attendance or effects', async () => {
    const f = fixture();
    f.db.webinarWebhookReceipt.findMany.mockResolvedValue(
      ['7', '9'].map((source) => ({
        id: 'receipt-' + source,
        metadata: {
          id: '42',
          webinar_id: source,
          date_start: f.report.startedAtLocal,
          date_end: f.report.endedAtLocal,
        },
      })),
    );
    await f.runtime.process('job');
    expect(f.job.state).toBe('FAILED');
    expect(f.attendances.size).toBe(0);
    expect(f.actions.size).toBe(0);
  });
  it('ignores previously imported unmatched visits from older sessions in the same room', async () => {
    const f = fixture();
    f.job.historical = true;
    f.job.eventId = null;
    f.contacts.splice(0);
    f.report.participants[0]!.joinedAtLocal = '2026-11-03 09:00:00';
    f.report.participants[0]!.leftAtLocal = '2026-11-03 09:59:00';
    await f.runtime.process('job');
    expect(f.job.state).toBe('PARTIAL');
    f.job.eventId = 'event';
    f.refresh();
    await f.runtime.process('job');
    expect([...f.attendances.values()][0]).toMatchObject({
      matchState: 'IGNORED',
      matchReason: 'OUTSIDE_REPORT_WINDOW',
    });
    expect(f.job.state).toBe('COMPLETED');
    expect(f.actions.size).toBe(0);
  });
  it.each([null, '-1-11-30 01:00:00', '2026-11-04 11:00:00'])(
    'waits for a completed valid report window before live effects (end=%s)',
    async (endedAtLocal) => {
      const f = fixture();
      f.report.endedAtLocal = endedAtLocal;
      await f.runtime.process('job');
      expect(f.job).toMatchObject({ state: 'RETRY', lastError: 'WEBINAR_REPORT_NOT_READY' });
      expect(f.attendances.size).toBe(0);
      expect(f.actions.size).toBe(0);
    },
  );
  it('normalizes and matches a live report once, and re-imports do not repeat semantic actions', async () => {
    const f = fixture();
    await f.runtime.process('job');
    expect([...f.attendances.values()][0]).toMatchObject({
      contactId: 'contact',
      matchState: 'MATCHED',
      result: { watchedMinutes: 50, ctaClicked: true },
    });
    expect(f.job.state).toBe('COMPLETED');
    const count = f.actions.size;
    expect([...f.actions.values()].some((row) => row.kind === 'CRM')).toBe(true);
    f.refresh();
    await f.runtime.process('job');
    expect(f.actions.size).toBe(count);
    expect(f.attendances.size).toBe(1);
  });
  it('keeps conflicting contacts unmatched and creates no delivery intents', async () => {
    const f = fixture();
    f.contacts.push({ id: 'another' });
    await f.runtime.process('job');
    expect([...f.attendances.values()][0]).toMatchObject({
      contactId: null,
      matchState: 'UNMATCHED',
      matchReason: 'AMBIGUOUS_CONTACT',
    });
    expect(f.job.state).toBe('PARTIAL');
    expect(f.actions.size).toBe(0);
  });
  it('imports historical data without automation or CRM effects', async () => {
    const f = fixture();
    f.job.historical = true;
    await f.runtime.process('job');
    expect(f.attendances.size).toBe(1);
    expect(f.actions.size).toBe(0);
  });
  it('uses an explicitly selected session for a historical report with a different provider ID', async () => {
    const f = fixture();
    f.job.historical = true;
    f.report.webinarId = '8';
    await f.runtime.process('job');
    expect(f.job.state).toBe('COMPLETED');
    expect([...f.attendances.values()][0]).toMatchObject({
      contactId: 'contact',
      result: {
        watchedMinutes: 50,
        ctaClicked: true,
        commentsCount: 1,
        webinar: { webinarId: '8', eventId: 'event' },
      },
    });
    expect(f.actions.size).toBe(0);
    f.refresh();
    await f.runtime.process('job');
    expect(f.job.state).toBe('COMPLETED');
    expect(f.attendances.size).toBe(1);
    expect(f.actions.size).toBe(0);
  });
  it('preserves a manually matched row and invitation across changed report refreshes', async () => {
    const f = fixture();
    f.job.historical = true;
    f.contacts.splice(0);
    await f.runtime.process('job');
    const original = [...f.attendances.values()][0]!;
    Object.assign(original, {
      contactId: 'contact',
      matchState: 'MANUAL',
      matchReason: 'MANUAL_MATCH',
    });
    f.db.webinarInvitation.findUnique.mockResolvedValue({
      id: 'invitation',
      attribution: {},
    });
    for (const minute of ['45', '40']) {
      f.report.participants[0]!.leftAtLocal = `2026-11-03 10:${minute}:00`;
      f.refresh();
      await f.runtime.process('job');
      expect(f.job.state).toBe('COMPLETED');
      expect(f.attendances.size).toBe(1);
      expect([...f.attendances.values()][0]).toMatchObject({
        id: original.id,
        contactId: 'contact',
        invitationId: 'invitation',
        matchState: 'MANUAL',
        matchReason: 'MANUAL_MATCH',
        result: { watchedMinutes: Number(minute) - 5, ctaClicked: true },
      });
      expect(f.actions.size).toBe(0);
    }
  });
  it.each([
    ['MANUAL', false],
    ['POLL', true],
    ['WEBHOOK', true],
  ])(
    'rejects a different provider ID for origin %s with historical=%s',
    async (origin, historical) => {
      const f = fixture();
      f.job.origin = origin;
      f.job.historical = historical;
      f.report.webinarId = '8';
      await f.runtime.process('job');
      expect(f.job).toMatchObject({ state: 'FAILED', lastError: 'WEBINAR_REPORT_EVENT_MISMATCH' });
      expect(f.attendances.size).toBe(0);
      expect(f.actions.size).toBe(0);
    },
  );
  it('rejects cancelled sessions even for an explicitly bound historical report', async () => {
    const f = fixture();
    f.job.historical = true;
    f.event.cancelledAt = new Date();
    await f.runtime.process('job');
    expect(f.job).toMatchObject({ state: 'FAILED', lastError: 'WEBINAR_REPORT_EVENT_MISMATCH' });
    expect(f.attendances.size).toBe(0);
    expect(f.actions.size).toBe(0);
  });
  it('keeps conflicting tracking invitations for manual review even when email matches', async () => {
    const f = fixture();
    f.event.settings.trackingParameter = 'cv';
    f.report.participants[0]!.utm = 'cv=first-invitation';
    f.report.participants.push({
      ...f.report.participants[0]!,
      rowKey: '1',
      utm: 'cv=another-invitation',
    });
    await f.runtime.process('job');
    expect([...f.attendances.values()][0]).toMatchObject({
      contactId: null,
      matchState: 'UNMATCHED',
      matchReason: 'AMBIGUOUS_TRACKING',
    });
    expect(f.actions.size).toBe(0);
    expect(f.job.state).toBe('PARTIAL');
  });
  it('restores invitation marketing attribution and distributor separately from provider tracking', async () => {
    const f = fixture();
    const token = 'a'.repeat(48);
    f.event.settings.trackingParameter = 'utm_campaign';
    f.report.participants[0]!.utm = `utm_campaign=${token}&utm_source=provider-source`;
    f.db.webinarInvitation.findFirst.mockResolvedValue({
      id: 'invitation',
      contactId: 'contact',
      attribution: {
        utm_campaign: 'real-campaign',
        utm_medium: 'email',
        distributorId: 'partner-7',
      },
    });
    await f.runtime.process('job');
    expect([...f.attendances.values()][0]).toMatchObject({
      matchReason: 'TRACKING_TOKEN',
      result: {
        utm: { utm_campaign: 'real-campaign', utm_source: 'provider-source', utm_medium: 'email' },
        distributorId: 'partner-7',
      },
    });
    expect(f.db.webinarInvitation.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'invitation', projectId: 'project', eventId: 'event' },
    });
    for (const action of f.actions.values())
      expect(JSON.stringify((action.payload as Record<string, unknown>).utm)).not.toContain(token);
  });
  it('fences a stale result when credentials change during the provider request', async () => {
    const f = fixture();
    f.provider.report.mockImplementation(async () => {
      f.connection.revision = 2;
      return f.report;
    });
    await f.runtime.process('job');
    expect(f.attendances.size).toBe(0);
    expect(f.actions.size).toBe(0);
    expect(f.job.state).toBe('RETRY');
  });
  it('retains the activity identity and increments the CRM revision when a report changes', async () => {
    const f = fixture();
    await f.runtime.process('job');
    const id = [...f.attendances.values()][0]!.id;
    f.report.participants[0]!.leftAtLocal = '2026-11-03 10:45:00';
    f.refresh();
    await f.runtime.process('job');
    expect(f.attendances.size).toBe(1);
    expect([...f.attendances.values()][0]).toMatchObject({ id, version: 2 });
    const deliveries = [...f.actions.values()].filter((row) => row.kind === 'CRM');
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]!.payload).toMatchObject({ version: 2 });
    expect(
      [...f.actions.values()].filter((row) => row.eventType === 'WEBINAR_ATTENDED'),
    ).toHaveLength(1);
  });
  it('does not fetch an import that is already leased by another worker', async () => {
    const f = fixture();
    f.job.lockedBy = 'other';
    f.job.lockedUntil = new Date(Date.now() + 60000);
    f.job.state = 'PROCESSING';
    await f.runtime.process('job');
    expect(f.provider.report).not.toHaveBeenCalled();
  });
});
