import { describe, expect, it, vi } from 'vitest';

import {
  assertWhatsAppMedia,
  assertWhatsAppTemplateComponents,
  normalizeWhatsAppWebhookItem,
  splitWhatsAppWebhookEnvelope,
  WhatsAppCloudApi,
  WhatsAppWebhookEnvelopeError,
  whatsAppTemplateDisabledReason,
} from './index';

describe('WhatsApp webhook normalization', () => {
  it('splits a signed envelope into stable tenant-sized items', () => {
    const items = splitWhatsAppWebhookEnvelope({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                contacts: [{ profile: { name: 'Customer' }, wa_id: '15550001' }],
                metadata: { display_phone_number: '+1 555', phone_number_id: 'phone-1' },
                messages: [
                  { from: '15550001', id: 'wamid.in', text: { body: 'hello' }, type: 'text' },
                ],
                statuses: [{ id: 'wamid.out', status: 'delivered', timestamp: '1785700000' }],
              },
            },
          ],
        },
      ],
    });
    expect(items.map((item) => item.externalEventId)).toEqual([
      'message:wamid.in',
      'status:wamid.out:delivered:1785700000',
    ]);
    expect(normalizeWhatsAppWebhookItem(items[0]!.payload)).toMatchObject({
      kind: 'message',
      profileName: 'Customer',
      senderId: '15550001',
    });
  });

  it('splits every message and status while keeping contacts scoped to their sender', () => {
    const items = splitWhatsAppWebhookEnvelope({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                contacts: [
                  { profile: { name: 'One' }, wa_id: '1' },
                  { profile: { name: 'Two' }, wa_id: '2' },
                ],
                metadata: { phone_number_id: '10' },
                messages: [
                  { from: '1', id: 'm1', text: { body: 'one' }, type: 'text' },
                  { from: '2', id: 'm2', text: { body: 'two' }, type: 'text' },
                ],
                statuses: [{ id: 'out', status: 'read', timestamp: '1' }],
              },
            },
          ],
          id: '20',
        },
      ],
      object: 'whatsapp_business_account',
    });
    expect(items).toHaveLength(3);
    expect(normalizeWhatsAppWebhookItem(items[0]!.payload)).toMatchObject({ profileName: 'One' });
    expect(normalizeWhatsAppWebhookItem(items[1]!.payload)).toMatchObject({ profileName: 'Two' });
    expect(JSON.stringify(items)).not.toContain('undefined');
    expect(JSON.stringify(items[2]!.payload)).not.toContain('contacts');
  });

  it('rejects an oversized signed envelope before an unbounded split loop', () => {
    expect(() =>
      splitWhatsAppWebhookEnvelope({
        entry: Array.from({ length: 101 }, () => ({ changes: [], id: '1' })),
        object: 'whatsapp_business_account',
      }),
    ).toThrow(WhatsAppWebhookEnvelopeError);
  });
});

describe('WhatsApp Cloud API adapter', () => {
  it('serializes named template parameters for Meta', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.named' }] }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    const api = new WhatsAppCloudApi(fetchImplementation);
    await api.sendMessage({
      accessToken: 'secret',
      graphApiVersion: 'v23.0',
      message: {
        template: {
          components: [
            {
              parameters: [{ parameterName: 'first_name', text: 'Ada', type: 'text' }],
              type: 'body',
            },
          ],
          languageCode: 'en_US',
          name: 'welcome',
        },
        type: 'template',
      },
      phoneNumberId: '10',
      to: '20',
    });
    const body = JSON.parse(String(fetchImplementation.mock.calls[0]![1]!.body));
    expect(body.template.components[0].parameters).toEqual([
      { parameter_name: 'first_name', text: 'Ada', type: 'text' },
    ]);
  });

  it('serializes template payload parameters and reaction removal exactly once', async () => {
    const fetchImplementation = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
    );
    const api = new WhatsAppCloudApi(fetchImplementation);
    await api.sendMessage({
      accessToken: 'secret',
      graphApiVersion: 'v23.0',
      message: {
        template: {
          components: [
            {
              index: 0,
              parameters: [{ payload: 'confirm', type: 'payload' }],
              subType: 'quick_reply',
              type: 'button',
            },
          ],
          languageCode: 'en_US',
          name: 'welcome',
        },
        type: 'template',
      },
      phoneNumberId: '10',
      to: '20',
    });
    await api.sendMessage({
      accessToken: 'secret',
      graphApiVersion: 'v23.0',
      message: { emoji: '', messageId: 'wamid.target', type: 'reaction' },
      phoneNumberId: '10',
      to: '20',
    });
    const templateBody = JSON.parse(String(fetchImplementation.mock.calls[0]![1]!.body));
    const reactionBody = JSON.parse(String(fetchImplementation.mock.calls[1]![1]!.body));
    expect(templateBody.template.components[0]).toMatchObject({
      index: '0',
      parameters: [{ payload: 'confirm', type: 'payload' }],
      sub_type: 'quick_reply',
      type: 'button',
    });
    expect(reactionBody.reaction).toEqual({ emoji: '', message_id: 'wamid.target' });
  });

  it('rejects a media redirect instead of following it to an untrusted host', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'https://lookaside.facebook.com/media' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { location: 'https://attacker.example/file' },
          status: 302,
        }),
      );
    await expect(
      new WhatsAppCloudApi(fetchImplementation).downloadMedia({
        accessToken: 'secret',
        graphApiVersion: 'v23.0',
        maximumBytes: 1024,
        mediaId: 'media-a',
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchImplementation.mock.calls[1]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('keeps only allowlisted Meta error diagnostics', async () => {
    const api = new WhatsAppCloudApi(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 190,
              error_subcode: 463,
              is_transient: false,
              message: 'access token and customer content must not escape',
            },
          }),
          { headers: { 'content-type': 'application/json', 'retry-after': '12' }, status: 400 },
        ),
      ),
    );
    await expect(api.phoneNumber('secret', 'v23.0', '10')).rejects.toMatchObject({
      message: 'whatsapp_api_400',
      providerCode: 190,
      providerSubcode: 463,
      providerTransient: false,
      retryAfterSeconds: 12,
      status: 400,
    });
  });
});

