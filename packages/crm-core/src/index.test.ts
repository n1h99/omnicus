import { describe, expect, it, vi } from 'vitest';

import {
  HttpCrmClient,
  MockCrmClient,
  type CrmClientError,
  type CreateOrUpdateLeadInput,
} from './index';

const context = {
  correlationId: 'correlation-a',
  crmProjectId: 'cyber-pulse-staging',
  idempotencyKey: 'operation-a',
  projectId: 'project-a',
};

const leadInput: CreateOrUpdateLeadInput = {
  contactId: 'contact-a',
  customFields: { interests: ['cars', { source: 'telegram' }] },
  displayName: 'Test',
  identity: {
    channel: 'telegram',
    channelIdentityId: 'identity-a',
    connectionId: 'connection-a',
    externalUserId: '123',
  },
  tags: [{ id: 'tag-a', name: 'Qualified' }],
};

describe('MockCrmClient', () => {
  it('is deterministic and idempotent by operation key', async () => {
    const client = new MockCrmClient();
    await expect(client.createOrUpdateLead(context, leadInput)).resolves.toEqual(
      await client.createOrUpdateLead(context, leadInput),
    );
  });

  it('exposes scripted safe failure classes without provider details', async () => {
    const client = new MockCrmClient(() => 'RETRYABLE_FAILURE');
    await expect(client.createOrUpdateLead(context, leadInput)).rejects.toMatchObject({
      outcome: 'RETRYABLE_FAILURE',
      safeCode: 'crm_mock_retryable_failure',
    });
  });
});

