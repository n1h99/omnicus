import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CrmEmailService } from './crm-email.service';
import { EmailInboxService } from '../email-inbox/email-inbox.service';

const scope = {
  crmProjectId: 'crm-a',
  omnicusProjectId: 'project-a',
  crmLeadId: 'lead-a',
  crmUserId: 'manager-a',
};
const actor = {
  kind: 'crm' as const,
  userId: 'manager-a',
  crmLeadId: 'lead-a',
  contactId: 'contact-a',
};
function fixture() {
  const database = {
    client: {
      contact: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'contact-a',
          email: 'lead@example.com',
          normalizedEmail: 'lead@example.com',
          status: 'ACTIVE',
        }),
      },
      emailMessage: { findFirst: vi.fn().mockResolvedValue(null) },
      project: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    },
  };
  const outbound = { assertProjectRoute: vi.fn() };
  const inbox = {
    mailboxes: vi.fn().mockResolvedValue([]),
    threads: vi.fn(),
    thread: vi.fn(),
    send: vi.fn(),
    assertMailbox: vi.fn(),
    attachment: vi.fn(),
    outgoingAttachment: vi.fn(),
  };
  const media = { uploadFromService: vi.fn() };
  return {
    database,
    outbound,
    inbox,
    media,
    service: new CrmEmailService(
      database as never,
      outbound as never,
      inbox as never,
      media as never,
    ),
  };
}

describe('CRM email boundary', () => {
  it('uploads only after checking the active contact, project and shared sending mailbox', async () => {
    const f = fixture();
    const input = { ...scope, requestId: 'request', mailboxId: 'mailbox' };
    const file = {
      buffer: Buffer.from('pdf'),
      size: 3,
      originalname: 'offer.pdf',
      mimetype: 'application/pdf',
    };
    await f.service.upload(input, file, scope.omnicusProjectId);
    expect(f.inbox.assertMailbox).toHaveBeenCalledWith(
      scope.omnicusProjectId,
      'mailbox',
      actor,
      true,
    );
    expect(f.media.uploadFromService).toHaveBeenCalledWith(
      scope.omnicusProjectId,
      'DOCUMENT',
      file,
      JSON.stringify(['contact-a', 'manager-a', 'request']),
      'request',
      'email',
      { contactId: 'contact-a', userId: 'manager-a' },
    );
    f.inbox.assertMailbox.mockRejectedValueOnce(new Error('private mailbox'));
    await expect(f.service.upload(input, file)).rejects.toThrow('private mailbox');
    expect(f.media.uploadFromService).toHaveBeenCalledTimes(1);
    f.database.client.project.findUnique.mockResolvedValue({ status: 'ARCHIVED' });
    await expect(f.service.upload(input, file)).rejects.toThrow('email_project_not_active');
    expect(f.media.uploadFromService).toHaveBeenCalledTimes(1);
  });
  it('passes the mapped contact and authenticated actor for both download paths', async () => {
    const f = fixture();
    await f.service.attachment(scope, 'incoming');
    await f.service.outgoingAttachment(scope, 'message', 'asset');
    expect(f.inbox.attachment).toHaveBeenCalledWith(scope.omnicusProjectId, 'incoming', actor);
    expect(f.inbox.outgoingAttachment).toHaveBeenCalledWith(
      scope.omnicusProjectId,
      'message',
      'asset',
      actor,
    );
    f.outbound.assertProjectRoute.mockRejectedValueOnce(new Error('route'));
    await expect(f.service.attachment(scope, 'incoming', 'foreign')).rejects.toThrow('route');
    expect(f.inbox.attachment).toHaveBeenCalledTimes(1);
  });
  it('reconciles a repeated CRM send without creating another delivery', async () => {
    const input = {
      requestId: 'request-a',
      mailboxId: 'mailbox-a',
      to: 'lead@example.com',
      subject: 'Hello',
      text: 'Test',
    };
    const findUnique = vi.fn().mockResolvedValue({
      id: 'message-a',
      threadId: 'thread-a',
      deliveryId: 'delivery-a',
      requestHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    });
    const transaction = vi.fn();
    const inbox = new EmailInboxService(
      { client: { emailMessage: { findUnique }, $transaction: transaction } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(inbox, 'assertMailbox').mockResolvedValue({ id: 'mailbox-a' } as never);
    await expect(inbox.send('project-a', input, actor)).resolves.toMatchObject({
      deliveryId: 'delivery-a',
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        projectId_requestKey: {
          projectId: 'project-a',
          requestKey: 'crm:lead-a:manager-a:request-a',
        },
      },
    });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('rejects the wrong project token before looking up contact data', async () => {
    const f = fixture();
    f.outbound.assertProjectRoute.mockRejectedValue(new Error('route'));
    await expect(f.service.context(scope, 'foreign-project')).rejects.toThrow('route');
    expect(f.database.client.contact.findFirst).not.toHaveBeenCalled();
  });
  it('derives contact scope from the CRM lead mapping and only asks for its threads', async () => {
    const f = fixture();
    await f.service.threads({ ...scope, page: '2' }, 'project-a');
    expect(f.database.client.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'project-a', crmLeadId: 'lead-a', status: { not: 'MERGED' } },
      }),
    );
    expect(f.inbox.threads).toHaveBeenCalledWith('project-a', actor, {
      folder: 'all',
      contactId: 'contact-a',
      page: '2',
    });
  });
  it('does not expose all project mail when a lead has not synchronized yet', async () => {
    const f = fixture();
    f.database.client.contact.findFirst.mockResolvedValue(null);
    await expect(f.service.threads(scope)).rejects.toThrow('CRM_EMAIL_CONTACT_NOT_SYNCHRONIZED');
    expect(f.inbox.threads).not.toHaveBeenCalled();
  });
  it('rejects recipient substitution and replies to another conversation', async () => {
    const f = fixture();
    const input = {
      ...scope,
      requestId: 'request',
      mailboxId: 'mailbox',
      to: 'other@example.com',
      subject: 'Hello',
      text: 'Test',
    };
    await expect(f.service.send(input)).rejects.toThrow('CRM_EMAIL_RECIPIENT_MISMATCH');
    await expect(
      f.service.send({
        ...input,
        to: 'lead@example.com',
        threadId: 'thread-a',
        replyToMessageId: 'foreign-message',
      }),
    ).rejects.toThrow('CRM_EMAIL_REPLY_NOT_FOUND');
    expect(f.inbox.send).not.toHaveBeenCalled();
  });
  it('passes only the validated message fields into the existing idempotent email queue', async () => {
    const f = fixture();
    const input = {
      ...scope,
      requestId: 'request',
      mailboxId: 'mailbox',
      to: 'LEAD@example.com',
      subject: 'Hello',
      text: 'Test',
      assetIds: ['asset-a'],
    };
    await f.service.send(input);
    expect(f.inbox.send).toHaveBeenCalledWith(
      'project-a',
      {
        requestId: 'request',
        mailboxId: 'mailbox',
        to: 'lead@example.com',
        subject: 'Hello',
        text: 'Test',
        assetIds: ['asset-a'],
      },
      actor,
    );
  });
  it('enforces contact and shared-mailbox scope when a thread ID is guessed', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const inbox = new EmailInboxService(
      { client: { emailThread: { findFirst } } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(inbox.assertThread('project-a', 'foreign-thread', actor)).rejects.toThrow(
      'email_thread_not_found',
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'foreign-thread',
        projectId: 'project-a',
        contactId: 'contact-a',
        mailbox: { is: { projectId: 'project-a', shared: true } },
      },
    });
  });
});
