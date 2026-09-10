import { afterEach, describe, expect, it, vi } from 'vitest';
import { BroadcastsService } from './broadcasts.service';

afterEach(() => vi.useRealTimers());

describe('WhatsApp broadcast cost estimation', () => {
  function setup(scheduledAt: Date | null = null) {
    const client = {
      broadcast: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'broadcast-a',
          connectionId: 'channel-a',
          audience: { mode: 'CONTACTS', contactIds: ['contact-a', 'contact-b'] },
          scheduledAt,
          content: {
            whatsAppTemplate: {
              templateId: 'template-a',
              name: 'reminder',
              languageCode: 'en_US',
            },
          },
        }),
      },
      channelConnection: {
        findUnique: vi.fn().mockResolvedValue({ type: 'WHATSAPP', status: 'ACTIVE' }),
      },
      whatsAppMessageTemplate: { findFirst: vi.fn().mockResolvedValue({ category: 'UTILITY' }) },
      channelIdentity: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { externalUserId: '351934000000' },
            { externalUserId: '351934000001' },
          ]),
      },
      conversation: {
        findMany: vi.fn().mockResolvedValue([
          {
            externalChatId: '351934000000',
            serviceWindowExpiresAt: new Date('2026-09-10T13:00:00Z'),
          },
        ]),
      },
    };
    const service = new BroadcastsService(
      {} as never,
      { client } as never,
      {} as never,
      {} as never,
    );
    return { service, client };
  }
  it('uses the sending audience, current approved category and connection-scoped windows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const { service, client } = setup();
    const result = await service.estimate('project-a', 'broadcast-a');
    expect(result).toMatchObject({
      eligibleRecipients: 2,
      cost: { estimatedCost: 0.0171, free: 1, paid: 1 },
    });
    expect(client.broadcast.findUnique).toHaveBeenCalledWith({
      where: { projectId_id: { projectId: 'project-a', id: 'broadcast-a' } },
    });
    expect(client.channelIdentity.findMany).toHaveBeenCalledWith({
      select: { externalUserId: true },
      where: {
        projectId: 'project-a',
        connectionId: 'channel-a',
        channel: 'WHATSAPP',
        status: 'ACTIVE',
        whatsAppReachability: 'AVAILABLE',
        contact: {
          is: {
            projectId: 'project-a',
            status: 'ACTIVE',
            whatsAppConsentStatus: 'GRANTED',
            id: { in: ['contact-a', 'contact-b'] },
          },
        },
      },
    });
    expect(client.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: 'project-a',
          connectionId: 'channel-a',
          serviceWindowExpiresAt: { gt: new Date('2026-09-10T12:00:00Z') },
        },
      }),
    );
  });
  it('accounts for windows expiring by a scheduled send, and refuses stale rate cards', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    expect(
      await setup(new Date('2026-09-11T12:00:00Z')).service.estimate('project-a', 'broadcast-a'),
    ).toMatchObject({ cost: { estimatedCost: 0.0342, free: 0, paid: 2 } });
    expect(
      await setup(new Date('2026-10-01T00:00:00Z')).service.estimate('project-a', 'broadcast-a'),
    ).toMatchObject({ cost: { estimatedCost: null, unavailableReason: 'RATE_CARD_EXPIRED' } });
  });
  it('does not leak internal message metadata through recipient pricing', async () => {
    const client = {
      broadcast: { findUnique: vi.fn().mockResolvedValue({ id: 'b' }) },
      broadcastRecipient: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'recipient-a',
            message: {
              metadata: {
                private: 'secret',
                whatsappPricing: {
                  pricingModel: 'PMP',
                  billable: false,
                  category: 'utility',
                  type: 'free_customer_service',
                  providerSecret: 'secret',
                },
              },
            },
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
      $transaction: (promises: Promise<unknown>[]) => Promise.all(promises),
    };
    const service = new BroadcastsService(
      {} as never,
      { client } as never,
      {} as never,
      {} as never,
    );
    const result = await service.recipients('p', 'b', { page: 1, pageSize: 20 });
    expect(result.items[0]).toEqual({
      id: 'recipient-a',
      pricing: {
        pricingModel: 'PMP',
        billable: false,
        category: 'utility',
        type: 'free_customer_service',
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
