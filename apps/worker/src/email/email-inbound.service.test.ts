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
    text: null as string | null,
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
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...thread, ...data })),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
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
  return { service, tx, incoming, saved, receipt, client };
}

describe('durable incoming email import', () => {
  it.each([
    { 'In-Reply-To': '<sent@example.com>' },
    { References: '<older@example.com> <sent@example.com>' },
  ])('routes replies to the plain mailbox by RFC headers: %j', async (headers) => {
    const { service, tx, incoming, saved } = fixture();
    incoming.headers = headers;
    tx.emailMessage.findMany.mockResolvedValue([
      {
        rfcMessageId: '<sent@example.com>',
        thread: {
          id: 'original-thread',
          peerEmail: 'alice@example.com',
          contactId: 'c1',
          lastMessageAt: new Date(0),
          lastInboundAt: null,
        },
      },
    ] as never);
    await service.process('receipt');
    expect(saved).toMatchObject({
      threadId: 'original-thread',
      toAddress: 'sales@example.com',
      automationStatus: 'AWAITING_CONTENT',
    });
    expect(tx.emailThread.create).not.toHaveBeenCalled();
    expect(tx.emailMessage.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'p1',
        mailboxId: 'm1',
        rfcMessageId: { in: expect.arrayContaining(['<sent@example.com>']) },
      },
      include: { thread: true },
      take: 30,
    });
  });
  it('prefers the direct parent over older References from the same peer', async () => {
    const { service, tx, incoming, saved } = fixture();
    incoming.headers = {
      'In-Reply-To': '<parent@example.com>',
      References: '<older@example.com>',
    };
    tx.emailMessage.findMany.mockResolvedValue(
      ['older', 'parent'].map((id) => ({
        rfcMessageId: `<${id}@example.com>`,
        thread: {
          id,
          peerEmail: 'alice@example.com',
          contactId: 'c1',
          lastMessageAt: new Date(0),
        },
      })) as never,
    );
    await service.process('receipt');
    expect(saved.threadId).toBe('parent');
    expect(tx.emailThread.create).not.toHaveBeenCalled();
  });
  it('does not attach a referenced message from another peer', async () => {
    const { service, tx, incoming, saved } = fixture();
    incoming.headers = { 'In-Reply-To': '<foreign@example.com>' };
    tx.emailMessage.findMany.mockResolvedValue([
      {
        rfcMessageId: '<foreign@example.com>',
        thread: { id: 'foreign', peerEmail: 'bob@example.com' },
      },
    ] as never);
    await service.process('receipt');
    expect(tx.emailThread.create).toHaveBeenCalledTimes(1);
    expect(saved.threadId).toBe('t1');
  });
  it('starts a new thread without matching headers instead of guessing by subject or peer', async () => {
    const { service, tx, saved } = fixture();
    await service.process('receipt');
    expect(tx.emailMessage.findMany).not.toHaveBeenCalled();
    expect(tx.emailThread.findMany).not.toHaveBeenCalled();
    expect(tx.emailThread.create).toHaveBeenCalledTimes(1);
    expect(saved.threadId).toBe('t1');
  });
  it('still accepts legacy reply aliases without RFC headers', async () => {
    const { service, tx, incoming, receipt, saved } = fixture();
    const token = 'a'.repeat(36);
    receipt.recipient = `reply+${token}@example.com`;
    incoming.to = [receipt.recipient];
    tx.emailThread.findMany.mockResolvedValue([
      {
        id: 'legacy-thread',
        peerEmail: 'alice@example.com',
        contactId: 'c1',
        lastMessageAt: new Date(0),
      },
    ] as never);
    await service.process('receipt');
    expect(tx.emailThread.findMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', mailboxId: 'm1', replyToken: token },
      take: 5,
    });
    expect(tx.emailThread.create).not.toHaveBeenCalled();
    expect(saved.threadId).toBe('legacy-thread');
  });
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
  it('uses the received date and content preview when importing an older first message', async () => {
    const { service, tx, receipt } = fixture();
    receipt.occurredAt = new Date('2026-09-01T10:00:00Z');
    await service.process('receipt');
    expect(tx.emailThread.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: expect.objectContaining({
        lastMessageAt: receipt.occurredAt,
        lastInboundAt: receipt.occurredAt,
        preview: 'Hello team',
      }),
    });
  });
  it('bounds plain-text messages as well as HTML-derived text', async () => {
    const { service, incoming, saved } = fixture();
    incoming.text = 'x'.repeat(100_001);
    await service.process('receipt');
    expect(saved.textBody).toHaveLength(100_000);
  });
  it('keeps disabled mailboxes out of the bounded automation dispatch batch', async () => {
    const { service, client } = fixture();
    const findMany = vi.fn().mockResolvedValue([]);
    Object.assign(client.emailInboundReceipt, {
      updateMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    });
    Object.assign(client, { emailMessage: { findMany } });
    await service.drain();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: { project: { status: 'ACTIVE' }, mailbox: { status: 'ACTIVE', mode: 'TWO_WAY' } },
        }),
      }),
    );
  });
});
