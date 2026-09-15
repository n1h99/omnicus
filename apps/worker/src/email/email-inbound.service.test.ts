import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { EmailInboundService } from './email-inbound.service';

function fixture(duplicate = false) {
  const incoming = {
    id: 'provider-id',
    from: 'Alice <alice@example.com>',
    to: ['sales@example.com'],
    cc: [],
    bcc: [],
    reply_to: [],
    subject: 'A question',
    text: null,
    html: '<p>Hello <strong>team</strong></p>',
    message_id: '<alice-1@example.com>',
    headers: {},
    attachments: [],
  };
  const saved: Record<string, unknown> = {};
  const receipt = {
    id: 'receipt',
    projectId: 'p1',
    mailboxId: 'm1',
    providerEmailId: incoming.id,
    recipient: 'sales@example.com',
    occurredAt: new Date(),
    status: 'PROCESSING',
    lockedBy: 'fixture',
  };
  const thread = { id: 't1', contactId: 'c1', lastMessageAt: new Date(0), lastInboundAt: null };
  const tx = {
    $executeRaw: vi.fn(),
    emailMailbox: {
      findFirst: vi.fn().mockResolvedValue({ id: 'm1', address: 'sales@example.com' }),
    },
    emailMessage: {
      findFirst: vi.fn().mockResolvedValue(duplicate ? { id: 'msg1', isAutomatic: false } : null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => {
        Object.assign(saved, data);
        return { ...data, id: 'msg1' };
      }),
      updateMany: vi.fn(),
    },
    emailThread: {
      create: vi.fn().mockResolvedValue(thread),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    },
    contact: { findMany: vi.fn().mockResolvedValue([{ id: 'c1' }]) },
    emailThreadUserState: { updateMany: vi.fn() },
    emailAttachment: { createMany: vi.fn() },
    emailInboundReceipt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const client = {
    emailInboundReceipt: { findUnique: vi.fn().mockResolvedValue(receipt) },
    emailAttachment: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: (callback: (transaction: unknown) => unknown) => callback(tx),
  };
  const service = new EmailInboundService(
    { client } as never,
    new ConfigService({}) as never,
    {} as never,
  );
  Object.assign(service, {
    workerId: 'fixture',
    provider: { received: vi.fn().mockResolvedValue(incoming) },
  });
  return { service, tx, incoming, saved, receipt };
}

describe('durable incoming email import', () => {
  it('stores HTML and safe extracted text, links only a unique active contact, then queues automation', async () => {
    const { service, tx, saved } = fixture();
    await service.process('receipt');
    expect(saved).toMatchObject({
      direction: 'INBOUND',
      projectId: 'p1',
      mailboxId: 'm1',
      threadId: 't1',
      textBody: 'Hello team',
      automationStatus: 'AWAITING_CONTENT',
    });
    expect(tx.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'p1', normalizedEmail: 'alice@example.com', status: 'ACTIVE' },
        take: 2,
      }),
    );
    expect(tx.emailMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { automationStatus: 'PENDING' } }),
    );
  });
  it('does not add another message or increment the thread on provider replay', async () => {
    const { service, tx } = fixture(true);
    await service.process('receipt');
    expect(tx.emailMessage.create).not.toHaveBeenCalled();
    expect(tx.emailThread.update).not.toHaveBeenCalled();
    expect(tx.emailInboundReceipt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lockedBy: 'fixture' }),
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });
  it('rejects mismatched fetched recipients and lost leases before persisting content', async () => {
    const mismatch = fixture();
    mismatch.incoming.to = ['foreign@example.com'];
    await expect(mismatch.service.process('receipt')).rejects.toThrow(
      'email_inbound_recipient_mismatch',
    );
    expect(mismatch.tx.emailMessage.create).not.toHaveBeenCalled();
    const lost = fixture();
    lost.receipt.lockedBy = 'other-worker';
    await lost.service.process('receipt');
    expect(lost.tx.emailMessage.create).not.toHaveBeenCalled();
  });
  it('marks automatic email as visible history without automation', async () => {
    const current = fixture();
    current.incoming.headers = { 'Auto-Submitted': 'auto-replied' };
    await current.service.process('receipt');
    expect(current.saved.isAutomatic).toBe(true);
    expect(current.tx.emailMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { automationStatus: 'NONE' } }),
    );
  });
});
