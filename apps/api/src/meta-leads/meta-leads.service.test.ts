import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { ApiEnvironment } from '@omnicus/config/server';
import type { MetaLeadConfig } from '@omnicus/database';
import { ChannelSecretsService } from '@omnicus/channel-secrets';
import type { DatabaseService } from '../database/database.service';
import { MetaCrmBusyError, MetaLeadsService } from './meta-leads.service';
import { MetaLeadsRuntimeService } from './meta-leads-runtime.service';

const key = Buffer.alloc(32, 7).toString('base64');
const secret = 'unit-test-secret-not-real';
const verify = 'unit-test-verify-token-at-least-32-chars';
function fixture() {
  const secrets = new ChannelSecretsService(key);
  const encrypted = Object.fromEntries(
    Object.entries({
      pageToken: 'unit-test-page-token',
      appSecret: secret,
      verifyToken: verify,
    }).map(([field, plaintext]) => [
      field,
      secrets.encryptSecret({
        channelConnectionId: 'config',
        channelType: 'meta-leads',
        projectId: 'project',
        field,
        plaintext,
      }),
    ]),
  );
  const config = {
    id: 'config',
    projectId: 'project',
    pageId: '333',
    formIds: ['222'],
    graphVersion: 'v26.0',
    credentialsEncrypted: encrypted,
    enabled: true,
    deliveryEnabled: false,
    liveFrom: new Date('2026-10-01T00:00:00Z'),
    verifiedAt: new Date(),
  } as unknown as MetaLeadConfig;
  const db = {
    metaLeadConfig: {
      findUnique: vi.fn().mockResolvedValue(config),
      update: vi.fn().mockResolvedValue(config),
    },
    metaLeadSubmission: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn(),
    },
  };
  const service = new MetaLeadsService(
    { client: db } as unknown as DatabaseService,
    new ConfigService({ CHANNEL_SECRETS_KEY: key }) as ConfigService<ApiEnvironment, true>,
  );
  return { config, db, service };
}
const body = {
  object: 'page',
  entry: [
    {
      id: '333',
      changes: [{ field: 'leadgen', value: { page_id: '333', form_id: '222', leadgen_id: '111' } }],
    },
  ],
};
const signed = (value: unknown) => {
  const raw = Buffer.from(JSON.stringify(value));
  return { raw, signature: `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` };
};

describe('Meta webhook security and safe settings', () => {
  it('validates challenge and never returns encrypted/plaintext credentials', async () => {
    const { service } = fixture();
    expect(await service.verify('project', 'subscribe', verify, '123')).toBe('123');
    await expect(service.verify('project', 'subscribe', 'wrong', '123')).rejects.toMatchObject({
      status: 403,
    });
    const safe = JSON.stringify(await service.safeConfig('project'));
    expect(safe).not.toContain('credentialsEncrypted');
    expect(safe).not.toContain('ciphertext');
    expect(safe).not.toContain(secret);
  });
  it('persists valid receipts with duplicate suppression before acknowledgement', async () => {
    const { service, db } = fixture();
    const { raw, signature } = signed(body);
    expect(await service.receive('project', raw, signature, body)).toEqual({ ok: true });
    expect(db.metaLeadSubmission.createMany).toHaveBeenCalledWith({
      data: [
        { projectId: 'project', configId: 'config', pageId: '333', formId: '222', leadId: '111' },
      ],
      skipDuplicates: true,
    });
  });
  it('rejects absent/forged signature and disabled route, storing no invalid raw data', async () => {
    const { service, db, config } = fixture();
    const { raw, signature } = signed(body);
    await expect(service.receive('project', raw, undefined, body)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.receive('project', Buffer.from('{}'), signature, body),
    ).rejects.toMatchObject({ status: 403 });
    config.enabled = false;
    await expect(service.receive('project', raw, signature, body)).rejects.toMatchObject({
      status: 503,
    });
    expect(db.metaLeadSubmission.createMany).not.toHaveBeenCalled();
  });
  it('does not acknowledge a failed persistence write', async () => {
    const { service, db } = fixture();
    db.metaLeadSubmission.createMany.mockRejectedValue(new Error('db unavailable'));
    const { raw, signature } = signed(body);
    await expect(service.receive('project', raw, signature, body)).rejects.toThrow(
      'db unavailable',
    );
  });
  it('does not accept a form belonging to another configured route', async () => {
    const { service, db } = fixture();
    const other = {
      object: 'page',
      entry: [
        {
          id: '333',
          changes: [
            { field: 'leadgen', value: { page_id: '333', form_id: '999', leadgen_id: '111' } },
          ],
        },
      ],
    };
    const { raw, signature } = signed(other);
    await service.receive('project', raw, signature, other);
    expect(db.metaLeadSubmission.createMany).toHaveBeenCalledWith({
      data: [],
      skipDuplicates: true,
    });
  });
  it('requires explicit approval for historical results and blocks ambiguous/unknown approval', async () => {
    const { service, db } = fixture();
    db.metaLeadSubmission.findFirst.mockResolvedValue({ id: 'row', historical: true });
    await expect(service.approve('project', 'row', false)).rejects.toMatchObject({ status: 400 });
    db.metaLeadSubmission.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.approve('project', 'row', true)).rejects.toMatchObject({ status: 409 });
  });
});

