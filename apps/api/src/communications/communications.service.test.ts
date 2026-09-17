import { describe, expect, it, vi } from 'vitest';

import { CommunicationsService } from './communications.service';

const actor = {
  email: 'manager@example.com',
  globalPermissions: [],
  globalRoleNames: [],
  userId: 'user-a',
};
const context = { correlationId: 'correlation-a' };

function activeIdentity() {
  return {
    channel: 'WHATSAPP',
    connection: { status: 'ACTIVE', type: 'WHATSAPP' },
    connectionId: 'connection-a',
    contactId: 'contact-a',
    externalUserId: '994501234567',
    id: 'identity-a',
    status: 'ACTIVE',
    whatsAppReachability: 'AVAILABLE',
  };
}

describe('CommunicationsService', () => {
  it('queues an official Meta template as an Omnicus operator action', async () => {
    const whatsApp = { queue: vi.fn().mockResolvedValue({ messageId: 'message-a' }) };
    const client = {
      channelIdentity: { findUnique: vi.fn().mockResolvedValue(activeIdentity()) },
      contact: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ status: 'ACTIVE', whatsAppConsentStatus: 'GRANTED' }),
      },
    };
    const service = new CommunicationsService(
      { client } as never,
      { queue: vi.fn() } as never,
      whatsApp as never,
    );

    await service.send(
      'project-a',
      'contact-a',
      {
        channel: 'WHATSAPP',
        clientRequestId: 'request-a',
        identityId: 'identity-a',
        template: { languageCode: 'en_US', name: 'order_update' },
      },
      actor,
      context,
    );

    expect(whatsApp.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          channel: 'whatsapp',
          channelIdentityId: 'identity-a',
          connectionId: 'connection-a',
        },
        template: { languageCode: 'en_US', name: 'order_update' },
      }),
      'request-a',
      'correlation-a',
      'project-a',
      { actorEmail: 'manager@example.com', actorUserId: 'user-a', source: 'omnicus' },
    );
  });

  it('creates a WhatsApp identity from an opted-in contact for first contact', async () => {
    const identity = { ...activeIdentity(), whatsAppReachability: 'PENDING' };
    const whatsApp = { queue: vi.fn().mockResolvedValue({ messageId: 'message-a' }) };
    const client = {
      $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => callback(client)),
      channelConnection: {
        findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', type: 'WHATSAPP' }),
      },
      channelIdentity: {
        create: vi.fn().mockResolvedValue(identity),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      contact: {
        findUnique: vi.fn().mockResolvedValue({
          normalizedPhone: '994501234567',
          phone: '+994 50 123 45 67',
          status: 'ACTIVE',
          whatsAppConsentStatus: 'GRANTED',
        }),
      },
      crmProjectConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new CommunicationsService(
      { client } as never,
      { queue: vi.fn() } as never,
      whatsApp as never,
    );

    await service.send(
      'project-a',
      'contact-a',
      {
        channel: 'WHATSAPP',
        clientRequestId: 'request-a',
        connectionId: 'connection-a',
        template: { languageCode: 'en_US', name: 'welcome' },
      },
      actor,
      context,
    );

    expect(client.channelIdentity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        channel: 'WHATSAPP',
        connectionId: 'connection-a',
        contactId: 'contact-a',
        externalUserId: '994501234567',
        projectId: 'project-a',
        whatsAppReachability: 'PENDING',
      }),
    });
    expect(whatsApp.queue).toHaveBeenCalledOnce();
  });

  it('refuses an official template when WhatsApp consent is not granted', async () => {
    const whatsApp = { queue: vi.fn() };
    const client = {
      channelIdentity: { findUnique: vi.fn().mockResolvedValue(activeIdentity()) },
      contact: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ status: 'ACTIVE', whatsAppConsentStatus: 'REVOKED' }),
      },
    };
    const service = new CommunicationsService(
      { client } as never,
      { queue: vi.fn() } as never,
      whatsApp as never,
    );

    await expect(
      service.send(
        'project-a',
        'contact-a',
        {
          channel: 'WHATSAPP',
          clientRequestId: 'request-a',
          identityId: 'identity-a',
          template: { languageCode: 'en_US', name: 'marketing_offer' },
        },
        actor,
        context,
      ),
    ).rejects.toMatchObject({ response: { code: 'COMMUNICATION_WHATSAPP_CONSENT_REQUIRED' } });
    expect(whatsApp.queue).not.toHaveBeenCalled();
  });
});