describe('WhatsApp media validation', () => {
  it('accepts OGG/Opus and rejects OGG with another codec', () => {
    const opus = new TextEncoder().encode('OggS........OpusHead');
    const vorbis = new TextEncoder().encode('OggS........vorbis');
    expect(() => assertWhatsAppMedia('audio', 'audio/ogg', opus.byteLength, opus)).not.toThrow();
    expect(() => assertWhatsAppMedia('audio', 'audio/ogg', vorbis.byteLength, vorbis)).toThrow(
      'whatsapp_media_ogg_opus_required',
    );
  });
});

describe('WhatsApp template component validation', () => {
  it('accepts named variables only when their parameter names match', () => {
    const body = [
      {
        parameterStyle: 'named',
        text: 'Hello {{first_name}} from {{company}}',
        type: 'BODY',
        unsupportedReason: 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED',
      },
    ];
    expect(
      whatsAppTemplateDisabledReason({ components: body, status: 'APPROVED' }),
    ).toBeUndefined();
    expect(() =>
      assertWhatsAppTemplateComponents(body, [
        {
          parameters: [
            { parameterName: 'first_name', text: 'Ada', type: 'text' },
            { parameterName: 'company', text: 'Omnicus', type: 'text' },
          ],
          type: 'body',
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertWhatsAppTemplateComponents(body, [
        {
          parameters: [
            { text: 'Ada', type: 'text' },
            { parameterName: 'company', text: 'Omnicus', type: 'text' },
          ],
          type: 'body',
        },
      ]),
    ).toThrow();
  });
  it('allows a static URL without a parameter and requires a dynamic URL suffix', () => {
    expect(() =>
      assertWhatsAppTemplateComponents(
        [{ buttons: [{ dynamic: false, text: 'Open', type: 'URL' }], type: 'BUTTONS' }],
        undefined,
      ),
    ).not.toThrow();
    const dynamic = [
      {
        buttons: [{ dynamic: true, parameterStyle: 'positional', text: 'Open', type: 'URL' }],
        type: 'BUTTONS',
      },
    ];
    expect(() => assertWhatsAppTemplateComponents(dynamic, undefined)).toThrow();
    expect(() =>
      assertWhatsAppTemplateComponents(dynamic, [
        {
          index: 0,
          parameters: [{ text: 'customer-path', type: 'text' }],
          subType: 'url',
          type: 'button',
        },
      ]),
    ).not.toThrow();
  });

  it('rejects unsupported definitions and exact-shape violations', () => {
    expect(
      whatsAppTemplateDisabledReason({
        category: 'AUTHENTICATION',
        components: [],
        status: 'APPROVED',
      }),
    ).toBe('WHATSAPP_AUTHENTICATION_TEMPLATE_UNSUPPORTED');
    expect(
      whatsAppTemplateDisabledReason({
        category: 'UTILITY',
        components: [{ format: 'LOCATION', type: 'HEADER' }],
        status: 'APPROVED',
      }),
    ).toBe('WHATSAPP_TEMPLATE_LOCATION_HEADER_UNSUPPORTED');
    const body = [{ parameterStyle: 'positional', text: 'Hello {{1}}', type: 'BODY' }];
    expect(() =>
      assertWhatsAppTemplateComponents(body, [
        {
          parameters: [{ payload: 'wrong', type: 'payload' }],
          type: 'body',
        },
      ]),
    ).toThrow();
    expect(() =>
      assertWhatsAppTemplateComponents(body, [
        {
          extra: true,
          parameters: [{ text: 'Alice', type: 'text' }],
          type: 'body',
        },
      ]),
    ).toThrow();
  });
});
