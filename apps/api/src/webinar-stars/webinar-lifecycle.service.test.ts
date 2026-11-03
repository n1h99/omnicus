import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { ApiEnvironment } from '@omnicus/config/server';
import type { DatabaseService } from '../database/database.service';
import type { WebinarStarsService } from './webinar-stars.service';
import { WebinarLifecycleService } from './webinar-lifecycle.service';

function fixture() {
  let stored = false;
  const tx = {
    webinarWebhookReceipt: {
      createMany: vi.fn(async () => {
        if (stored) return { count: 0 };
        stored = true;
        return { count: 1 };
      }),
    },
    webinarReportImport: { upsert: vi.fn(async () => ({})) },
  };
  const client = {
    webinarConnection: {
      findUnique: vi.fn(async () => ({
        id: 'connection',
        connected: true,
        enabled: true,
        webhookSecretHash: createHash('sha256').update('test-secret').digest('hex'),
      })),
    },
    $transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)),
  };
  const service = new WebinarLifecycleService(
    { client } as unknown as DatabaseService,
    {} as WebinarStarsService,
    { get: () => 'https://api.example.test' } as unknown as ConfigService<ApiEnvironment, true>,
  );
  return { service, client, tx };
}
describe('Webinar lifecycle boundaries', () => {
  it('authenticates before storing anything and does not journal invalid payloads', async () => {
    const { service, client } = fixture();
    await expect(
      service.receive('project', 'wrong', { action: 'webinar_end', data: { id: 12 } }),
    ).rejects.toThrow();
    await expect(
      service.receive('project', 'test-secret', { action: 'unknown', data: { id: 12 } }),
    ).rejects.toThrow();
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it('deduplicates webhook receipts and stores only bounded documented metadata', async () => {
    const { service, tx } = fixture();
    const payload = {
      action: 'webinar_end',
      data: {
        id: 12,
        webinar_id: 34,
        date_end: '2026-11-03 12:00:00',
        privatePayload: 'not-stored',
      },
    };
    await service.receive('project', 'test-secret', payload);
    await service.receive('project', 'test-secret', payload);
    expect(tx.webinarReportImport.upsert).toHaveBeenCalledTimes(1);
    const recorded = JSON.stringify(tx.webinarWebhookReceipt.createMany.mock.calls);
    expect(recorded).not.toContain('not-stored');
    expect(recorded).not.toContain('test-secret');
    expect(tx.webinarReportImport.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ externalReportId: '12', origin: 'WEBHOOK' }),
      }),
    );
  });
  it('rejects unconfirmed/unsafe configuration instead of guessing provider parameters', () => {
    const { service } = fixture();
    expect(service.validateSettings({}).parameters).toEqual({});
    expect(service.validateSettings({}).clickStatuses).toEqual([]);
    expect(() => service.validateSettings({ parameters: { token: 'email' } })).toThrow();
    expect(() => service.validateSettings({ registrationSourceKey: 'another/source' })).toThrow();
    expect(() => service.validateSettings({ completedPercentage: 101 })).toThrow();
    expect(() => service.validateSettings({ arbitrary: true })).toThrow();
  });
});
