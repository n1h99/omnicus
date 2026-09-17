import { createHash, createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { EmailInboxService } from './email-inbox.service';
import { EmailWebhooksService } from '../email/email-webhooks.service';
import { EmailService } from '../email/email.service';

const actor = {
  userId: 'user-a',
  email: 'a@example.test',
  globalPermissions: [],
  globalRoleNames: [],
};
const emailId = '11111111-1111-4111-8111-111111111111';
function service(client: unknown, manager = false) {
  return new EmailInboxService(
    { client } as never,
    { hasProjectPermission: vi.fn().mockResolvedValue(manager) } as never,
    { record: vi.fn() } as never,
    new ConfigService({}) as never,
  );
}
describe('Email Inbox access and queue safety', () => {
  it('scopes operators to their project and shared/assigned mailboxes', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      service({ emailMailbox: { findFirst } }).assertMailbox('p1', 'foreign-mailbox', actor),
    ).rejects.toThrow();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'p1',
          id: 'foreign-mailbox',
          OR: [
            { shared: true },
            { members: { some: { userId: 'user-a', membership: { status: 'ACTIVE' } } } },
          ],
        }),
      }),
    );
  });
  it('still tenant-scopes email managers', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      service({ emailMailbox: { findFirst } }, true).assertMailbox('p1', 'foreign', actor),
    ).rejects.toThrow();
    expect(findFirst.mock.calls[0]![0].where).toEqual({ projectId: 'p1', id: 'foreign' });
  });
  it('rejects an unrelated thread cursor before reading message content', async () => {
    const findMany = vi.fn();
    const inbox = service({
      emailThread: { findFirst: vi.fn().mockResolvedValue({ id: 't1', replyToken: 'private' }) },
      emailMessage: { findFirst: vi.fn().mockResolvedValue(null), findMany },
    });
    await expect(inbox.thread('p1', 't1', actor, emailId)).rejects.toThrow('email_cursor_invalid');
    expect(findMany).not.toHaveBeenCalled();
  });
  it('requires the platform domain administrator before any provider or database lookup', async () => {
    await expect(service({}).availableDomains('p1', actor)).rejects.toThrow();
  });
  it('creates only durable deduplicated receipts for exact configured recipients', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const inbox = service({
      emailMailbox: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'm1', projectId: 'p1', address: 'sales@example.com' }]),
      },
      emailInboundReceipt: { createMany },
    });
    await inbox.receive(
      {
        type: 'email.received',
        created_at: '2026-09-15T00:00:00Z',
        data: { email_id: emailId, to: ['sales@example.com', 'sales@example.com'] },
      },
      'svix1',
    );
    expect(createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        expect.objectContaining({
          mailboxId: 'm1',
          projectId: 'p1',
          providerEmailId: emailId,
          recipient: 'sales@example.com',
        }),
      ],
    });
  });
  it('does not route a valid reply token through another domain', async () => {
    const token = 'b'.repeat(36),
      createMany = vi.fn();
    const inbox = service({
      emailMailbox: { findMany: vi.fn().mockResolvedValue([]) },
      emailThread: {
        findMany: vi.fn().mockResolvedValue([
          {
            replyToken: token,
            mailboxId: 'm1',
            mailbox: { address: 'sales@example.com', projectId: 'p1' },
          },
        ]),
      },
      emailInboundReceipt: { createMany },
    });
    expect(
      await inbox.receive(
        {
          type: 'email.received',
          created_at: '2026-09-15T00:00:00Z',
          data: { email_id: emailId, to: ['reply+' + token + '@other.com'] },
        },
        'svix2',
      ),
    ).toEqual({ accepted: true, ignored: true });
    expect(createMany).toHaveBeenCalledWith({ data: [], skipDuplicates: true });
  });
  it('keeps drafts private even when the caller manages all mailboxes', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await service({ emailDraft: { findMany } }, true).drafts('p1', actor);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: 'p1', userId: actor.userId }),
      }),
    );
  });
});

