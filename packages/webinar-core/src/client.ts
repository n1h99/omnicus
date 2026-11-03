// Account documentation supplied by the user, checked 2026-11-02; API is unversioned.
export class WebinarStarsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const invalid = (): never => {
  throw new WebinarStarsError('WEBINAR_STARS_RESPONSE_INVALID');
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1000): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) return invalid();
  return value;
}
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d{1,30}$/.test(value)) return value;
  return invalid();
}
function count(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value)))
    return invalid();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : invalid();
}
function rows(value: unknown, max = 50_000): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
function roomUrl(value: unknown): string | null {
  const input = text(value, 2048);
  if (!input) return null;
  try {
    const url = new URL(input);
    if (
      url.origin !== 'https://efir.webinar-stars.com' ||
      !/^\/webinar\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
function webinar(value: unknown) {
  const row = record(value);
  return {
    id: id(row.id),
    name: text(row.name),
    type: row.type === 'live' || row.type === 'auto' ? row.type : 'unknown',
    url: roomUrl(row.url),
    scheduledAtLocal: text(row.date, 100),
    timezoneName: text(row.timezone_name, 200),
    isLiveNow: row.is_live_now === true || row.is_live_now === 1,
  };
}
function reportSummary(value: unknown) {
  const row = record(value);
  return {
    id: id(row.id),
    webinarId: id(row.webinar_id),
    name: text(row.webinar_name),
    startedAtLocal: text(row.date_start, 100),
    endedAtLocal: text(row.date_end, 100),
    visitorsCount: count(row.visitors_count),
    visitorsPeak: count(row.visitors_peak),
  };
}
function visitor(value: unknown, index: number) {
  const row = record(value);
  return {
    // A visitor can have multiple sessions. Do not deduplicate by visitor ID here.
    rowKey: String(index),
    visitorId: id(row.visitor_id),
    name: text(row.name),
    email: text(row.email, 320),
    phone: text(row.phone, 100),
    joinedAtLocal: text(row.date_start, 100),
    leftAtLocal: text(row.date_end, 100),
    device: text(row.type_device, 200),
    country: text(row.country, 200),
    city: text(row.city, 200),
    utm: text(row.utm, 8000),
    comments: rows(row.comments ?? [], 1000).map((value) => {
      const comment = record(value);
      return { atLocal: text(comment.created_at, 100), text: text(comment.text, 10000) };
    }),
    actions: rows(row.buttons_info ?? [], 1000).map((value) => {
      const action = record(value);
      return {
        type: text(action.type, 100),
        status: text(action.status, 100),
        label: text(action.status_name, 300),
        showNumber: count(action.show_number),
      };
    }),
  };
}

export interface WebinarListInput {
  limit: number;
  offset: number;
  search?: string | undefined;
  status?: string | undefined;
}
export interface ReportListInput extends WebinarListInput {
  from?: string | undefined;
  to?: string | undefined;
}

export class WebinarStarsClient {
  constructor(private readonly token: string) {}

  private async get(
    method: 'get_webinars' | 'get_reports' | 'get_report',
    params: Record<string, string>,
  ) {
    const url = new URL(`https://efir.webinar-stars.com/api/${method}/`);
    url.searchParams.set('token', this.token);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new WebinarStarsError(
          response.status === 429 ? 'WEBINAR_STARS_RATE_LIMITED' : 'WEBINAR_STARS_UNAVAILABLE',
        );
      }
      const reader = response.body?.getReader();
      if (!reader) return invalid();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 8_000_000) {
            await reader.cancel();
            throw new WebinarStarsError('WEBINAR_STARS_RESPONSE_TOO_LARGE');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      let body: Record<string, unknown>;
      try {
        body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        return invalid();
      }
      if (body.error === 1 || body.error === 2 || body.error === '1' || body.error === '2')
        throw new WebinarStarsError('WEBINAR_STARS_ACCESS_DENIED');
      if (body.error === 11 || body.error === '11')
        throw new WebinarStarsError('WEBINAR_STARS_REPORT_NOT_FOUND');
      if (body.error !== 0 && body.error !== '0') return invalid();
      return body;
    } catch (error) {
      if (error instanceof WebinarStarsError) throw error;
      // Fetch exceptions may contain credential-bearing URLs. Never expose the cause.
      throw new WebinarStarsError('WEBINAR_STARS_UNAVAILABLE');
    }
  }

  async webinars(input: WebinarListInput) {
    const body = await this.get('get_webinars', {
      limit: String(input.limit),
      offset: String(input.offset),
      ...(input.search ? { search: input.search } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
    const items = rows(body.webinars, input.limit).map(webinar);
    return {
      items,
      hasMore: items.length === input.limit,
      offset: input.offset,
      total: count(body.total),
    };
  }

  async reports(input: ReportListInput) {
    const body = await this.get('get_reports', {
      limit: String(input.limit),
      offset: String(input.offset),
      ...(input.search ? { search: input.search } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
    });
    const items = rows(body.reports, input.limit).map(reportSummary);
    // num_rows is not documented as the total across pages. Do not infer it.
    return { items, hasMore: items.length === input.limit, offset: input.offset };
  }

  async report(reportId: string) {
    const body = await this.get('get_report', { report: reportId, unique: '0' });
    const raw = record(body.report);
    const summary = reportSummary(raw);
    if (summary.id !== reportId) return invalid();
    return { ...summary, participants: rows(raw.visitors).map(visitor) };
  }
}