describe('durable Meta delivery state machine', () => {
  const payload = {
    leadId: '111',
    formId: '222',
    pageId: '333',
    createdAt: '2026-10-01T01:00:00.000Z',
    email: 'test@example.org',
  };
  function runtimeFixture(overrides: object = {}) {
    const f = fixture();
    const crm = vi.spyOn(f.service, 'crm').mockResolvedValue({ outcome: 'NEW' });
    const runtime = new MetaLeadsRuntimeService(f.service);
    const row = {
      id: 'row',
      projectId: 'project',
      configId: 'config',
      pageId: '333',
      formId: '222',
      leadId: '111',
      payload,
      state: 'READY',
      historical: false,
      approved: false,
      notify: false,
      result: null,
      attempts: 1,
      lastError: null,
      lockedBy: 'owner',
      lockedUntil: new Date(Date.now() + 60_000),
      nextAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    return { ...f, crm, runtime, row };
  }
  it('preview never applies or notifies even when a new lead was found', async () => {
    const { runtime, crm, row, db } = runtimeFixture();
    await runtime.process(row);
    expect(crm.mock.calls.map((call) => call[1])).toEqual(['preview']);
    expect(db.metaLeadSubmission.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'PREVIEW_NEW' }) }),
    );
  });
  it('old webhook receipts remain preview-only even with live delivery enabled', async () => {
    const { runtime, crm, row, config, db } = runtimeFixture({
      payload: { ...payload, createdAt: '2026-09-20T01:00:00Z' },
    });
    config.deliveryEnabled = true;
    await runtime.process(row);
    expect(crm.mock.calls.map((call) => call[1])).toEqual(['preview']);
    expect(db.metaLeadSubmission.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ historical: true }) }),
    );
  });
  it('live new card is requested with notification, historical approval without one', async () => {
    for (const historical of [false, true]) {
      const { runtime, crm, row, config } = runtimeFixture({ historical, approved: historical });
      config.deliveryEnabled = true;
      crm
        .mockResolvedValueOnce({ outcome: 'NEW' })
        .mockResolvedValueOnce({ outcome: 'CREATED', crmLeadId: 'card' });
      await runtime.process(row);
      expect(crm).toHaveBeenLastCalledWith(
        'project',
        'apply',
        expect.objectContaining({ notify: !historical }),
      );
    }
  });
  it('matched manual card is applied with notification suppressed', async () => {
    const { runtime, crm, row, config } = runtimeFixture();
    config.deliveryEnabled = true;
    crm
      .mockResolvedValueOnce({ outcome: 'MATCH', crmLeadId: 'old' })
      .mockResolvedValueOnce({ outcome: 'LINKED', crmLeadId: 'old' });
    await runtime.process(row);
    expect(crm).toHaveBeenLastCalledWith(
      'project',
      'apply',
      expect.objectContaining({ notify: false }),
    );
  });
  it('ambiguous match never applies', async () => {
    const { runtime, crm, row, config, db } = runtimeFixture();
    config.deliveryEnabled = true;
    crm.mockResolvedValue({ outcome: 'REVIEW' });
    await runtime.process(row);
    expect(crm).toHaveBeenCalledTimes(1);
    expect(db.metaLeadSubmission.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'REVIEW' }) }),
    );
  });
  it('uncertain delivery is reconciled, never blindly reapplied', async () => {
    const { runtime, crm, row, db } = runtimeFixture({ state: 'DELIVERING' });
    crm.mockResolvedValue({ outcome: 'NOT_FOUND' });
    await runtime.process(row);
    expect(crm.mock.calls.map((call) => call[1])).toEqual(['reconcile']);
    expect(db.metaLeadSubmission.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'UNKNOWN' }) }),
    );
  });
  it('lost apply response becomes UNKNOWN and recovery completes from source ID', async () => {
    const { runtime, crm, row, config, db } = runtimeFixture();
    config.deliveryEnabled = true;
    crm.mockResolvedValueOnce({ outcome: 'NEW' }).mockRejectedValueOnce(new Error('timeout'));
    await runtime.process(row);
    expect(db.metaLeadSubmission.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'UNKNOWN' }) }),
    );
    crm.mockResolvedValue({ outcome: 'LINKED', crmLeadId: 'saved' });
    await runtime.process({ ...row, state: 'UNKNOWN' });
    expect(crm).toHaveBeenLastCalledWith('project', 'reconcile', payload);
    expect(db.metaLeadSubmission.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'DONE' }) }),
    );
  });
  it('a confirmed pre-write CRM busy response backs off without creating an UNKNOWN delivery', async () => {
    const { runtime, crm, row, config, db } = runtimeFixture();
    config.deliveryEnabled = true;
    crm.mockResolvedValueOnce({ outcome: 'NEW' }).mockRejectedValueOnce(new MetaCrmBusyError());
    await runtime.process(row);
    expect(db.metaLeadSubmission.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'READY', lastError: 'META_LEADS_CRM_BUSY' }),
      }),
    );
  });
});

