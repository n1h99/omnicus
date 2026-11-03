import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebinarStarsClient } from './webinar-stars.client';

const token = 'synthetic-token-for-tests';
const client = new WebinarStarsClient(token);
const reply = (body: unknown, status = 200) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
// Synthetic examples based on account documentation; not captured provider fixtures.
const summary = {
  id: '8163',
  webinar_id: 2390,
  webinar_name: 'Test',
  date_start: '2026-11-02 12:00:00',
  visitors_count: '2',
};
afterEach(() => vi.unstubAllGlobals());

describe('Webinar Stars adapter boundary', () => {
  it('accepts empty pages and passes bounded pagination on the fixed origin', async () => {
    const fetcher = reply({ error: 0, total: 0, webinars: [] });
    expect(await client.webinars({ limit: 25, offset: 50, search: 'test & name' })).toEqual({
      items: [],
      offset: 50,
      total: 0,
      hasMore: false,
    });
    const url = fetcher.mock.calls[0]![0] as URL;
    expect(url.origin).toBe('https://efir.webinar-stars.com');
    expect(url.pathname).toBe('/api/get_webinars/');
    expect(url.searchParams.get('token')).toBe(token);
    expect(url.searchParams.get('search')).toBe('test & name');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });
  it('does not infer total from undocumented num_rows and distinguishes unknown from zero', async () => {
    reply({ error: 0, num_rows: '999', reports: [summary] });
    const page = await client.reports({ limit: 1, offset: 0 });
    expect(page.hasMore).toBe(true);
    expect(page.items[0]).toMatchObject({
      id: '8163',
      webinarId: '2390',
      visitorsCount: 2,
      visitorsPeak: null,
    });
    expect(page).not.toHaveProperty('total');
  });
  it('preserves repeat visits, negative visitor IDs, local time, comments and unclassified actions', async () => {
    const visitor = {
      visitor_id: -1234567,
      email: 'viewer@example.test',
      date_start: '2026-11-02 12:01:00',
      utm: 'utm_source=test',
      comments: [{ created_at: '2026-11-02 12:02:00', text: '<script>example</script>' }],
      buttons_info: [{ type: 'button_1', status: 'seen', status_name: 'Saw', show_number: 1 }],
    };
    const fetcher = reply({ error: 0, report: { ...summary, visitors: [visitor, visitor] } });
    const report = await client.report('8163');
    expect(report.participants).toHaveLength(2);
    expect(report.participants.map((row) => row.rowKey)).toEqual(['0', '1']);
    expect(report.participants[0]).toMatchObject({
      visitorId: '-1234567',
      joinedAtLocal: '2026-11-02 12:01:00',
      actions: [{ status: 'seen' }],
      comments: [{ text: '<script>example</script>' }],
    });
    expect((fetcher.mock.calls[0]![0] as URL).searchParams.get('unique')).toBe('0');
  });
  it.each([
    [{ error: 2, error_text: token }, 'WEBINAR_STARS_ACCESS_DENIED'],
    [{ error: 11 }, 'WEBINAR_STARS_REPORT_NOT_FOUND'],
    [
      { error: 0, report: { ...summary, id: '999', visitors: [] } },
      'WEBINAR_STARS_RESPONSE_INVALID',
    ],
    [{ error: 0, report: summary }, 'WEBINAR_STARS_RESPONSE_INVALID'],
    [{ report: { ...summary, visitors: [] } }, 'WEBINAR_STARS_RESPONSE_INVALID'],
  ])('rejects errors, mismatched reports and missing participant data', async (body, code) => {
    reply(body);
    await expect(client.report('8163')).rejects.toMatchObject({ code });
  });
  it('drops unsafe room links and all extra provider properties', async () => {
    reply({
      error: 0,
      webinars: [{ id: 1, name: 'Test', url: 'javascript:alert(1)', token, unexpected: 'private' }],
    });
    const page = await client.webinars({ limit: 25, offset: 0 });
    expect(page.items[0]?.url).toBeNull();
    expect(JSON.stringify(page)).not.toContain(token);
    expect(page.items[0]).not.toHaveProperty('unexpected');
  });
  it('redacts network errors that contain token-bearing URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error(`https://example.test/?token=${token}`)),
    );
    const error: unknown = await client
      .webinars({ limit: 1, offset: 0 })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ message: 'WEBINAR_STARS_UNAVAILABLE' });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain(token);
  });
  it('handles rate limits without exposing provider content', async () => {
    reply({ token }, 429);
    await expect(client.webinars({ limit: 1, offset: 0 })).rejects.toMatchObject({
      code: 'WEBINAR_STARS_RATE_LIMITED',
    });
  });
  it('cancels oversized streaming responses', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8_000_001));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    await expect(client.webinars({ limit: 1, offset: 0 })).rejects.toMatchObject({
      code: 'WEBINAR_STARS_RESPONSE_TOO_LARGE',
    });
    expect(cancel).toHaveBeenCalled();
  });
  it('rejects malformed JSON, invalid counters and excess page rows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>login</html>')));
    await expect(client.reports({ limit: 1, offset: 0 })).rejects.toMatchObject({
      code: 'WEBINAR_STARS_RESPONSE_INVALID',
    });
    reply({ error: 0, reports: [{ ...summary, visitors_count: '-2' }] });
    await expect(client.reports({ limit: 1, offset: 0 })).rejects.toThrow();
    reply({ error: 0, reports: [summary, summary] });
    await expect(client.reports({ limit: 1, offset: 0 })).rejects.toThrow();
  });
});
