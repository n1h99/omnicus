import { describe, expect, it, vi } from 'vitest';
import { attachMailboxDelivery } from './email-conversations';

function fixture() {
  const mailbox = {
    id: 'm1',
    address: 'sales@example.com',
    displayName: 'Company, LLC',
    status: 'ACTIVE',
    mode: 'TWO_WAY',
    domain: { status: 'verified', sendingEnabled: true, receivingReady: true },
  };
  const tx = {
    emailMessage: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        ...data,
        id: 'message1',
        occurredAt: new Date(),
      })),
    },
    emailDelivery: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'd1',
        projectId: 'p1',
        mailboxId: 'm1',
        normalizedEmail: 'client@example.com',
        subject: 'Question',
        source: 'MANUAL',
      }),
      update: vi.fn(),
    },
    emailMailbox: { findFirst: vi.fn().mockResolvedValue(mailbox) },
    emailThread: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...data, id: 't1' })),
      update: vi.fn(),
    },
  };
  return { tx, mailbox };
}
describe('mailbox delivery snapshots', () => {
  it('saves a quoted sender and durable reply token without a provider request', async () => {
    const { tx } = fixture();
    await attachMailboxDelivery(tx as never, 'd1', { projectId: 'p1', textBody: 'Hello' });
    expect(tx.emailDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({
        senderSnapshot: '"Company, LLC" <sales@example.com>',
        replyToSnapshot: expect.stringMatching(/^reply\+[a-f0-9]{36}@example\.com$/),
      }),
    });
    expect(tx.emailMessage.create.mock.calls[0]![0].data.textBody).toBe('Hello');
  });
  it('keeps existing message snapshots unchanged on delivery retries', async () => {
    const { tx } = fixture();
    tx.emailMessage.findFirst.mockResolvedValue({ id: 'existing' } as never);
    expect(await attachMailboxDelivery(tx as never, 'd1', { projectId: 'p1' })).toEqual({
      id: 'existing',
    });
    expect(tx.emailDelivery.update).not.toHaveBeenCalled();
    expect(tx.emailThread.create).not.toHaveBeenCalled();
  });
  it('does not attach a foreign mailbox or peer to a supplied thread', async () => {
    const { tx } = fixture();
    await expect(
      attachMailboxDelivery(tx as never, 'd1', { projectId: 'p1', threadId: 'foreign' }),
    ).rejects.toThrow('email_thread_recipient_mismatch');
    expect(tx.emailThread.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign', projectId: 'p1', mailboxId: 'm1', peerEmail: 'client@example.com' },
    });
    expect(tx.emailMessage.create).not.toHaveBeenCalled();
  });
  it('rejects an unverified sender before creating history', async () => {
    const { tx, mailbox } = fixture();
    mailbox.domain.status = 'pending';
    await expect(attachMailboxDelivery(tx as never, 'd1', { projectId: 'p1' })).rejects.toThrow(
      'email_sender_not_ready',
    );
    expect(tx.emailThread.create).not.toHaveBeenCalled();
  });
});
