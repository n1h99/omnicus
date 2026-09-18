import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { CrmWhatsAppV4Service } from './crm-whatsapp-v4.service';
import type { CrmOutboundMessageDto } from './dto';

const outboundRoute = {
  crmProjectId: 'cyber-pulse-staging',
  identity: {
    channel: 'whatsapp',
    channelIdentityId: 'identity-a',
    connectionId: 'connection-a',
  },
  omnicusContactId: 'contact-a',
  omnicusProjectId: 'project-a',
} as const;

const outbound: CrmOutboundMessageDto = {
  ...outboundRoute,
  text: 'Safe WhatsApp outbound text',
};

function fixture(options: { open?: boolean } = {}) {
  const open = options.open ?? true;
  const transaction = {
    auditLog: { create: vi.fn() },
    conversation: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      upsert: vi.fn().mockResolvedValue({
        id: 'conversation-a',
        serviceWindowExpiresAt: open ? new Date(Date.now() + 60_000) : null,
      }),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    idempotencyRecord: { create: vi.fn() },
    mediaAsset: { findFirst: vi.fn() },
    message: {
      create: vi.fn().mockResolvedValue({ id: 'message-a' }),
      findFirst: vi.fn().mockResolvedValue({ externalMessageId: 'wamid.reply' }),
    },
    outboxRecord: { create: vi.fn().mockResolvedValue({ id: 'outbox-a' }) },
  };
  const client = {
    $transaction: (callback: (tx: typeof transaction) => unknown) => callback(transaction),
    channelConnection: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'connection-a',
        status: 'ACTIVE',
        type: 'WHATSAPP',
        webhookMetadata: { graphApiVersion: 'v99.0' },
      }),
    },
    channelIdentity: {
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({
        channel: 'WHATSAPP',
        connection: {
          status: 'ACTIVE',
          type: 'WHATSAPP',
          webhookMetadata: { graphApiVersion: 'v99.0' },
        },
        connectionId: 'connection-a',
        contactId: 'contact-a',
        externalUserId: '15551234567',
        id: 'identity-a',
        projectId: 'project-a',
        status: 'ACTIVE',
      }),
    },
    contact: { findUnique: vi.fn().mockResolvedValue({ crmLeadId: 'lead-a' }) },
    conversation: {
      findUnique: vi.fn().mockResolvedValue({
        automationState: 'AUTO',
        lastInboundAt: new Date(Date.now() - 30_000),
        serviceWindowExpiresAt: open ? new Date(Date.now() + 60_000) : null,
      }),
    },
    idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(null) },
    message: {
      findFirst: vi.fn().mockResolvedValue({
        connectionId: 'connection-a',
        contactId: 'contact-a',
        direction: 'INBOUND',
        externalMessageId: 'wamid.inbound',
        id: 'message-inbound',
        projectId: 'project-a',
      }),
    },
    outboxRecord: {
      create: vi.fn().mockResolvedValue({ id: 'action-outbox-a' }),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    project: {
      findUnique: vi.fn().mockResolvedValue({
        crmConfig: { crmProjectId: 'cyber-pulse-staging', enabled: true },
        status: 'ACTIVE',
      }),
    },
    whatsAppMessageTemplate: { findMany: vi.fn(), findUnique: vi.fn() },
  };
  const queue = { enqueue: vi.fn() };
  const service = new CrmWhatsAppV4Service(
    { client } as never,
    queue as never,
    { get: () => 20 * 1024 * 1024 } as never,
  );
  return { client, queue, service, transaction };
}

