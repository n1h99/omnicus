import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { EmailInboxService } from './email-inbox.service';

const actor = { kind: 'crm' as const, userId: 'manager', contactId: 'contact', crmLeadId: 'lead' };
function fixture() {
  const client = {
    emailAttachment: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'file',
        status: 'AVAILABLE',
        bucketKey: 'private',
        message: { mailboxId: 'mailbox', threadId: 'thread' },
      }),
    },
    emailMessage: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'message',
        mailboxId: 'mailbox',
        threadId: 'thread',
        delivery: { attachmentAssetIds: ['asset'] },
      }),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    emailThread: { findFirst: vi.fn().mockResolvedValue(null) },
    project: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    emailSuppression: { findUnique: vi.fn().mockResolvedValue(null) },
    mediaAsset: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
    $transaction: vi.fn().mockResolvedValue({ id: 'message', threadId: 'thread' }),
  };
  const service = new EmailInboxService(
    { client } as never,
    {} as never,
    {} as never,
    new ConfigService({}) as never,
  );
  vi.spyOn(service, 'assertMailbox').mockResolvedValue({ id: 'mailbox', signature: '' } as never);
  return { client, service };
}
describe('email attachment isolation and history', () => {
  it.each(['incoming', 'outgoing'])(
    'rejects a %s file from a different contact even in a shared mailbox',
    async (direction) => {
      const { client, service } = fixture();
      const request =
        direction === 'incoming'
          ? service.attachment('project', 'file', actor)
          : service.outgoingAttachment('project', 'message', 'asset', actor);
      await expect(request).rejects.toThrow('email_thread_not_found');
      expect(client.emailThread.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: 'project',
          id: 'thread',
          contactId: 'contact',
          mailbox: { is: { projectId: 'project', shared: true } },
        },
      });
      expect(client.mediaAsset.findFirst).not.toHaveBeenCalled();
    },
  );
  it('rejects an asset not attached to the authorized message before touching storage', async () => {
    const { client, service } = fixture();
    client.emailThread.findFirst.mockResolvedValue({ id: 'thread' });
    await expect(
      service.outgoingAttachment('project', 'message', 'foreign', actor),
    ).rejects.toThrow('email_attachment_not_found');
    expect(client.mediaAsset.findFirst).not.toHaveBeenCalled();
  });
  it('only allows CRM files uploaded for this contact and authenticated manager', async () => {
    const { client, service } = fixture();
    await expect(
      service.send(
        'project',
        {
          requestId: 'request',
          mailboxId: 'mailbox',
          to: 'client@example.com',
          subject: 'Files',
          text: '',
          assetIds: ['foreign'],
        },
        actor,
      ),
    ).rejects.toThrow('email_attachment_unavailable');
    expect(client.mediaAsset.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project',
        id: { in: ['foreign'] },
        status: 'AVAILABLE',
        AND: [
          { providerMetadata: { path: ['validationChannel'], equals: 'email' } },
          { providerMetadata: { path: ['crmEmail', 'contactId'], equals: 'contact' } },
          { providerMetadata: { path: ['crmEmail', 'userId'], equals: 'manager' } },
        ],
      },
    });
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it('enforces the combined server attachment limit before queueing', async () => {
    const { client, service } = fixture();
    client.mediaAsset.findMany.mockResolvedValue([
      { id: 'asset', sizeBytes: BigInt(25 * 1024 * 1024 + 1) },
    ]);
    await expect(
      service.send(
        'project',
        {
          requestId: 'request',
          mailboxId: 'mailbox',
          to: 'client@example.com',
          subject: 'Files',
          text: '',
          assetIds: ['asset'],
        },
        actor,
      ),
    ).rejects.toThrow('email_attachments_too_large');
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it('enriches only attachments of authorized thread messages and never exposes bucket keys', async () => {
    const { client, service } = fixture();
    client.emailThread.findFirst.mockResolvedValue({ id: 'thread', replyToken: 'secret' });
    client.emailMessage.findMany.mockResolvedValue([
      {
        id: 'message',
        requestKey: 'secret',
        requestHash: 'secret',
        delivery: { attachmentAssetIds: ['asset', 'deleted'] },
      },
    ]);
    client.mediaAsset.findMany.mockResolvedValue([
      {
        id: 'asset',
        originalFilename: 'offer.pdf',
        detectedMimeType: 'application/pdf',
        sizeBytes: 123n,
        status: 'AVAILABLE',
        bucketKey: 'secret',
      },
    ]);
    const result = await service.thread('project', 'thread', actor);
    expect(client.mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'project', id: { in: ['asset', 'deleted'] } },
      }),
    );
    expect(result.messages[0]?.outgoingAttachments).toEqual([
      {
        id: 'asset',
        filename: 'offer.pdf',
        contentType: 'application/pdf',
        sizeBytes: 123,
        status: 'AVAILABLE',
      },
      {
        id: 'deleted',
        filename: 'Attachment unavailable',
        contentType: null,
        sizeBytes: 0,
        status: 'UNAVAILABLE',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