describe('manual email send replay and privacy', () => {
  const input = {
    mailboxId: 'm1',
    requestId: emailId,
    to: 'client@example.com',
    subject: 'Question',
    text: 'Hello {{ literal }}',
  };
  function ready(existing: unknown = null) {
    const client = {
      project: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      emailMessage: { findUnique: vi.fn().mockResolvedValue(existing) },
      emailSuppression: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(),
    };
    const inbox = service(client);
    vi.spyOn(inbox, 'assertMailbox').mockResolvedValue({ id: 'm1', signature: '' } as never);
    return { client, inbox };
  }
  it('returns the original queued result before looking for an already-consumed draft', async () => {
    const request = { ...input, draftId: emailId, draftRevision: 2 };
    const { inbox, client } = ready({
      id: 'message1',
      threadId: 't1',
      deliveryId: 'delivery1',
      requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    });
    await expect(inbox.send('p1', request, actor)).resolves.toEqual({
      id: 'message1',
      threadId: 't1',
      deliveryId: 'delivery1',
    });
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(client.emailMessage.findUnique).toHaveBeenCalledWith({
      where: { projectId_requestKey: { projectId: 'p1', requestKey: 'manual:user-a:' + emailId } },
    });
  });
  it('refuses reusing a request ID with different content', async () => {
    const { inbox, client } = ready({ requestHash: 'different' });
    await expect(inbox.send('p1', input, actor)).rejects.toThrow('email_request_id_reused');
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it('reconciles an already queued request even if sending was paused after a lost response', async () => {
    const { inbox, client } = ready({
      id: 'message1',
      threadId: 't1',
      deliveryId: 'delivery1',
      requestHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    });
    client.project.findUnique.mockResolvedValue({ status: 'PAUSED' });
    vi.mocked(inbox.assertMailbox).mockImplementation(async (_project, _id, _actor, send) => {
      if (send) throw new Error('email_sender_not_ready');
      return { id: 'm1', signature: '' } as never;
    });
    await expect(inbox.send('p1', input, actor)).resolves.toMatchObject({
      deliveryId: 'delivery1',
    });
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it('cannot send to a suppressed address through the manual composer', async () => {
    const { inbox, client } = ready();
    client.emailSuppression.findUnique.mockResolvedValue({} as never);
    await expect(inbox.send('p1', input, actor)).rejects.toThrow('email_address_suppressed');
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it('does not allow replies to silently change the thread recipient', async () => {
    const { inbox, client } = ready();
    vi.spyOn(inbox, 'assertThread').mockResolvedValue({
      mailboxId: 'm1',
      peerEmail: 'other@example.com',
    } as never);
    await expect(inbox.send('p1', { ...input, threadId: 't1' }, actor)).rejects.toThrow(
      'email_thread_recipient_mismatch',
    );
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it('does not expose manual correspondence through the older broadcast delivery endpoint', async () => {
    const client = {
      emailDelivery: { findUnique: vi.fn().mockResolvedValue({ source: 'MANUAL' }) },
    };
    const email = new EmailService({ client } as never, {} as never, {} as never, {} as never);
    await expect(email.getDelivery('p1', 'manual-delivery')).rejects.toThrow();
  });
  it('excludes manual correspondence from project-wide campaign analytics', async () => {
    const client = {
      emailEvent: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    };
    const email = new EmailService({ client } as never, {} as never, {} as never, {} as never);
    await email.listAnalytics('p1', '1', '25');
    expect(client.emailEvent.count).toHaveBeenCalledWith({
      where: { projectId: 'p1', delivery: { source: { not: 'MANUAL' } } },
    });
  });
});

describe('private draft revision safety', () => {
  const input = {
    mailboxId: 'm1',
    revision: 0,
    to: 'client@example.com',
    subject: 'Private notes',
    text: 'First version',
    assetIds: [] as string[],
  };
  function draftFixture(revision = 1) {
    const draft = {
      id: emailId,
      projectId: 'p1',
      userId: actor.userId,
      mailboxId: 'm1',
      threadId: null,
      revision,
      toEmail: input.to,
      subject: input.subject,
      textBody: input.text,
      assetIds: [],
    };
    const tx = {
      $executeRaw: vi.fn(),
      emailDraft: {
        findFirst: vi.fn().mockResolvedValue(draft),
        count: vi.fn().mockResolvedValue(1),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockImplementation(async ({ where }) => ({
          count: where.revision === draft.revision && where.userId === draft.userId ? 1 : 0,
        })),
      },
      emailAssetReference: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const inbox = service({
      ...tx,
      mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: (callback: (value: unknown) => unknown) => callback(tx),
    });
    vi.spyOn(inbox, 'assertMailbox').mockResolvedValue({ id: 'm1' } as never);
    return { inbox, tx, draft };
  }
  it.each([0, 3])(
    'recovers a lost save response for revision %i without overwriting the draft',
    async (revision) => {
      const { inbox, tx, draft } = draftFixture(revision + 1);
      await expect(inbox.saveDraft('p1', emailId, { ...input, revision }, actor)).resolves.toEqual(
        draft,
      );
      expect(tx.emailDraft.createMany).not.toHaveBeenCalled();
      expect(tx.emailDraft.updateMany).not.toHaveBeenCalled();
      expect(tx.emailAssetReference.deleteMany).not.toHaveBeenCalled();
    },
  );
  it('rejects a stale edit with different content', async () => {
    const { inbox, tx } = draftFixture(2);
    await expect(
      inbox.saveDraft('p1', emailId, { ...input, revision: 1, text: 'Stale edit' }, actor),
    ).rejects.toThrow('email_draft_changed');
    expect(tx.emailAssetReference.deleteMany).not.toHaveBeenCalled();
  });
  it('preserves a newer draft and its attachments when deletion uses an old revision', async () => {
    const { inbox, tx } = draftFixture(2);
    await expect(inbox.deleteDraft('p1', emailId, 1, actor)).rejects.toThrow('email_draft_changed');
    expect(tx.emailAssetReference.deleteMany).not.toHaveBeenCalled();
    await expect(inbox.deleteDraft('p1', emailId, 2, actor)).resolves.toEqual({ deleted: true });
    expect(tx.emailAssetReference.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('signed receiving webhook', () => {
  it('accepts a valid signature but rejects tampering before inbox persistence', async () => {
    const secretBytes = Buffer.from('test-webhook-secret-only'),
      secret = 'whsec_' + secretBytes.toString('base64');
    const timestamp = String(Math.floor(Date.now() / 1000)),
      id = 'msg_fixture';
    const raw = JSON.stringify({
      type: 'email.received',
      created_at: new Date().toISOString(),
      data: { email_id: emailId, to: ['sales@example.com'] },
    });
    const signature =
      'v1,' +
      createHmac('sha256', secretBytes).update(`${id}.${timestamp}.${raw}`).digest('base64');
    const receive = vi.fn().mockResolvedValue({ accepted: true });
    const webhooks = new EmailWebhooksService(
      new ConfigService({ RESEND_WEBHOOK_SECRET: secret }) as never,
      {} as never,
      {} as never,
      { receive } as never,
    );
    await expect(webhooks.receive(Buffer.from(raw), { id, timestamp, signature })).resolves.toEqual(
      { accepted: true },
    );
    await expect(
      webhooks.receive(Buffer.from(raw.replace('sales', 'other')), { id, timestamp, signature }),
    ).rejects.toThrow('resend_webhook_signature_invalid');
    expect(receive).toHaveBeenCalledTimes(1);
  });
});
