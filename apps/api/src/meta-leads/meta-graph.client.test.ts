import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetaGraphClient, normalizeMetaLead } from './meta-graph.client';

const lead = {
  id: '111',
  form_id: '222',
  created_time: '2026-10-01T01:34:51+0000',
  field_data: [
    { name: 'full_name', values: ['Test Person'] },
    { name: 'country_of_residence:', values: ['United States'] },
    { name: 'email', values: ['test@example.org'] },
    { name: 'phone_number', values: ['+12025550101'] },
  ],
};
afterEach(() => vi.unstubAllGlobals());
describe('Meta Graph v26 adapter', () => {
  it('maps the actual form keys including the trailing country colon', () => {
    expect(normalizeMetaLead(lead, '333', '222')).toEqual({
      leadId: '111',
      formId: '222',
      pageId: '333',
      createdAt: '2026-10-01T01:34:51.000Z',
      name: 'Test Person',
      email: 'test@example.org',
      phone: '+12025550101',
      countryOfResidence: 'United States',
    });
  });
  it('rejects a different form and malformed data', () => {
    expect(() => normalizeMetaLead(lead, '333', '999')).toThrow('META_LEAD_PAYLOAD_INVALID');
    expect(() => normalizeMetaLead({ ...lead, created_time: 'broken' }, '333', '222')).toThrow();
    expect(() => normalizeMetaLead({ ...lead, field_data: null }, '333', '222')).toThrow();
  });
  it.each([
    ['150_000_-_300_000', '150 000–300 000'],
    ['300_000_-_500_000', '300 000–500 000'],
    ['500_000_-_700_000', '500 000–700 000'],
    ['700_000+', '700 000+'],
    ['150 000 - 300 000', '150 000–300 000'],
    ['700 000+', '700 000+'],
  ])('maps verified USD budget answer %s with actual ad metadata', (answer, range) => {
    const formId = '2301723413920519';
    expect(
      normalizeMetaLead(
        {
          ...lead,
          form_id: formId,
          ad_id: '120254153730390154',
          ad_name: '2 - lead-form',
          field_data: [...lead.field_data, { name: 'Budget', values: [answer] }],
        },
        '333',
        formId,
      ),
    ).toMatchObject({ budgetUsdRange: range, adId: '120254153730390154', adName: '2 - lead-form' });
  });
  it('does not infer USD for other forms or an unknown budget answer', () => {
    const withBudget = {
      ...lead,
      field_data: [...lead.field_data, { name: 'Budget', values: ['150_000_-_300_000'] }],
    };
    expect(normalizeMetaLead(withBudget, '333', '222')).not.toHaveProperty('budgetUsdRange');
    expect(
      normalizeMetaLead(
        {
          ...withBudget,
          form_id: '2301723413920519',
          field_data: [{ name: 'Budget', values: ['future option'] }],
        },
        '333',
        '2301723413920519',
      ),
    ).not.toHaveProperty('budgetUsdRange');
  });
  it('bounds ad names, strips control characters, and ignores malformed optional ad IDs', () => {
    const result = normalizeMetaLead(
      { ...lead, ad_id: '../bad', ad_name: `2 - lead-form\n${'x'.repeat(500)}` },
      '333',
      '222',
    );
    expect(result.adName).toHaveLength(300);
    expect(result.adName).not.toContain('\n');
    expect(result).not.toHaveProperty('adId');
    expect(result.email).toBe(lead.field_data[2]?.values[0]);
  });
  it.each(['lead', 'page'] as const)(
    'falls back to core fields for %s if optional ad fields lack access',
    async (mode) => {
      const core = mode === 'lead' ? lead : { data: [lead] };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('private provider error', { status: 403 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(core)));
      vi.stubGlobal('fetch', fetchMock);
      const client = new MetaGraphClient('test', 'v26.0');
      if (mode === 'lead')
        expect((await client.lead('111', '333', '222')).name).toBe('Test Person');
      else expect((await client.page('222', 'safe-cursor')).items).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('fields')).toContain(
        'ad_name',
      );
      expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('fields')).toBe(
        'id,created_time,form_id,field_data',
      );
      if (mode === 'page')
        expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('after')).toBe(
          'safe-cursor',
        );
    },
  );
  it('does not issue a fallback request on provider rate limiting', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new MetaGraphClient('test', 'v26.0').lead('111', '333', '222')).rejects.toThrow(
      'META_GRAPH_RATE_LIMITED',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('follows only cursor data, never a token-bearing next URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [lead],
          paging: {
            next: 'https://evil.example/?access_token=secret',
            cursors: { after: 'safe-cursor' },
          },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MetaGraphClient('unit-test-page-token', 'v26.0').page('222');
    expect(result.after).toBe('safe-cursor');
    expect(result).not.toHaveProperty('next');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('access_token');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'https://graph.facebook.com/v26.0/222/leads',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer unit-test-page-token' },
    });
  });
  it('does not expose provider errors/secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('private token and user data', { status: 403 })),
    );
    await expect(new MetaGraphClient('secret', 'v26.0').get('me')).rejects.toThrow(
      'META_GRAPH_ACCESS_FAILED',
    );
  });
  it('rejects repeated pagination cursor and invalid endpoints', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ data: [], paging: { next: 'ignored', cursors: { after: 'same' } } }),
          ),
        ),
    );
    const client = new MetaGraphClient('test', 'v26.0');
    await expect(client.page('222', 'same')).rejects.toThrow('META_GRAPH_CURSOR_INVALID');
    await expect(client.get('../me')).rejects.toThrow('META_GRAPH_PATH_INVALID');
  });
});
