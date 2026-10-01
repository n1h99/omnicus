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