describe('Meta recovery poller', () => {
  function pollFixture() {
    const f = fixture();
    const poll = {
      id: 'poll',
      projectId: 'project',
      configId: 'config',
      formId: '222',
      historical: false,
      from: new Date('2026-10-01T00:00:00Z'),
      until: null,
      cursor: null,
    };
    const db = {
      ...f.db,
      metaLeadPoll: {
        findFirst: vi.fn().mockResolvedValue(poll),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((work: (tx: typeof db) => Promise<unknown>) => work(db));
    const service = new MetaLeadsService(
      { client: db } as unknown as DatabaseService,
      new ConfigService({ CHANNEL_SECRETS_KEY: key }) as ConfigService<ApiEnvironment, true>,
    );
    const page = vi.fn().mockResolvedValue({
      items: [
        { id: '111', form_id: '222', created_time: '2026-10-01T01:00:00Z', field_data: [] },
        { id: '112', form_id: '222', created_time: '2026-09-01T01:00:00Z', field_data: [] },
      ],
      after: 'next-safe-cursor',
    });
    vi.spyOn(service, 'graph').mockReturnValue({ page } as unknown as ReturnType<
      MetaLeadsService['graph']
    >);
    return { db, page, runtime: new MetaLeadsRuntimeService(service) };
  }
  it('stores one in-range receipt and advances cursor in the same transaction', async () => {
    const { db, page, runtime } = pollFixture();
    await runtime.poll();
    expect(page).toHaveBeenCalledWith('222', null);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.metaLeadSubmission.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [expect.objectContaining({ leadId: '111', historical: false, state: 'READY' })],
    });
    expect(db.metaLeadPoll.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cursor: 'next-safe-cursor' }) }),
    );
  });
  it('does not advance cursor when Graph fails and keeps the scan retryable', async () => {
    const { db, page, runtime } = pollFixture();
    page.mockRejectedValue(new Error('network'));
    await runtime.poll();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.metaLeadSubmission.createMany).not.toHaveBeenCalled();
    const data = db.metaLeadPoll.updateMany.mock.calls.at(-1)?.[0].data;
    expect(data).toMatchObject({ lastError: 'META_LEADS_POLL_FAILED' });
    expect(data).not.toHaveProperty('cursor');
  });
  it('a replica which lost ownership cannot store the page or advance it', async () => {
    const { db, runtime } = pollFixture();
    db.metaLeadPoll.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await runtime.poll();
    expect(db.metaLeadSubmission.createMany).not.toHaveBeenCalled();
  });
});
