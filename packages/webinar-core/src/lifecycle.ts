import { createHash } from 'node:crypto';
import type { WebinarStarsClient } from './client';

export type ProviderReport = Awaited<ReturnType<WebinarStarsClient['report']>>;
export type ProviderVisit = ProviderReport['participants'][number];
export const webinarTriggers = [
  'WEBINAR_REGISTERED',
  'WEBINAR_REMINDER',
  'WEBINAR_STARTED',
  'WEBINAR_REPORT_RECEIVED',
  'WEBINAR_REPORT_UPDATED',
  'WEBINAR_ATTENDED',
  'WEBINAR_MISSED',
  'WEBINAR_COMPLETED',
  'WEBINAR_PARTIALLY_WATCHED',
  'WEBINAR_CTA_CLICKED',
  'WEBINAR_BANNER_CLICKED',
  'WEBINAR_COMMENTED',
  'WEBINAR_REPLAY_VIEWED',
] as const;
export type WebinarTrigger = (typeof webinarTriggers)[number];
export interface WebinarSettings {
  parameters: Record<string, string>;
  constants: Record<string, string>;
  trackingParameter: string | null;
  clickStatuses: string[];
  seenStatuses: string[];
  reminderMinutes: number[];
  completedPercentage: number;
  crmEnabled: boolean;
  replay: boolean | null;
  registrationSourceKey: string | null;
}
export const defaultWebinarSettings: WebinarSettings = {
  parameters: {},
  constants: {},
  trackingParameter: null,
  clickStatuses: [],
  seenStatuses: [],
  reminderMinutes: [1440, 60, 10],
  completedPercentage: 90,
  crmEnabled: false,
  replay: null,
  registrationSourceKey: null,
};
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export const emailIdentity = (value: string | null) => value?.trim().toLowerCase() || null;
export const phoneIdentity = (value: string | null) => {
  const digits = value?.replace(/\D/g, '') ?? '';
  return /^\d{6,15}$/.test(digits) ? digits : null;
};
export function settings(value: unknown): WebinarSettings {
  return { ...defaultWebinarSettings, ...object(value) } as WebinarSettings;
}
export function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
// Offset-less provider dates are interpreted only in an explicitly selected IANA zone.
// Ambiguous/missing DST times stay unknown instead of inventing a timestamp.
export function localToUtc(value: string | null, timezone: string): number | null {
  if (!value || !validTimezone(timezone)) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const target = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  );
  const expected = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  if (new Date(target).toISOString().replace('T', ' ').slice(0, 19) !== expected) return null;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const wall = (instant: number) => {
    const p = Object.fromEntries(formatter.formatToParts(instant).map((x) => [x.type, x.value]));
    return Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
  };
  let candidate = target;
  for (let i = 0; i < 4; i++) candidate += target - wall(candidate);
  if (
    wall(candidate) !== target ||
    wall(candidate - 3600000) === target ||
    wall(candidate + 3600000) === target
  )
    return null;
  return candidate;
}
export function watchedSeconds(
  visits: ProviderVisit[],
  timezone: string,
  start: Date,
  end: Date,
): number | null {
  const intervals: Array<[number, number]> = [];
  for (const visit of visits) {
    const from = localToUtc(visit.joinedAtLocal, timezone),
      to = localToUtc(visit.leftAtLocal, timezone);
    if (from === null || to === null || to < from) return null;
    const lo = Math.max(from, start.getTime()),
      hi = Math.min(to, end.getTime());
    if (hi > lo) intervals.push([lo, hi]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0,
    until = -Infinity;
  for (const [from, to] of intervals) {
    total += Math.max(0, to - Math.max(from, until));
    until = Math.max(until, to);
  }
  return Math.floor(total / 1000);
}

export interface WebinarReportBinding {
  receiptId: string;
  reportId: string;
  reportWebinarId: string;
  sourceWebinarId: string;
  startedAtLocal: string;
  endedAtLocal: string;
}

export function reportBindingFromWebhooks(
  report: ProviderReport,
  receipts: Array<{ id: string; metadata: unknown }>,
  persisted: unknown,
): { binding: WebinarReportBinding | null; conflict: boolean } {
  const bindings: WebinarReportBinding[] = [];
  const saved = object(persisted);
  if (
    typeof saved.receiptId === 'string' &&
    saved.reportId === report.id &&
    saved.reportWebinarId === report.webinarId &&
    typeof saved.sourceWebinarId === 'string' &&
    /^\d{1,30}$/.test(saved.sourceWebinarId) &&
    report.startedAtLocal &&
    report.endedAtLocal &&
    saved.startedAtLocal === report.startedAtLocal &&
    saved.endedAtLocal === report.endedAtLocal
  )
    bindings.push({
      receiptId: saved.receiptId,
      reportId: report.id,
      reportWebinarId: report.webinarId,
      sourceWebinarId: saved.sourceWebinarId,
      startedAtLocal: report.startedAtLocal,
      endedAtLocal: report.endedAtLocal,
    });
  for (const receipt of receipts) {
    const metadata = object(receipt.metadata);
    if (
      metadata.id === report.id &&
      typeof metadata.webinar_id === 'string' &&
      /^\d{1,30}$/.test(metadata.webinar_id) &&
      report.startedAtLocal &&
      report.endedAtLocal &&
      metadata.date_start === report.startedAtLocal &&
      metadata.date_end === report.endedAtLocal
    )
      bindings.push({
        receiptId: receipt.id,
        reportId: report.id,
        reportWebinarId: report.webinarId,
        sourceWebinarId: metadata.webinar_id,
        startedAtLocal: report.startedAtLocal,
        endedAtLocal: report.endedAtLocal,
      });
  }
  const conflict = new Set(bindings.map((binding) => binding.sourceWebinarId)).size > 1;
  return { binding: conflict ? null : (bindings[0] ?? null), conflict };
}

export function visitOverlapsReport(
  visit: ProviderVisit,
  interval: { timezone: string; scheduledAt: Date; endsAt: Date },
): boolean {
  const from = localToUtc(visit.joinedAtLocal, interval.timezone);
  const to = localToUtc(visit.leftAtLocal, interval.timezone);
  if (from === null || to === null || to < from) return true;
  return from < interval.endsAt.getTime() && to > interval.scheduledAt.getTime();
}
export function groupVisits(report: ProviderReport, config: WebinarSettings) {
  const parents = report.participants.map((_, i) => i),
    seen = new Map<string, number>();
  const root = (n: number): number => {
    while (parents[n] !== n) {
      parents[n] = parents[parents[n]!]!;
      n = parents[n]!;
    }
    return n;
  };
  report.participants.forEach((visit, i) => {
    const token = config.trackingParameter
      ? new URLSearchParams(visit.utm ?? '').get(config.trackingParameter)
      : null;
    const identities = [
      `visitor:${visit.visitorId}`,
      ...(token ? [`token:${token}`] : []),
      ...(emailIdentity(visit.email) ? [`email:${emailIdentity(visit.email)}`] : []),
      ...(phoneIdentity(visit.phone) ? [`phone:${phoneIdentity(visit.phone)}`] : []),
    ];
    for (const key of identities) {
      const previous = seen.get(key);
      if (previous !== undefined) parents[root(i)] = root(previous);
      seen.set(key, i);
    }
  });
  const grouped = new Map<number, ProviderVisit[]>();
  report.participants.forEach((visit, i) => {
    const key = root(i),
      group = grouped.get(key) ?? [];
    if (
      !group.some(
        (x) => fingerprint({ ...x, rowKey: '' }) === fingerprint({ ...visit, rowKey: '' }),
      )
    )
      group.push(visit);
    grouped.set(key, group);
  });
  return new Map(
    [...grouped.values()].map((visits) => [
      fingerprint(
        visits
          .map((v) => v.visitorId)
          .sort()
          .join(':'),
      ),
      visits,
    ]),
  );
}
export function normalizeAttendance(
  visits: ProviderVisit[],
  config: WebinarSettings,
  event?: { timezone: string; scheduledAt: Date; endsAt: Date },
) {
  visits = [...visits].sort(
    (a, b) =>
      (a.joinedAtLocal ?? '').localeCompare(b.joinedAtLocal ?? '') ||
      fingerprint({ ...a, rowKey: '' }).localeCompare(fingerprint({ ...b, rowKey: '' })),
  );
  const first = visits[0]!;
  const seconds = event
    ? watchedSeconds(visits, event.timezone, event.scheduledAt, event.endsAt)
    : null;
  const duration = event ? (event.endsAt.getTime() - event.scheduledAt.getTime()) / 1000 : null;
  const percentage =
    seconds !== null && duration && duration > 0
      ? Math.min(100, Math.round((seconds / duration) * 100))
      : null;
  const actions = visits.flatMap((x) => x.actions),
    comments = [
      ...new Map(
        visits
          .flatMap((x) => x.comments)
          .filter((comment) => {
            if (!event) return true;
            const at = localToUtc(comment.atLocal, event.timezone);
            return (
              at === null || (at >= event.scheduledAt.getTime() && at <= event.endsAt.getTime())
            );
          })
          .map((x) => [fingerprint(x), x]),
      ).values(),
    ];
  const ctaActions = actions.filter((x) => x.type === 'button_1' || x.type === 'button_2');
  const bannerActions = actions.filter((x) => x.type === 'banner');
  const clickFlag = (rows: typeof actions): boolean | null => {
    if (!config.clickStatuses.length || !rows.length) return null;
    if (rows.some((x) => config.clickStatuses.includes(x.status ?? ''))) return true;
    return rows.every((x) => config.seenStatuses.includes(x.status ?? '')) ? false : null;
  };
  const clicked = clickFlag(ctaActions),
    banner = clickFlag(bannerActions);
  const completed = percentage === null ? null : percentage >= config.completedPercentage;
  return {
    name: first.name,
    email: first.email,
    phone: first.phone,
    visitorId: first.visitorId,
    status:
      config.replay === true
        ? 'REPLAY_VIEWED'
        : completed
          ? 'COMPLETED'
          : percentage !== null && percentage > 0
            ? 'PARTIALLY_WATCHED'
            : 'ATTENDED',
    isReplay: config.replay,
    attended: true,
    watchedSeconds: seconds,
    watchedMinutes: seconds === null ? null : Math.round((seconds / 60) * 100) / 100,
    watchedPercentage: percentage,
    completed,
    ctaClicked: clicked,
    bannerClicked: banner,
    ctaViewed:
      clicked === true || ctaActions.some((x) => config.seenStatuses.includes(x.status ?? ''))
        ? true
        : null,
    comments: comments.sort((a, b) => fingerprint(a).localeCompare(fingerprint(b))),
    commentsCount: comments.length,
    actions: [...new Map(actions.map((x) => [fingerprint(x), x])).values()].sort((a, b) =>
      fingerprint(a).localeCompare(fingerprint(b)),
    ),
    utm: Object.fromEntries(new URLSearchParams(first.utm ?? '')),
    trackingToken: config.trackingParameter
      ? (visits
          .map((x) => new URLSearchParams(x.utm ?? '').get(config.trackingParameter!))
          .find(Boolean) ?? null)
      : null,
    firstJoinedAtLocal:
      visits
        .map((x) => x.joinedAtLocal)
        .filter((x): x is string => Boolean(x))
        .sort()[0] ?? null,
    lastLeftAtLocal:
      visits
        .map((x) => x.leftAtLocal)
        .filter((x): x is string => Boolean(x))
        .sort()
        .at(-1) ?? null,
  };
}
export function participantDestination(
  roomUrl: string,
  config: WebinarSettings,
  values: Record<string, string | null>,
  attribution: Record<string, unknown>,
): string {
  const url = new URL(roomUrl);
  if (
    url.origin !== 'https://efir.webinar-stars.com' ||
    !/^\/webinar\/[\w-]+\/?$/.test(url.pathname) ||
    url.username ||
    url.password
  )
    throw new Error('WEBINAR_ROOM_URL_INVALID');
  // Marketing attribution is retained on the invitation. Explicit provider mappings
  // take precedence when a verified UTM field is used as a tracking carrier.
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'])
    if (typeof attribution[key] === 'string') url.searchParams.set(key, attribution[key] as string);
  for (const [key, value] of Object.entries(config.constants)) url.searchParams.set(key, value);
  for (const [key, source] of Object.entries(config.parameters))
    if (values[source]) url.searchParams.set(key, values[source]!);
  return url.toString();
}

export function attendanceAttribution(
  providerUtm: Record<string, string>,
  invitationAttribution: unknown,
  trackingParameter: string | null,
  trackingToken: string | null,
): Record<string, string> {
  const saved = object(invitationAttribution);
  const result: Record<string, string> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const providerValue = providerUtm[key];
    if (
      typeof providerValue === 'string' &&
      !(key === trackingParameter && providerValue === trackingToken)
    )
      result[key] = providerValue;
    if (typeof saved[key] === 'string') result[key] = saved[key];
  }
  return result;
}
