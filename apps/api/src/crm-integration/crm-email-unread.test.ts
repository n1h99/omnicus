import { describe, expect, it, vi } from 'vitest';
import { CrmEmailService } from './crm-email.service';

const scope = {
  crmProjectId: 'crm',
  omnicusProjectId: 'project',
  crmLeadId: 'lead',
  crmUserId: 'seller',
};
function fixture() {
  const database = {
    client: {
      contact: { findFirst: vi.fn().mockResolvedValue({ id: 'contact', status: 'ACTIVE' }) },
      emailThread: { findMany: vi.fn().mockResolvedValue([]) },
      emailMessage: {
        findMany: vi.fn().mockResolvedValue([{ id: 'seen' }]),
        count: vi.fn().mockResolvedValue(2),
        groupBy: vi.fn().mockResolvedValue([{ threadId: 'thread', _count: { _all: 2 } }]),
      },
      emailMessageCrmRead: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    },
  };
  const outbound = { assertProjectRoute: vi.fn() };
  const inbox = {
    assertThread: vi.fn().mockResolvedValue({ id: 'thread' }),
    thread: vi
      .fn()
      .mockResolvedValue({ id: 'thread', messages: [{ id: 'seen' }], nextCursor: 'older' }),
    threads: vi.fn().mockResolvedValue({
      items: [
        { id: 'thread', unread: false },
        { id: 'read', unread: true },
      ],
      total: 2,
    }),
  };
  return {
    database,
    outbound,
    inbox,
    service: new CrmEmailService(database as never, outbound as never, inbox as never, {} as never),
  };
}

describe('CRM email unread state', () => {
  it('returns message counts without changing read state on GET', async () => {
    const f = fixture();
    expect(await f.service.threads(scope)).toMatchObject({
      items: [
        { id: 'thread', unreadCount: 2, unread: true },
        { id: 'read', unreadCount: 0, unread: false },
      ],
    });
    expect(await f.service.thread(scope, 'thread')).toMatchObject({
      unreadCount: 2,
      readMessageIds: ['seen'],
      nextCursor: 'older',
    });
    expect(f.database.client.emailMessage.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project',
        threadId: 'thread',
        direction: 'INBOUND',
        crmRead: { is: null },
        id: { in: ['seen'] },
      },
      select: { id: true },
    });
    expect(f.database.client.emailMessageCrmRead.createMany).not.toHaveBeenCalled();
  });

  it('acknowledges only explicit inbound IDs, idempotently; unseen arrivals and older pages stay unread', async () => {
    const f = fixture();
    const input = { ...scope, messageIds: ['seen'] };
    await f.service.markRead(input, 'thread', 'project');
    await f.service.markRead(input, 'thread', 'project');
    expect(f.inbox.assertThread).toHaveBeenCalledWith('project', 'thread', {
      kind: 'crm',
      userId: 'seller',
      crmLeadId: 'lead',
      contactId: 'contact',
    });
    expect(f.database.client.emailMessage.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project',
        threadId: 'thread',
        direction: 'INBOUND',
        id: { in: ['seen'] },
      },
      select: { id: true },
    });
    expect(f.database.client.emailMessageCrmRead.createMany).toHaveBeenLastCalledWith({
      data: [{ projectId: 'project', messageId: 'seen', readByUserId: 'seller' }],
      skipDuplicates: true,
    });
  });

  it('rejects foreign threads, unknown/outbound message IDs and mismatched projects before writing', async () => {
    const f = fixture();
    f.inbox.assertThread.mockRejectedValueOnce(new Error('email_thread_not_found'));
    await expect(f.service.markRead({ ...scope, messageIds: ['seen'] }, 'foreign')).rejects.toThrow(
      'email_thread_not_found',
    );
    expect(f.database.client.emailMessage.findMany).not.toHaveBeenCalled();
    f.database.client.emailMessage.findMany.mockResolvedValueOnce([]);
    await expect(
      f.service.markRead({ ...scope, messageIds: ['outbound'] }, 'thread'),
    ).rejects.toThrow('CRM_EMAIL_MESSAGE_NOT_FOUND');
    f.outbound.assertProjectRoute.mockRejectedValueOnce(new Error('route'));
    await expect(
      f.service.markRead({ ...scope, messageIds: ['seen'] }, 'thread', 'foreign'),
    ).rejects.toThrow('route');
    expect(f.database.client.emailMessageCrmRead.createMany).not.toHaveBeenCalled();
  });

  it('aggregates all shared threads per authorized lead and includes zero counts', async () => {
    const f = fixture();
    f.database.client.emailThread.findMany.mockResolvedValue([
      { contact: { crmLeadId: 'lead' }, _count: { messages: 2 } },
      { contact: { crmLeadId: 'lead' }, _count: { messages: 3 } },
    ]);
    const result = await f.service.unreadSummary(
      { ...scope, crmLeadIds: ['lead', 'empty'] },
      'project',
    );
    expect(result.items).toEqual([
      { leadId: 'lead', unreadCount: 5 },
      { leadId: 'empty', unreadCount: 0 },
    ]);
    expect(f.outbound.assertProjectRoute).toHaveBeenCalledWith('crm', 'project', 'project');
    expect(f.database.client.emailThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: 'project',
          mailbox: { is: { projectId: 'project', shared: true } },
          contact: {
            is: {
              projectId: 'project',
              crmLeadId: { in: ['lead', 'empty'] },
              status: { not: 'MERGED' },
            },
          },
          messages: { some: { direction: 'INBOUND', crmRead: { is: null } } },
        },
      }),
    );
  });
});
