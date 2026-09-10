import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppApiError, WhatsAppCloudApi } from '@omnicus/channel-whatsapp';
import { WhatsAppManagementService } from './whatsapp-management.service';
import { WhatsAppChannelsService } from './whatsapp-channels.service';
import { WhatsAppManagementController } from './whatsapp-management.controller';

afterEach(() => vi.restoreAllMocks());

function management() {
  const context = vi.fn().mockResolvedValue({
    row: { status: 'ACTIVE', lastWebhookAt: null },
    token: 'private-token',
    version: 'v25.0',
    wabaId: 'waba-a',
    phoneNumberId: 'phone-a',
  });
  const messages = vi.fn().mockResolvedValue(null);
  const database = {
    client: {
      whatsAppMessageTemplate: { groupBy: vi.fn().mockResolvedValue([]) },
      message: { findFirst: messages },
      messageStatusEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    },
  };
  const config = {
    get: (name: string) => (name === 'WHATSAPP_META_APP_ID' ? 'app-a' : 'private-app-secret'),
  };
  return {
    context,
    messages,
    service: new WhatsAppManagementService(
      { managementContext: context } as never,
      database as never,
      config as never,
    ),
  };
}

describe('WhatsApp channel management: safe independent diagnostics', () => {
  it('returns partial health without exposing credentials or declaring a payment method configured', async () => {
    const read = vi
      .spyOn(WhatsAppCloudApi.prototype, 'readFields')
      .mockImplementation(async (_token, _version, _id, fields) => {
        if (fields === 'health_status')
          return {
            health_status: {
              can_send_message: 'BLOCKED',
              entities: [
                {
                  entity_type: 'WABA',
                  can_send_message: 'BLOCKED',
                  errors: [
                    {
                      error_code: 131042,
                      error_description: 'Payment required',
                      possible_solution: 'Add payment method',
                    },
                  ],
                },
              ],
            },
          };
        if (fields.includes('quality_rating'))
          return {
            display_phone_number: '+351934000000',
            quality_rating: 'GREEN',
            verified_name: 'Demo',
          };
        throw new WhatsAppApiError(403, undefined, 200);
      });
    vi.spyOn(WhatsAppCloudApi.prototype, 'subscribedApps').mockResolvedValue([
      { whatsapp_business_api_data: { id: 'app-a' } },
    ]);
    vi.spyOn(WhatsAppCloudApi.prototype, 'inspectToken').mockResolvedValue({
      app_id: 'app-a',
      is_valid: true,
      expires_at: 0,
      scopes: ['whatsapp_business_messaging'],
      token: 'private-token',
    });
    const { service, context, messages } = management();
    const result = await service.health('project-a', 'connection-a');
    expect(context).toHaveBeenCalledWith('project-a', 'connection-a');
    expect(messages).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'project-a', connectionId: 'connection-a', direction: 'INBOUND' },
      }),
    );
    expect(result).toMatchObject({
      providerStatus: 'BLOCKED',
      phone: { quality: 'GREEN' },
      messagingLimit: null,
      webhook: { subscribed: true },
      token: { valid: true, missingPermissions: ['whatsapp_business_management'] },
      unavailable: { limit: { code: 200 } },
    });
    expect(read).toHaveBeenCalledWith(
      'private-token',
      'v25.0',
      'phone-a',
      'whatsapp_business_manager_messaging_limit',
    );
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('does not mistake another app token or expired data access for a working token', async () => {
    vi.spyOn(WhatsAppCloudApi.prototype, 'readFields').mockResolvedValue({});
    vi.spyOn(WhatsAppCloudApi.prototype, 'subscribedApps').mockResolvedValue([]);
    const inspect = vi
      .spyOn(WhatsAppCloudApi.prototype, 'inspectToken')
      .mockResolvedValue({ app_id: 'other-app', is_valid: true });
    expect((await management().service.health('p', 'c')).token.valid).toBe(false);
    inspect.mockResolvedValue({ app_id: 'app-a', is_valid: true, data_access_expires_at: 1 });
    expect((await management().service.health('p', 'c')).token.valid).toBe(false);
  });
});

