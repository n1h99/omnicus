import { describe, expect, it, vi } from 'vitest';
import { WhatsAppInboundProcessorService } from './whatsapp-inbound-processor.service';

describe('delivery pricing projection', () => {
  async function process(
    status: string,
    metadata: Record<string, unknown> = {},
    targetStatus = 'SENT',
  ) {
    const transaction = {
      channelConnection: {
        findUnique: vi.fn().mockResolvedValue({ type: 'WHATSAPP', status: 'ACTIVE' }),
      },
      message: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'message-a',
          contactId: 'contact-a',
          conversation: { externalChatId: '351934000000' },
          status: targetStatus,
          metadata,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      normalizedEvent: { create: vi.fn().mockResolvedValue({ id: 'event-a' }) },
      messageStatusEvent: { create: vi.fn().mockResolvedValue({}) },
      broadcastRecipient: { updateMany: vi.fn() },
      channelIdentity: { updateMany: vi.fn() },
      inboxRecord: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const instance = new WhatsAppInboundProcessorService(
      { get: () => false } as never,
      { client: { $transaction: (fn: (tx: unknown) => unknown) => fn(transaction) } } as never,
    ) as unknown as { persistStatus(claimed: unknown, status: unknown): Promise<void> };
    await instance.persistStatus(
      {
        id: 'inbox-a',
        connectionId: 'connection-a',
        projectId: 'project-a',
        rawWebhookEvent: { receivedAt: new Date('2026-09-10T12:00:00Z') },
      },
      {
        id: 'wamid-a',
        status,
        timestamp: '1789041600',
        pricing: {
          pricing_model: 'PMP',
          billable: true,
          type: 'regular',
          category: 'marketing',
          private: 'not-preserved',
        },
      },
    );
    return transaction;
  }
  it('preserves existing metadata and stores only Meta-reported delivered-message pricing', async () => {
    const tx = await process('delivered', { channel: 'whatsapp', auditSource: 'crm' });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { projectId_id: { id: 'message-a', projectId: 'project-a' } },
      data: {
        metadata: {
          channel: 'whatsapp',
          auditSource: 'crm',
          whatsappPricing: {
            pricingModel: 'PMP',
            category: 'marketing',
            type: 'regular',
            billable: true,
            reportedAt: expect.any(String),
          },
        },
      },
    });
    expect(tx.normalizedEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            pricing: {
              pricingModel: 'PMP',
              category: 'marketing',
              type: 'regular',
              billable: true,
            },
          }),
        }),
      }),
    );
  });
  it.each(['sent', 'failed'])('does not claim a charge on a %s notification', async (status) => {
    const tx = await process(status);
    expect(JSON.stringify(tx.message.update.mock.calls)).not.toContain('whatsappPricing');
  });
  it('does not double-apply pricing on a later read notification', async () => {
    const tx = await process(
      'read',
      { whatsappPricing: { billable: true, reportedAt: 'original' } },
      'DELIVERED',
    );
    expect(JSON.stringify(tx.message.update.mock.calls)).not.toContain('whatsappPricing');
  });
});
