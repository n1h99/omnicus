import { describe, expect, it, vi } from 'vitest';
import {
  buildWhatsAppTemplate,
  estimateWhatsAppCost,
  normalizeWhatsAppPricing,
  templateVariableCount,
  WhatsAppCloudApi,
  whatsAppPricingMarket,
  whatsAppRateCard,
  whatsAppTemplateDisabledReason,
} from './index';

const draft = {
  name: 'appointment',
  category: 'UTILITY' as const,
  languageCode: 'en_US',
  body: 'Hello {{1}}, your appointment is confirmed.',
  bodyExamples: ['Alex'],
};

describe('WhatsApp template authoring', () => {
  it('builds a complete allowlisted payload with review samples and preserves button URLs', () => {
    const payload = buildWhatsAppTemplate({
      ...draft,
      header: { format: 'IMAGE', handle: 'review-handle' },
      footer: 'Omnicus',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Confirm' },
        {
          type: 'URL',
          text: 'Booking',
          url: 'https://example.test/book/{{1}}',
          example: 'https://example.test/book/123',
        },
        { type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '+351934000000' },
      ],
      ...{ access_token: 'must-not-forward' },
    });
    expect(payload).toEqual({
      name: 'appointment',
      language: 'en_US',
      category: 'UTILITY',
      components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['review-handle'] } },
        { type: 'BODY', text: draft.body, example: { body_text: [['Alex']] } },
        { type: 'FOOTER', text: 'Omnicus' },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Confirm' },
            {
              type: 'URL',
              text: 'Booking',
              url: 'https://example.test/book/{{1}}',
              example: ['https://example.test/book/123'],
            },
            { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+351934000000' },
          ],
        },
      ],
    });
  });
  it.each(['Hi {{name}}', 'Hi {{2}}', 'Hi {{0}}', 'Hi {{1}} {{3}}', 'Hi {1}', 'Hi {{ 1 }}'])(
    'rejects unsafe or non-consecutive variable syntax: %s',
    (body) => {
      expect(() => buildWhatsAppTemplate({ ...draft, body })).toThrow();
    },
  );
  it('accepts repeated numbered variables but requires one example per distinct variable', () => {
    expect(templateVariableCount('{{2}} {{1}} {{1}}')).toBe(2);
    expect(() => buildWhatsAppTemplate({ ...draft, bodyExamples: [] })).toThrow('example');
    expect(() => buildWhatsAppTemplate({ ...draft, header: { format: 'IMAGE' } })).toThrow(
      'sample',
    );
    expect(() => buildWhatsAppTemplate({ ...draft, footer: 'Hi {{1}}' })).toThrow();
  });
  it.each([
    'http://example.test',
    'javascript:alert(1)',
    'https://a:b@example.test',
    'https://{{1}}/path',
    'https://example.test/{{1}}/tail',
  ])('rejects invalid button URL %s', (url) => {
    expect(() =>
      buildWhatsAppTemplate({ ...draft, buttons: [{ type: 'URL', text: 'Open', url }] }),
    ).toThrow();
  });
  it('rejects fake URL examples and interleaved button groups', () => {
    expect(() =>
      buildWhatsAppTemplate({
        ...draft,
        buttons: [
          {
            type: 'URL',
            text: 'Open',
            url: 'https://example.test/{{1}}',
            example: 'https://different.test/123',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      buildWhatsAppTemplate({
        ...draft,
        buttons: [
          { type: 'QUICK_REPLY', text: 'One' },
          { type: 'URL', text: 'Open', url: 'https://example.test' },
          { type: 'QUICK_REPLY', text: 'Two' },
        ],
      }),
    ).toThrow('Group');
    expect(
      whatsAppTemplateDisabledReason({
        status: 'APPROVED',
        components: [
          { type: 'BODY', unsupportedReason: 'WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED' },
        ],
      }),
    ).toBe('WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED');
  });
});

describe('direct Meta list-rate estimation', () => {
  const at = new Date('2026-09-10T12:00:00Z');
  const recipients = [{ phone: '351934000000' }, { phone: '994501234567' }];
  it('maps recipient country, not the business number, to official prices', () => {
    const result = estimateWhatsAppCost({ at, recipients, category: 'MARKETING', currency: 'USD' });
    expect(result).toMatchObject({ estimatedCost: 0.1452, paid: 2, free: 0, unknown: 0 });
    expect(whatsAppPricingMarket('+351934000000')).toBe('Rest of Western Europe');
    expect(whatsAppPricingMarket('18095551234')).toBe('Rest of Latin America');
    expect(whatsAppPricingMarket('12425551234')).toBe('Other');
    expect(whatsAppPricingMarket('14155551234')).toBe('North America');
  });
  it('treats utility as free only while the current customer service window is open', () => {
    const result = estimateWhatsAppCost({
      at,
      category: 'UTILITY',
      currency: 'USD',
      recipients: [
        { phone: '351934000000', serviceWindowExpiresAt: new Date(at.getTime() + 1) },
        { phone: '351934000001', serviceWindowExpiresAt: at },
      ],
    });
    expect(result).toMatchObject({ free: 1, paid: 1, estimatedCost: 0.0171 });
    expect(
      estimateWhatsAppCost({
        at,
        category: 'MARKETING',
        currency: 'USD',
        recipients: [{ phone: '351934000000', serviceWindowExpiresAt: new Date(at.getTime() + 1) }],
      }),
    ).toMatchObject({ paid: 1, free: 0 });
  });
  it('fails closed for expired prices, unknown currencies/categories and malformed numbers', () => {
    for (const override of [
      { at: new Date('2026-10-01T00:00:00Z') },
      { currency: 'XYZ' },
      { category: 'UNKNOWN' },
      { recipients: [{ phone: 'invalid' }] },
    ]) {
      expect(
        estimateWhatsAppCost({ at, recipients, category: 'UTILITY', currency: 'USD', ...override })
          .estimatedCost,
      ).toBeNull();
    }
    expect(
      estimateWhatsAppCost({ at, recipients: [], category: 'MARKETING', currency: 'USD' })
        .estimatedCost,
    ).toBe(0);
    expect(whatsAppRateCard.currencies).toHaveLength(16);
  });
  it('does not leak raw webhook fields or invent a price', () => {
    expect(
      normalizeWhatsAppPricing({
        billable: true,
        pricing_model: 'PMP',
        category: 'utility',
        type: 'regular',
        cost: 999,
        access_token: 'secret',
      }),
    ).toEqual({ billable: true, pricingModel: 'PMP', category: 'utility', type: 'regular' });
    expect(normalizeWhatsAppPricing({ billable: 'false', pricing_model: 'PMP' })).toBeUndefined();
    expect(
      normalizeWhatsAppPricing({
        billable: true,
        pricing_model: 'CBP',
        category: 'utility',
        type: 'regular',
      }),
    ).toBeUndefined();
  });
});

describe('Meta management transport', () => {
  it('deletes one template language by ID and name, with auth in headers only', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true }));
    const api = new WhatsAppCloudApi(fetcher);
    await api.deleteTemplate('secret', 'v25.0', 'waba', 'template-id', 'appointment');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain('hsm_id=template-id');
    expect(String(url)).toContain('name=appointment');
    expect(String(url)).not.toContain('secret');
    expect(init).toMatchObject({ method: 'DELETE', headers: { Authorization: 'Bearer secret' } });
  });
  it('uses a resumable upload handle, not a messaging media ID', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 'upload:session?sig=signed' }))
      .mockResolvedValueOnce(Response.json({ h: 'review-handle' }));
    const api = new WhatsAppCloudApi(fetcher);
    await expect(
      api.uploadTemplateSample({
        token: 'secret',
        version: 'v25.0',
        appId: 'app',
        bytes: new Uint8Array([1, 2]),
        filename: 'image.jpg',
        contentType: 'image/jpeg',
      }),
    ).resolves.toBe('review-handle');
    expect(String(fetcher.mock.calls[0]![0])).toContain('/app/uploads?');
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      headers: { Authorization: 'OAuth secret', file_offset: '0' },
    });
  });
  it('rejects truncated sync and cross-origin pagination before sending credentials', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ data: [], paging: { next: 'https://attacker.test' } }));
    const api = new WhatsAppCloudApi(fetcher);
    await expect(api.templates('secret', 'v25.0', 'waba')).rejects.toThrow();
    await expect(api.subscribedApps('secret', 'v25.0', 'waba')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValue(Response.json({ unexpected: true }));
    await expect(api.templates('secret', 'v25.0', 'waba')).rejects.toThrow();
  });
});