describe('CrmWhatsAppV4Service', () => {
  it('queues a WhatsApp message through the durable WhatsApp outbox', async () => {
    const { queue, service, transaction } = fixture();
    await expect(service.queue(outbound, 'request-a', 'correlation-a')).resolves.toEqual({
      messageId: 'message-a',
      operationId: 'outbox-a',
      replayed: false,
      status: 'QUEUED',
    });
    expect(transaction.outboxRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          connectionId: 'connection-a',
          kind: 'WHATSAPP',
          payload: expect.objectContaining({
            channelIdentityId: 'identity-a',
            messageId: 'message-a',
          }),
        }),
      }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith('outbox-a');
    expect(JSON.stringify(transaction.auditLog.create.mock.calls)).not.toContain(outbound.text);
  });

  it('fails closed outside the service window before creating a message', async () => {
    const { service, transaction } = fixture({ open: false });
    await expect(service.queue(outbound, 'request-a', 'correlation-a')).rejects.toMatchObject({
      response: { code: 'CRM_WHATSAPP_TEMPLATE_REQUIRED' },
    });
    expect(transaction.message.create).not.toHaveBeenCalled();
  });

  it('rejects Telegram-only fields instead of silently dropping them', async () => {
    const { service } = fixture();
    await expect(
      service.queue({ ...outbound, disableNotification: false }, 'request-a', 'correlation-a'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an asset that was validated only for Telegram', async () => {
    const { service, transaction } = fixture();
    transaction.mediaAsset.findFirst.mockResolvedValue({
      id: '0f7e63d2-c9aa-4b57-bab7-f27a28d1cc92',
      providerMetadata: { validationChannel: 'telegram' },
      source: 'USER_UPLOAD',
    });
    await expect(
      service.queue(
        {
          ...outboundRoute,
          media: {
            kind: 'PHOTO',
            mediaAssetId: '0f7e63d2-c9aa-4b57-bab7-f27a28d1cc92',
          },
        },
        'media-a',
        'correlation-a',
      ),
    ).rejects.toMatchObject({
      response: { code: 'CRM_WHATSAPP_MEDIA_VALIDATION_REQUIRED' },
    });
    expect(transaction.message.create).not.toHaveBeenCalled();
  });

  it('reports an effective service window and WhatsApp-only capabilities', async () => {
    const { service } = fixture();
    await expect(
      service.capabilities({
        channel: 'whatsapp',
        channelIdentityId: 'identity-a',
        connectionId: 'connection-a',
        crmProjectId: 'cyber-pulse-staging',
        omnicusContactId: 'contact-a',
        omnicusProjectId: 'project-a',
      }),
    ).resolves.toMatchObject({
      capabilities: {
        explicitRetry: { limits: { statuses: ['FAILED'] }, supported: true },
        markMessageRead: { supported: true },
        messageTemplates: { supported: true },
        quote: { supported: false },
        scheduling: {
          limits: {
            applicationOwned: true,
            frequencies: [],
            maximumCount: 1,
            maximumInterval: 1,
            optimisticConcurrency: 'revision',
            recurring: false,
            timezone: 'IANA',
          },
          supported: true,
        },
        stickers: { limits: { animated: false, maximumBytes: 102_400 } },
      },
      channel: 'whatsapp',
      contractVersion: '4.0.0',
      providerApiVersion: 'v99.0',
      serviceWindow: { state: 'OPEN' },
    });
  });

  it('marks unreleased authentication templates unavailable and rejects them before outbox', async () => {
    const { client, service, transaction } = fixture();
    const authenticationTemplate = {
      category: 'AUTHENTICATION',
      components: [],
      id: 'template-a',
      languageCode: 'en_US',
      name: 'login_code',
      status: 'APPROVED',
    };
    client.whatsAppMessageTemplate.findMany.mockResolvedValue([authenticationTemplate]);
    await expect(
      service.templates({
        channel: 'whatsapp',
        channelIdentityId: 'identity-a',
        connectionId: 'connection-a',
        crmProjectId: 'cyber-pulse-staging',
        omnicusContactId: 'contact-a',
        omnicusProjectId: 'project-a',
      }),
    ).resolves.toEqual({
      data: [
        expect.objectContaining({
          disabledReason: 'WHATSAPP_AUTHENTICATION_TEMPLATE_UNSUPPORTED',
          sendable: false,
        }),
      ],
    });
    client.whatsAppMessageTemplate.findUnique.mockResolvedValue(authenticationTemplate);
    await expect(
      service.queue(
        {
          ...outboundRoute,
          template: { languageCode: 'en_US', name: 'login_code' },
        },
        'template-auth-a',
        'correlation-a',
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'CRM_WHATSAPP_TEMPLATE_UNSUPPORTED',
        reasonCode: 'WHATSAPP_AUTHENTICATION_TEMPLATE_UNSUPPORTED',
      },
    });
    expect(transaction.outboxRecord.create).not.toHaveBeenCalled();
  });

  it('removes provider-only template preview fields from the CRM contract', async () => {
    const { client, service } = fixture();
    client.whatsAppMessageTemplate.findMany.mockResolvedValue([
      {
        category: 'UTILITY',
        components: [
          {
            example: { body_text: [['Alex']], private: 'provider-only' },
            parameterStyle: 'positional',
            text: 'Hello {{1}}',
            type: 'BODY',
          },
          {
            buttons: [
              {
                dynamic: true,
                examples: ['https://example.test/order-1'],
                parameterStyle: 'named',
                text: 'Open',
                type: 'URL',
                url: 'https://example.test/{{customer_id}}',
              },
              {
                phoneNumber: '+15551234567',
                text: 'Call',
                type: 'PHONE_NUMBER',
              },
            ],
            type: 'BUTTONS',
          },
        ],
        id: 'template-a',
        languageCode: 'en_US',
        name: 'order_update',
        status: 'APPROVED',
      },
    ]);

    const result = await service.templates({
      channel: 'whatsapp',
      channelIdentityId: 'identity-a',
      connectionId: 'connection-a',
      crmProjectId: 'cyber-pulse-staging',
      omnicusContactId: 'contact-a',
      omnicusProjectId: 'project-a',
    });

    expect(result.data[0]?.components).toEqual([
      {
        parameterStyle: 'positional',
        text: 'Hello {{1}}',
        type: 'BODY',
      },
      {
        buttons: [
          {
            dynamic: true,
            parameterStyle: 'named',
            text: 'Open',
            type: 'URL',
            variableName: 'customer_id',
          },
          { text: 'Call', type: 'PHONE_NUMBER' },
        ],
        type: 'BUTTONS',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('provider-only');
    expect(JSON.stringify(result)).not.toContain('phoneNumber');
    expect(JSON.stringify(result)).not.toContain('example.test');
  });

  it('queues named template variables with their Meta parameter names', async () => {
    const { client, service, transaction } = fixture();
    client.whatsAppMessageTemplate.findUnique.mockResolvedValue({
      category: 'UTILITY',
      components: [{ parameterStyle: 'named', text: 'Hello {{customer_name}}', type: 'BODY' }],
      languageCode: 'en_US',
      name: 'named_update',
      status: 'APPROVED',
    });
    await expect(
      service.queue(
        {
          ...outboundRoute,
          template: {
            components: [
              {
                parameters: [{ parameterName: 'customer_name', text: 'Ada', type: 'text' }],
                type: 'body',
              },
            ],
            languageCode: 'en_US',
            name: 'named_update',
          },
        },
        'template-named-a',
        'correlation-a',
      ),
    ).resolves.toMatchObject({ messageId: 'message-a', status: 'QUEUED' });
    expect(transaction.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: expect.objectContaining({
            whatsAppTemplate: expect.objectContaining({
              components: [
                {
                  parameters: [{ parameterName: 'customer_name', text: 'Ada', type: 'text' }],
                  type: 'body',
                },
              ],
            }),
          }),
        }),
      }),
    );
    expect(transaction.outboxRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            messageId: 'message-a',
          }),
        }),
      }),
    );
  });

  it('queues mark-read against the same inbound message without a new bubble', async () => {
    const { client, service, transaction } = fixture();
    await expect(
      service.markRead(
        'message-inbound',
        {
          crmProjectId: 'cyber-pulse-staging',
          identity: outbound.identity,
          omnicusContactId: 'contact-a',
          omnicusProjectId: 'project-a',
        },
        'read-a',
        'correlation-a',
      ),
    ).resolves.toMatchObject({ messageId: 'message-inbound', status: 'QUEUED' });
    expect(client.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          connectionId: 'connection-a',
          contactId: 'contact-a',
          conversation: { externalChatId: '15551234567' },
          id: 'message-inbound',
          projectId: 'project-a',
        }),
      }),
    );
    expect(transaction.outboxRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'WHATSAPP',
          payload: expect.objectContaining({
            action: 'MARK_READ',
            messageId: 'message-inbound',
            providerMessageId: 'wamid.inbound',
          }),
        }),
      }),
    );
  });

  it('rejects mark-read for outbound messages', async () => {
    const { client, service } = fixture();
    client.message.findFirst.mockResolvedValue({
      connectionId: 'connection-a',
      contactId: 'contact-a',
      direction: 'OUTBOUND',
      externalMessageId: 'wamid.outbound',
      id: 'message-outbound',
      projectId: 'project-a',
      type: 'TEXT',
    });
    await expect(
      service.markRead(
        'message-outbound',
        {
          crmProjectId: 'cyber-pulse-staging',
          identity: outbound.identity,
          omnicusContactId: 'contact-a',
          omnicusProjectId: 'project-a',
        },
        'read-b',
        'correlation-a',
      ),
    ).rejects.toMatchObject({ response: { code: 'WHATSAPP_READ_TARGET_INVALID' } });
  });

  it('rejects mark-read for unsupported message types like SYSTEM', async () => {
    const { client, service } = fixture();
    client.message.findFirst.mockResolvedValue({
      connectionId: 'connection-a',
      contactId: 'contact-a',
      direction: 'INBOUND',
      externalMessageId: 'wamid.system',
      id: 'message-system',
      projectId: 'project-a',
      type: 'SYSTEM',
    });
    await expect(
      service.markRead(
        'message-system',
        {
          crmProjectId: 'cyber-pulse-staging',
          identity: outbound.identity,
          omnicusContactId: 'contact-a',
          omnicusProjectId: 'project-a',
        },
        'read-c',
        'correlation-a',
      ),
    ).rejects.toMatchObject({ response: { code: 'WHATSAPP_READ_TARGET_INVALID' } });
  });

  it('rejects mark-read when external message id is missing', async () => {
    const { client, service } = fixture();
    client.message.findFirst.mockResolvedValue({
      connectionId: 'connection-a',
      contactId: 'contact-a',
      direction: 'INBOUND',
      externalMessageId: null,
      id: 'message-missing-provider-id',
      projectId: 'project-a',
      type: 'TEXT',
    });
    await expect(
      service.markRead(
        'message-missing-provider-id',
        {
          crmProjectId: 'cyber-pulse-staging',
          identity: outbound.identity,
          omnicusContactId: 'contact-a',
          omnicusProjectId: 'project-a',
        },
        'read-d',
        'correlation-a',
      ),
    ).rejects.toMatchObject({ response: { code: 'WHATSAPP_READ_TARGET_INVALID' } });
  });

  it('returns existing MARK_READ operation for the same message instead of creating a duplicate', async () => {
    const { client, service, transaction, queue } = fixture();
    client.outboxRecord.findFirst.mockResolvedValue({
      id: 'existing-read-action',
      kind: 'WHATSAPP',
      status: 'SUCCEEDED',
      payload: {
        action: 'MARK_READ',
        messageId: 'message-inbound',
        providerMessageId: 'wamid.inbound',
      },
    });

    await expect(
      service.markRead(
        'message-inbound',
        {
          crmProjectId: 'cyber-pulse-staging',
          identity: outbound.identity,
          omnicusContactId: 'contact-a',
          omnicusProjectId: 'project-a',
        },
        'read-e',
        'correlation-a',
      ),
    ).resolves.toMatchObject({
      messageId: 'message-inbound',
      operationId: 'existing-read-action',
      replayed: true,
      status: 'QUEUED',
    });
    expect(transaction.outboxRecord.create).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('keeps ordinary WhatsApp replies scoped to the same conversation route', async () => {
    const { service, transaction } = fixture();
    await service.queue(
      { ...outbound, replyToMessageId: 'message-reply' },
      'reply-a',
      'correlation-a',
    );
    expect(transaction.message.findFirst).toHaveBeenCalledWith({
      select: { externalMessageId: true },
      where: {
        connectionId: 'connection-a',
        contactId: 'contact-a',
        conversationId: 'conversation-a',
        externalMessageId: { not: null },
        id: 'message-reply',
        projectId: 'project-a',
      },
    });
    expect(transaction.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: {
            channel: 'whatsapp',
            previewUrl: true,
            replyToMessageId: 'message-reply',
            source: 'crm',
          },
        }),
      }),
    );
  });

  it('queues one valid WhatsApp reaction and supports explicit removal', async () => {
    const added = fixture();
    await expect(
      added.service.reaction(
        'message-inbound',
        {
          crmProjectId: 'cyber-pulse-staging',
          emoji: '👍🏽',
          identity: outbound.identity,
          omnicusContactId: 'contact-a',
          omnicusProjectId: 'project-a',
        },
        'reaction-add',
        'correlation-a',
      ),
    ).resolves.toMatchObject({ status: 'QUEUED' });
    expect(added.transaction.outboxRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ action: 'SET_REACTION', emoji: '👍🏽' }),
        }),
      }),
    );

    const removed = fixture();
    await expect(
      removed.service.reaction(
        'message-inbound',
        {
          crmProjectId: 'cyber-pulse-staging',
          identity: outbound.identity,
          omnicusContactId: 'contact-a',
          omnicusProjectId: 'project-a',
        },
        'reaction-remove',
        'correlation-b',
      ),
    ).resolves.toMatchObject({ status: 'QUEUED' });
    expect(removed.transaction.outboxRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ action: 'SET_REACTION', emoji: '' }),
        }),
      }),
    );
  });

  it('rejects text and multiple graphemes as WhatsApp reactions', async () => {
    const { service, transaction } = fixture();
    await expect(
      service.reaction(
        'message-inbound',
        {
          crmProjectId: 'cyber-pulse-staging',
          emoji: 'not emoji',
          identity: outbound.identity,
          omnicusContactId: 'contact-a',
          omnicusProjectId: 'project-a',
        },
        'reaction-invalid-a',
        'correlation-a',
      ),
    ).rejects.toMatchObject({ response: { code: 'WHATSAPP_REACTION_INVALID' } });
    await expect(
      service.reaction(
        'message-inbound',
        {
          crmProjectId: 'cyber-pulse-staging',
          emoji: '👍🔥',
          identity: outbound.identity,
          omnicusContactId: 'contact-a',
          omnicusProjectId: 'project-a',
        },
        'reaction-invalid-b',
        'correlation-b',
      ),
    ).rejects.toMatchObject({ response: { code: 'WHATSAPP_REACTION_INVALID' } });
    expect(transaction.outboxRecord.create).not.toHaveBeenCalled();
  });

  it('creates an idempotent WhatsApp retry only for a definitive FAILED operation', async () => {
    const { client, queue, service, transaction } = fixture();
    client.outboxRecord.findUnique
      .mockResolvedValueOnce({
        connectionId: 'connection-a',
        id: 'failed-operation-a',
        kind: 'WHATSAPP',
        maxAttempts: 8,
        payload: { channelIdentityId: 'identity-a', messageId: 'message-inbound' },
        projectId: 'project-a',
        status: 'FAILED',
      })
      .mockResolvedValueOnce(null);
    await expect(
      service.retry(
        'failed-operation-a',
        {
          crmProjectId: 'cyber-pulse-staging',
          omnicusProjectId: 'project-a',
          retryRequestId: 'retry-a',
        },
        'correlation-a',
      ),
    ).resolves.toEqual({
      messageId: 'message-inbound',
      operationId: 'outbox-a',
      replayed: false,
      status: 'QUEUED',
    });
    expect(transaction.outboxRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: 'crm-retry-retry-a',
          kind: 'WHATSAPP',
          payload: expect.objectContaining({
            messageId: 'message-inbound',
            retryOfOperationId: 'failed-operation-a',
          }),
        }),
      }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith('outbox-a');
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'crm.whatsapp_operation.retry_queued',
          correlationId: 'correlation-a',
          entityId: 'outbox-a',
        }),
      }),
    );
  });

  it('does not retry an UNKNOWN WhatsApp operation', async () => {
    const { client, service, transaction } = fixture();
    client.outboxRecord.findUnique.mockResolvedValueOnce({
      connectionId: 'connection-a',
      id: 'unknown-operation-a',
      kind: 'WHATSAPP',
      maxAttempts: 8,
      payload: { channelIdentityId: 'identity-a', messageId: 'message-inbound' },
      projectId: 'project-a',
      status: 'UNKNOWN',
    });
    await expect(
      service.retry(
        'unknown-operation-a',
        {
          crmProjectId: 'cyber-pulse-staging',
          omnicusProjectId: 'project-a',
          retryRequestId: 'retry-a',
        },
        'correlation-a',
      ),
    ).rejects.toMatchObject({ response: { code: 'UNKNOWN_REQUIRES_RECONCILIATION' } });
    expect(transaction.outboxRecord.create).not.toHaveBeenCalled();
  });
});
