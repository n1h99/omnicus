import { describe, expect, it, vi } from 'vitest';

import { BroadcastsService } from './broadcasts.service';

function service(client: Record<string, unknown> = {}) {
  return new BroadcastsService(
    { record: vi.fn() } as never,
    { client } as never,
    { enqueue: vi.fn() } as never,
    { enqueue: vi.fn() } as never,
  );
}

describe('BroadcastsService', () => {
  it('stores an approved connection-scoped WhatsApp template snapshot', async () => {
    const create = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      _count: { recipients: 0 },
      cancelledAt: null,
      completedAt: null,
      connection: { botUsername: null, type: 'WHATSAPP' },
      createdAt: new Date(),
      errorCode: null,
      failedAt: null,
      id: 'broadcast-wa',
      pausedAt: null,
      scheduledAt: null,
      startedAt: null,
      status: 'DRAFT',
      updatedAt: new Date(),
    }));
    const instance = service({
      broadcast: { create },
      channelConnection: {
        findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', type: 'WHATSAPP' }),
      },
      whatsAppMessageTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: '22222222-2222-4222-8222-222222222222',
          languageCode: 'en_US',
          name: 'welcome',
          status: 'APPROVED',
        }),
      },
    });

    await expect(
      instance.create(
        'project-a',
        {
          audience: { mode: 'ALL_ACTIVE' },
          connectionId: 'connection-wa',
          name: 'WhatsApp campaign',
          whatsAppTemplate: {
            templateId: '22222222-2222-4222-8222-222222222222',
          },
        },
        { actorEmail: 'operator@example.test', actorUserId: 'user-a', correlationId: 'test' },
      ),
    ).resolves.toMatchObject({
      channelType: 'WHATSAPP',
      whatsAppTemplate: { languageCode: 'en_US', name: 'welcome' },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: {
            kind: 'WHATSAPP_TEMPLATE',
            whatsAppTemplate: expect.objectContaining({
              languageCode: 'en_US',
              name: 'welcome',
            }),
          },
          templateVersionId: null,
        }),
      }),
    );
  });

  it('rejects freeform content for a WhatsApp broadcast', async () => {
    const instance = service({
      channelConnection: {
        findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', type: 'WHATSAPP' }),
      },
    });
    await expect(
      instance.create(
        'project-a',
        {
          audience: { mode: 'ALL_ACTIVE' },
          connectionId: 'connection-wa',
          name: 'Unsafe campaign',
          text: 'Freeform',
        },
        { actorEmail: 'operator@example.test', actorUserId: 'user-a', correlationId: 'test' },
      ),
    ).rejects.toMatchObject({ response: { code: 'BROADCAST_WHATSAPP_TEMPLATE_REQUIRED' } });
  });

  it('rejects a selected-contact audience without contacts before persistence', async () => {
    await expect(
      service().create(
        'project-a',
        {
          audience: { mode: 'CONTACTS' },
          connectionId: 'connection-a',
          name: 'Campaign',
          text: 'Hello',
        },
        { actorEmail: 'operator@example.test', actorUserId: 'user-a', correlationId: 'test' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'BROADCAST_CONTACTS_REQUIRED', message: 'Contacts are required' },
    });
  });

  it('rejects duplicate audience tag identifiers before persistence', async () => {
    await expect(
      service().create(
        'project-a',
        {
          audience: { includeTagIds: ['tag-a', 'tag-a'], mode: 'ALL_ACTIVE' },
          connectionId: 'connection-a',
          name: 'Campaign',
          text: 'Hello',
        },
        { actorEmail: 'operator@example.test', actorUserId: 'user-a', correlationId: 'test' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'BROADCAST_TAGS_INVALID', message: 'Audience tags must be unique' },
    });
  });

  it('applies manual contact-group membership when estimating recipients', async () => {
    const count = vi.fn().mockResolvedValue(2);
    const instance = service({
      broadcast: {
        findUnique: vi.fn().mockResolvedValue({
          audience: { mode: 'SEGMENT', segmentId: 'segment-a' },
          connectionId: 'connection-a',
          content: { kind: 'TEXT', text: 'Hello' },
          id: 'broadcast-a',
          projectId: 'project-a',
        }),
      },
      channelConnection: {
        findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', type: 'TELEGRAM' }),
      },
      channelIdentity: { count },
      segment: {
        findFirst: vi.fn().mockResolvedValue({
          filter: { contactIds: ['contact-a', 'contact-b'] },
          id: 'segment-a',
        }),
      },
    });

    await expect(instance.estimate('project-a', 'broadcast-a')).resolves.toEqual({
      eligibleRecipients: 2,
    });
    expect(count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        connectionId: 'connection-a',
        contact: {
          is: expect.objectContaining({ id: { in: ['contact-a', 'contact-b'] } }),
        },
        projectId: 'project-a',
      }),
    });
  });

  it('archives a stopped broadcast without deleting recipients', async () => {
    const row = {
      audience: {},
      cancelledAt: null,
      completedAt: null,
      connectionId: 'connection-a',
      content: { kind: 'TEXT', text: 'Hello' },
      createdAt: new Date(),
      errorCode: null,
      failedAt: null,
      id: 'broadcast-a',
      name: 'Campaign',
      pausedAt: null,
      projectId: 'project-a',
      scheduledAt: null,
      startedAt: null,
      status: 'COMPLETED',
      updatedAt: new Date(),
    };
    const update = vi.fn().mockResolvedValue({
      ...row,
      _count: { recipients: 3 },
      status: 'ARCHIVED',
    });
    const instance = service({
      broadcast: { findUnique: vi.fn().mockResolvedValue(row), update },
    });

    await expect(
      instance.archive('project-a', 'broadcast-a', {
        actorEmail: 'admin@example.test',
        actorUserId: 'user-a',
        correlationId: 'correlation-a',
      }),
    ).resolves.toMatchObject({ recipientCount: 3, status: 'ARCHIVED' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'ARCHIVED' } }));
  });

  it('requires an active broadcast to be stopped before archiving', async () => {
    const instance = service({
      broadcast: { findUnique: vi.fn().mockResolvedValue({ status: 'RUNNING' }) },
    });
    await expect(
      instance.archive('project-a', 'broadcast-a', {
        actorEmail: 'admin@example.test',
        actorUserId: 'user-a',
        correlationId: 'correlation-a',
      }),
    ).rejects.toMatchObject({ response: { code: 'BROADCAST_MUST_BE_STOPPED' } });
  });

  it('restores an archived completed broadcast without changing its delivery history', async () => {
    const update = vi.fn().mockResolvedValue({
      audience: {},
      cancelledAt: null,
      completedAt: new Date(),
      connectionId: 'connection-a',
      content: { kind: 'TEXT', text: 'Hello' },
      createdAt: new Date(),
      errorCode: null,
      failedAt: null,
      id: 'broadcast-a',
      name: 'Campaign',
      pausedAt: null,
      projectId: 'project-a',
      recipientCount: 2,
      scheduledAt: null,
      startedAt: new Date(),
      status: 'COMPLETED',
      updatedAt: new Date(),
      _count: { recipients: 2 },
    });
    const instance = service({
      broadcast: {
        findUnique: vi.fn().mockResolvedValue({
          cancelledAt: null,
          completedAt: new Date(),
          failedAt: null,
          status: 'ARCHIVED',
        }),
        update,
      },
    });

    await expect(
      instance.restore('project-a', 'broadcast-a', {
        actorEmail: 'admin@example.test',
        actorUserId: 'user-a',
        correlationId: 'correlation-a',
      }),
    ).resolves.toMatchObject({ recipientCount: 2, status: 'COMPLETED' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'COMPLETED' } }));
  });

  it('creates a new draft when a terminal broadcast is run again', async () => {
    const create = vi.fn().mockResolvedValue({
      audience: { mode: 'ALL_ACTIVE' },
      cancelledAt: null,
      completedAt: null,
      connectionId: 'connection-a',
      content: { kind: 'TEXT', text: 'Hello' },
      createdAt: new Date(),
      errorCode: null,
      failedAt: null,
      id: 'broadcast-copy',
      name: 'Launch (run 1)',
      pausedAt: null,
      projectId: 'project-a',
      scheduledAt: null,
      startedAt: null,
      status: 'DRAFT',
      templateVersionId: null,
      updatedAt: new Date(),
      _count: { recipients: 0 },
    });
    const instance = service({
      broadcast: {
        create,
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            audience: { mode: 'ALL_ACTIVE' },
            connectionId: 'connection-a',
            content: { kind: 'TEXT', text: 'Hello' },
            createdById: 'original-user',
            id: 'broadcast-a',
            name: 'Launch',
            projectId: 'project-a',
            status: 'COMPLETED',
            templateVersionId: null,
          })
          .mockResolvedValueOnce(null),
      },
    });

    await expect(
      instance.runAgain('project-a', 'broadcast-a', {
        actorEmail: 'admin@example.test',
        actorUserId: 'user-a',
        correlationId: 'correlation-a',
      }),
    ).resolves.toMatchObject({ id: 'broadcast-copy', recipientCount: 0, status: 'DRAFT' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          createdById: 'user-a',
          name: 'Launch (run 1)',
          status: 'DRAFT',
        }),
      }),
    );
  });
});