describe('HttpCrmClient', () => {
  it('sends the approved lead contract with service headers', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json({
        crmLeadId: 'crm-lead-a',
        mode: 'created',
        operationId: 'operation-provider-a',
      }),
    );
    const client = new HttpCrmClient({
      authToken: 'secret-service-token',
      baseUrl: 'https://crm.example.test/',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    await expect(client.createOrUpdateLead(context, leadInput)).resolves.toEqual({
      mode: 'created',
      operationId: 'operation-provider-a',
      providerReference: 'crm-lead-a',
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://crm.example.test/integrations/v1/omnicus/leads/upsert',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-service-token',
          'Idempotency-Key': 'operation-a',
          'X-Correlation-Id': 'correlation-a',
        }),
        method: 'POST',
      }),
    );
    const request = fetchImplementation.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      crmProjectId: 'cyber-pulse-staging',
      customFields: leadInput.customFields,
      omnicusContactId: 'contact-a',
      omnicusProjectId: 'project-a',
    });
  });

  it('reconciles an unknown transport result before returning success', async () => {
    const fetchImplementation = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket closed after request'))
      .mockResolvedValueOnce(
        Response.json({
          operationId: 'operation-provider-a',
          result: {
            crmLeadId: 'crm-lead-a',
            mode: 'updated',
            operationId: 'operation-provider-a',
          },
          status: 'SUCCEEDED',
        }),
      );
    const client = new HttpCrmClient({
      authToken: 'secret-service-token',
      baseUrl: 'https://crm.example.test',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    await expect(client.createOrUpdateLead(context, leadInput)).resolves.toMatchObject({
      mode: 'updated',
      providerReference: 'crm-lead-a',
    });
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toContain('idempotencyKey=operation-a');
  });

  it('preserves exact Telegram media kind and callback context in inbound messages', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json({
        crmLeadId: 'crm-lead-a',
        crmMessageId: 'crm-message-a',
        mode: 'created',
        operationId: 'operation-provider-a',
      }),
    );
    const client = new HttpCrmClient({
      authToken: 'secret-service-token',
      baseUrl: 'https://crm.example.test',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    await client.forwardInboundMessage(context, {
      contactId: 'contact-a',
      identity: leadInput.identity!,
      interactive: {
        callbackQueryId: 'callback-a',
        data: 'budget:1000',
        displayText: 'Under 1000',
        sourceMessageId: '11111111-1111-4111-8111-111111111111',
        type: 'callback_query',
      },
      media: {
        assetId: 'asset-a',
        emoji: '👋',
        hasSpoiler: true,
        kind: 'STICKER',
        mediaGroupId: 'album-1',
        setName: 'omnicus_demo',
        type: 'sticker',
      },
      occurredAt: '2026-07-29T00:00:00.000Z',
      replyToMessageId: '22222222-2222-4222-8222-222222222222',
    });

    const request = fetchImplementation.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      interactive: {
        callbackQueryId: 'callback-a',
        data: 'budget:1000',
        sourceMessageId: '11111111-1111-4111-8111-111111111111',
        type: 'callback_query',
      },
      media: {
        assetId: 'asset-a',
        emoji: '👋',
        hasSpoiler: true,
        kind: 'STICKER',
        mediaGroupId: 'album-1',
        setName: 'omnicus_demo',
        type: 'sticker',
      },
      replyToMessageId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('sends confirmed automation messages to the outbound history contract', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json({
        crmLeadId: 'crm-lead-a',
        crmMessageId: 'crm-message-a',
        mode: 'created',
        operationId: 'operation-provider-a',
      }),
    );
    const client = new HttpCrmClient({
      authToken: 'secret-service-token',
      baseUrl: 'https://crm.example.test',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    await client.forwardOutboundMessage(context, {
      contactId: 'contact-a',
      deliveryStatus: 'SENT',
      identity: leadInput.identity!,
      inlineKeyboard: [[{ callbackData: 'budget:1000', text: 'Under 1000' }]],
      entities: [{ length: 4, offset: 0, type: 'bold' }],
      hasSpoiler: true,
      linkPreviewOptions: { isDisabled: true },
      messageId: '11111111-1111-4111-8111-111111111111',
      messageEffectId: 'effect-known-by-caller',
      occurredAt: '2026-07-29T00:00:00.000Z',
      protectContent: true,
      providerMessageId: 'telegram-42',
      quote: 'Earlier text',
      quotePosition: 0,
      replyToMessageId: '33333333-3333-4333-8333-333333333333',
      scenarioExecutionId: '22222222-2222-4222-8222-222222222222',
      source: 'AUTOMATION',
      text: 'What is your budget?',
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://crm.example.test/integrations/v1/omnicus/messages/outbound',
      expect.objectContaining({ method: 'POST' }),
    );
    const request = fetchImplementation.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      crmProjectId: 'cyber-pulse-staging',
      deliveryStatus: 'SENT',
      inlineKeyboard: [[{ callbackData: 'budget:1000', text: 'Under 1000' }]],
      entities: [{ length: 4, offset: 0, type: 'bold' }],
      hasSpoiler: true,
      linkPreviewOptions: { isDisabled: true },
      messageId: '11111111-1111-4111-8111-111111111111',
      messageEffectId: 'effect-known-by-caller',
      omnicusContactId: 'contact-a',
      omnicusProjectId: 'project-a',
      providerMessageId: 'telegram-42',
      protectContent: true,
      quote: 'Earlier text',
      quotePosition: 0,
      replyToMessageId: '33333333-3333-4333-8333-333333333333',
      source: 'AUTOMATION',
    });
  });

  it('sends WhatsApp automation buttons as interactive CRM history', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json({
        crmLeadId: 'crm-lead-a',
        crmMessageId: 'crm-message-a',
        mode: 'created',
        operationId: 'operation-provider-a',
      }),
    );
    const client = new HttpCrmClient({
      authToken: 'secret-service-token',
      baseUrl: 'https://crm.example.test',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    await client.forwardOutboundMessage(context, {
      contactId: 'contact-a',
      deliveryStatus: 'SENT',
      identity: {
        channel: 'whatsapp',
        channelIdentityId: 'identity-wa',
        connectionId: 'connection-wa',
        externalUserId: '15550001',
      },
      interactive: {
        action: { buttons: [{ id: 'webinar_yes', title: 'Yes' }] },
        body: { text: 'Join the webinar?' },
        type: 'button',
      },
      messageId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-08-14T07:53:00.000Z',
      providerMessageId: 'wamid.automation-a',
      source: 'AUTOMATION',
    });

    const request = fetchImplementation.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      interactive: {
        action: { buttons: [{ id: 'webinar_yes', title: 'Yes' }] },
        body: { text: 'Join the webinar?' },
        type: 'button',
      },
      omnicusContactId: 'contact-a',
    });
    expect(body.text).toBeUndefined();
  });

  it('sends normalized user reaction events to their versioned CRM endpoint', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json({
        applied: true,
        crmLeadId: 'crm-lead-a',
        crmMessageId: 'crm-message-a',
        mode: 'created',
        operationId: 'operation-provider-a',
      }),
    );
    const client = new HttpCrmClient({
      authToken: 'secret-service-token',
      baseUrl: 'https://crm.example.test',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    await expect(
      client.forwardReactionEvent(context, {
        actor: {
          displayName: 'Test',
          externalUserId: '123',
          type: 'user',
        },
        contactId: 'contact-a',
        identity: leadInput.identity!,
        messageId: '11111111-1111-4111-8111-111111111111',
        newReactions: [{ emoji: '👍', type: 'emoji' }],
        normalizedEventId: '22222222-2222-4222-8222-222222222222',
        occurredAt: '2026-08-01T10:00:00.000Z',
        oldReactions: [],
      }),
    ).resolves.toMatchObject({ providerReference: 'crm-message-a' });

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://crm.example.test/integrations/v1/omnicus/reactions/inbound',
      expect.objectContaining({ method: 'POST' }),
    );
    const request = fetchImplementation.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      messageId: '11111111-1111-4111-8111-111111111111',
      newReactions: [{ emoji: '👍', type: 'emoji' }],
      normalizedEventId: '22222222-2222-4222-8222-222222222222',
      oldReactions: [],
    });
  });

  it('accepts a pending reaction-before-source result without a CRM message id', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json({
        applied: false,
        crmLeadId: 'crm-lead-a',
        mode: 'created',
        operationId: 'operation-provider-a',
      }),
    );
    const client = new HttpCrmClient({
      authToken: 'secret-service-token',
      baseUrl: 'https://crm.example.test',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    await expect(
      client.forwardReactionEvent(context, {
        actor: { displayName: 'Test', externalUserId: '123', type: 'user' },
        contactId: 'contact-a',
        identity: leadInput.identity!,
        messageId: '11111111-1111-4111-8111-111111111111',
        newReactions: [{ emoji: '👍', type: 'emoji' }],
        normalizedEventId: '22222222-2222-4222-8222-222222222222',
        occurredAt: '2026-08-01T10:00:00.000Z',
        oldReactions: [],
      }),
    ).resolves.toMatchObject({
      mode: 'created',
      operationId: 'operation-provider-a',
      providerReference: 'operation-provider-a',
    });
  });

  it('reconciles a pending reaction result using its operation as the temporary reference', async () => {
    const fetchImplementation = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket closed after request'))
      .mockResolvedValueOnce(
        Response.json({
          operationId: 'operation-provider-a',
          result: {
            applied: false,
            crmLeadId: 'crm-lead-a',
            mode: 'created',
            operationId: 'operation-provider-a',
          },
          status: 'SUCCEEDED',
        }),
      );
    const client = new HttpCrmClient({
      authToken: 'secret-service-token',
      baseUrl: 'https://crm.example.test',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    await expect(
      client.forwardReactionEvent(context, {
        actor: { displayName: 'Test', externalUserId: '123', type: 'user' },
        contactId: 'contact-a',
        identity: leadInput.identity!,
        messageId: '11111111-1111-4111-8111-111111111111',
        newReactions: [{ emoji: '👍', type: 'emoji' }],
        normalizedEventId: '22222222-2222-4222-8222-222222222222',
        occurredAt: '2026-08-01T10:00:00.000Z',
        oldReactions: [],
      }),
    ).resolves.toMatchObject({
      mode: 'created',
      operationId: 'operation-provider-a',
      providerReference: 'operation-provider-a',
    });
  });

  it('classifies rate limits without exposing the provider response', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code: 'CRM_RATE_LIMITED', retryable: true } },
          { headers: { 'Retry-After': '2' }, status: 429 },
        ),
      );
    const client = new HttpCrmClient({
      authToken: 'secret-service-token',
      baseUrl: 'https://crm.example.test',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    await expect(client.createOrUpdateLead(context, leadInput)).rejects.toEqual(
      expect.objectContaining<Partial<CrmClientError>>({
        outcome: 'RETRYABLE_FAILURE',
        retryAfterMs: 2_000,
        safeCode: 'CRM_RATE_LIMITED',
      }),
    );
  });
});
