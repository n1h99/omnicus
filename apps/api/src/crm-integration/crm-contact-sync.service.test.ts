import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { CrmContactSyncService } from './crm-contact-sync.service';
import type { CrmContactUpsertDto } from './dto';

const input: CrmContactUpsertDto = {
  crmLeadId: 'lead-a',
  crmProjectId: 'crm-a',
  displayName: '  Ada Lovelace  ',
  email: '  ADA@EXAMPLE.COM ',
  omnicusProjectId: 'project-a',
  phone: ' +994 50 123 45 67 ',
  sourceUpdatedAt: '2026-09-17T09:00:00.000Z',
  status: 'ACTIVE',
  username: '@ada',
};

function fixture(existing: Record<string, unknown> | null = null) {
  const transaction = {
    $executeRaw: vi.fn(),
    channelConnection: {
      findUnique: vi.fn().mockResolvedValue({ type: 'WHATSAPP', status: 'ACTIVE' }),
    },
    channelIdentity: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ ...data, id: 'identity-a' })),
    },
    auditLog: { create: vi.fn() },
    contact: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          status: 'ACTIVE',
          phone: '+994501234567',
          whatsAppConsentStatus: 'GRANTED',
        }),
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          ...data,
          id: 'contact-a',
        }),
      ),
      findFirst: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          ...existing,
          ...data,
          id: 'contact-a',
        }),
      ),
    },
    idempotencyRecord: {
      create: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  const database = {
    client: {
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    },
  };
  const outbound = { assertProjectRoute: vi.fn() };
  return {
    outbound,
    service: new CrmContactSyncService(database as never, outbound as never),
    transaction,
  };
}

describe('CrmContactSyncService', () => {
  it('synchronizes a new CRM lead before preparing its WhatsApp identity and reuses both on retry', async () => {
    const { service, transaction } = fixture();
    const first = await service.connectWhatsApp(
      { ...input, connectionId: 'sender-a' },
      'sync-a',
      'correlation-a',
      'project-a',
    );
    expect(first).toEqual({
      contactId: 'contact-a',
      connectionId: 'sender-a',
      channelIdentityId: 'identity-a',
      externalUserId: '994501234567',
    });
    expect(transaction.channelIdentity.create.mock.invocationCallOrder[0]).toBeGreaterThan(
      transaction.contact.create.mock.invocationCallOrder[0]!,
    );
    transaction.idempotencyRecord.findUnique.mockResolvedValue({
      resultSafe: transaction.idempotencyRecord.create.mock.calls[0]?.[0]?.data.resultSafe,
    });
    transaction.channelIdentity.findUnique.mockResolvedValue({
      id: first.channelIdentityId,
      contactId: first.contactId,
      connectionId: first.connectionId,
      externalUserId: first.externalUserId,
      channel: 'WHATSAPP',
      status: 'ACTIVE',
      whatsAppReachability: 'PENDING',
    });
    await expect(
      service.connectWhatsApp(
        { ...input, connectionId: 'sender-a' },
        'sync-a',
        'correlation-b',
        'project-a',
      ),
    ).resolves.toEqual(first);
    expect(transaction.contact.create).toHaveBeenCalledTimes(1);
    expect(transaction.channelIdentity.create).toHaveBeenCalledTimes(1);
  });
  it('does not touch contacts or identities when first-contact project routing is denied', async () => {
    const { service, transaction, outbound } = fixture();
    outbound.assertProjectRoute.mockRejectedValue(new ConflictException('Wrong project'));
    await expect(
      service.connectWhatsApp(
        { ...input, connectionId: 'sender-a' },
        'sync-a',
        'correlation-a',
        'foreign-project',
      ),
    ).rejects.toThrow('Wrong project');
    expect(transaction.contact.create).not.toHaveBeenCalled();
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
  });
  it('creates a normalized project-scoped contact for a new CRM lead', async () => {
    const { outbound, service, transaction } = fixture();

    await expect(service.upsert(input, 'sync-a', 'correlation-a', 'project-a')).resolves.toEqual({
      applied: true,
      contactId: 'contact-a',
      created: true,
      sourceUpdatedAt: input.sourceUpdatedAt,
    });

    expect(outbound.assertProjectRoute).toHaveBeenCalledWith('crm-a', 'project-a', 'project-a');
    expect(transaction.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        crmLeadId: 'lead-a',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        normalizedEmail: 'ada@example.com',
        normalizedPhone: '994501234567',
        phone: '+994 50 123 45 67',
        projectId: 'project-a',
        username: 'ada',
      }),
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'crm.contact.synced', entityId: 'contact-a' }),
      }),
    );
  });

  it('ignores an older CRM snapshot instead of overwriting newer contact data', async () => {
    const newer = new Date('2026-09-17T10:00:00.000Z');
    const { service, transaction } = fixture({
      crmSourceUpdatedAt: newer,
      displayName: 'Newer name',
      id: 'contact-a',
      status: 'ACTIVE',
    });

    await expect(service.upsert(input, 'sync-a', 'correlation-a', 'project-a')).resolves.toEqual({
      applied: false,
      contactId: 'contact-a',
      created: false,
      sourceUpdatedAt: newer.toISOString(),
    });
    expect(transaction.contact.update).not.toHaveBeenCalled();
  });

  it('never removes a messaging safety status when the CRM lead lifecycle changes', async () => {
    const { service, transaction } = fixture({
      archivedAt: null,
      crmSourceUpdatedAt: new Date('2026-09-17T08:00:00.000Z'),
      displayName: 'Ada Lovelace',
      id: 'contact-a',
      status: 'UNSUBSCRIBED',
    });

    await service.upsert({ ...input, status: 'ARCHIVED' }, 'sync-a', 'correlation-a', 'project-a');

    expect(transaction.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'UNSUBSCRIBED' }),
      }),
    );
  });

  it('replays the same idempotent request and rejects reuse with different data', async () => {
    const { service, transaction } = fixture();
    const first = await service.upsert(input, 'sync-a', 'correlation-a', 'project-a');
    const persisted = transaction.idempotencyRecord.create.mock.calls[0]?.[0]?.data;
    transaction.idempotencyRecord.findUnique.mockResolvedValue({
      resultSafe: persisted.resultSafe,
    });

    await expect(service.upsert(input, 'sync-a', 'correlation-b', 'project-a')).resolves.toEqual(
      first,
    );
    await expect(
      service.upsert(
        { ...input, displayName: 'Grace Hopper' },
        'sync-a',
        'correlation-c',
        'project-a',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.contact.create).toHaveBeenCalledTimes(1);
  });
});