describe('Meta direct billing', () => {
  function billingMocks(points: unknown[], currency: string | undefined = 'USD') {
    vi.spyOn(WhatsAppCloudApi.prototype, 'wabaPhoneNumber').mockResolvedValue({
      id: 'phone-a',
      displayPhoneNumber: '+351 934 000 000',
    });
    return vi
      .spyOn(WhatsAppCloudApi.prototype, 'readFields')
      .mockImplementation(async (_token, _version, _id, fields) =>
        fields === 'currency'
          ? { currency }
          : { pricing_analytics: { data: [{ data_points: points }] } },
      );
  }
  it('filters analytics to the selected phone and separates reported costs from card verification', async () => {
    const read = billingMocks([
      {
        phone_number: '351934000000',
        volume: 2,
        cost: 0.1184,
        pricing_category: 'MARKETING',
        pricing_type: 'REGULAR',
      },
    ]);
    const result = await management().service.billing('project-a', 'connection-a');
    expect(result).toMatchObject({
      mode: 'META_DIRECT',
      paymentMethodStatus: 'CHECK_IN_META',
      reportedCost: 0.1184,
      volume: 2,
      currency: 'USD',
    });
    expect(read.mock.calls[1]![3]).toContain('phone_numbers(["351934000000"])');
    expect(read.mock.calls[1]![3]).toContain('"PHONE"');
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
  it.each([
    [{ phone_number: 'different-number', cost: 1234, volume: 9 }],
    [{ phone_number: '351934000000', volume: 9 }],
  ])('does not substitute zero for missing/unscoped costs', async (point) => {
    billingMocks([point]);
    const result = await management().service.billing('p', 'c');
    expect(result.reportedCost).toBeNull();
    expect(JSON.stringify(result)).not.toContain('1234');
  });
  it('only reports zero for a valid empty report', async () => {
    billingMocks([]);
    expect((await management().service.billing('p', 'c')).reportedCost).toBe(0);
  });
  it('does not turn denied analytics access into a free-messages report', async () => {
    billingMocks([]).mockRejectedValue(new WhatsAppApiError(403, undefined, 200));
    const result = await management().service.billing('p', 'c');
    expect(result.reportedCost).toBeNull();
    expect(result.volume).toBeNull();
    expect(result.unavailable).toHaveProperty('analytics.code', 200);
  });
  it('does not query aggregate expenses before verifying phone ownership', async () => {
    const read = billingMocks([]);
    vi.spyOn(WhatsAppCloudApi.prototype, 'wabaPhoneNumber').mockRejectedValue(
      new WhatsAppApiError(404),
    );
    await expect(management().service.billing('p', 'c')).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('template management isolation and safe mutations', () => {
  const draft = {
    name: 'welcome',
    languageCode: 'en_US',
    category: 'UTILITY' as const,
    body: 'Your booking is confirmed.',
  };
  function templates() {
    const store = {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const client = {
      whatsAppMessageTemplate: store,
      channelConnection: {
        findMany: vi.fn().mockResolvedValue([{ id: 'connection-a' }, { id: 'connection-b' }]),
        findUnique: vi.fn().mockResolvedValue({ id: 'connection-a', type: 'WHATSAPP' }),
      },
      $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(client)),
    };
    const instance = new WhatsAppChannelsService(
      { get: () => Buffer.alloc(32, 7).toString('base64') } as never,
      { client } as never,
      { record: vi.fn() } as never,
      {} as never,
    );
    vi.spyOn(instance, 'managementContext').mockResolvedValue({
      row: { status: 'ACTIVE' },
      token: 'private-token',
      version: 'v25.0',
      wabaId: 'waba-a',
      phoneNumberId: 'phone-a',
    } as never);
    return { instance, store, client };
  }
  it('creates and updates only the project-owned connections sharing the WABA', async () => {
    const create = vi
      .spyOn(WhatsAppCloudApi.prototype, 'createTemplate')
      .mockResolvedValue({ id: 'provider-1', status: 'PENDING', category: 'UTILITY' });
    const { instance, store, client } = templates();
    await instance.saveTemplate('project-a', 'connection-a', draft, {} as never, {} as never);
    expect(create).toHaveBeenCalledWith(
      'private-token',
      'v25.0',
      'waba-a',
      expect.objectContaining({ name: 'welcome' }),
    );
    expect(client.channelConnection.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: { projectId: 'project-a', type: 'WHATSAPP', providerAccountId: 'waba-a' },
    });
    expect(store.upsert).toHaveBeenCalledTimes(2);
    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId_connectionId_name_languageCode: {
            projectId: 'project-a',
            connectionId: 'connection-b',
            name: 'welcome',
            languageCode: 'en_US',
          },
        },
      }),
    );
  });
  it('blocks cross-project template IDs before calling Meta', async () => {
    const edit = vi.spyOn(WhatsAppCloudApi.prototype, 'editTemplate');
    const remove = vi.spyOn(WhatsAppCloudApi.prototype, 'deleteTemplate');
    const { instance, store } = templates();
    await expect(
      instance.saveTemplate(
        'project-a',
        'connection-a',
        draft,
        {} as never,
        {} as never,
        'foreign-template',
      ),
    ).rejects.toThrow();
    await expect(
      instance.deleteTemplate(
        'project-a',
        'connection-a',
        'foreign-template',
        {} as never,
        {} as never,
      ),
    ).rejects.toThrow();
    expect(store.findFirst).toHaveBeenCalledWith({
      where: { projectId: 'project-a', connectionId: 'connection-a', id: 'foreign-template' },
    });
    expect(edit).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('retains local templates when Meta rejects deletion', async () => {
    vi.spyOn(WhatsAppCloudApi.prototype, 'deleteTemplate').mockRejectedValue(
      new WhatsAppApiError(400, undefined, 100, 123, false, undefined, 'private-token'),
    );
    const { instance, store } = templates();
    store.findFirst.mockResolvedValue({ ...draft, providerTemplateId: 'provider-1' });
    const error = await instance
      .deleteTemplate('project-a', 'connection-a', 'template-a', {} as never, {} as never)
      .catch((error) => error);
    expect(error.getResponse()).toEqual({
      code: 'WHATSAPP_TEMPLATE_DELETE_FAILED',
      details: { providerCode: 100, providerSubcode: 123 },
    });
    expect(store.deleteMany).not.toHaveBeenCalled();
  });
  it('cannot manage another project connection', async () => {
    const instance = new WhatsAppChannelsService(
      { get: () => Buffer.alloc(32, 7).toString('base64') } as never,
      { client: { channelConnection: { findUnique: vi.fn().mockResolvedValue(null) } } } as never,
      {} as never,
      {} as never,
    );
    await expect(instance.managementContext('other-project', 'connection-a')).rejects.toThrow();
  });
  it('normalizes links, sample values, rejection reasons, and unsupported template components', () => {
    const instance = templates().instance as unknown as {
      normalizeTemplate(value: unknown): { components: unknown[]; rejectionReasonCode: string };
    };
    const result = instance.normalizeTemplate({
      id: 'p',
      name: 't',
      language: 'en_US',
      status: 'REJECTED',
      rejected_reason: 'Category mismatch',
      components: [
        {
          type: 'BODY',
          text: 'Hi {{1}}',
          example: { body_text: [['Alex']], access_token: 'secret' },
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'Open',
              url: 'https://example.test/{{1}}',
              example: ['https://example.test/123'],
            },
          ],
        },
        { type: 'CAROUSEL', cards: [{ private: true }] },
      ],
    });
    expect(result.rejectionReasonCode).toBe('Category mismatch');
    expect(result.components[1]).toMatchObject({
      buttons: [{ url: 'https://example.test/{{1}}', examples: ['https://example.test/123'] }],
    });
    expect(result.components[2]).toHaveProperty(
      'unsupportedReason',
      'WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED',
    );
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('keeps finance and mutation endpoints restricted to channel managers', () => {
    for (const method of ['billing', 'create', 'edit', 'remove', 'sample'] as const) {
      const metadata = Reflect.getMetadataKeys(WhatsAppManagementController.prototype[method]).map(
        (key) => Reflect.getMetadata(key, WhatsAppManagementController.prototype[method]),
      );
      expect(JSON.stringify(metadata)).toContain('channels:manage');
    }
  });
});
