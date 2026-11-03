import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { ChannelSecretsService } from '@omnicus/channel-secrets';
import type { ApiEnvironment } from '@omnicus/config/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DatabaseService } from '../database/database.service';
import { WebinarStarsService } from './webinar-stars.service';
import { WebinarListDto } from './webinar-stars.dto';

const key = Buffer.alloc(32, 5).toString('base64');
function fixture() {
  const tokenEncrypted = new ChannelSecretsService(key).encryptSecret({
    channelConnectionId: 'a',
    projectId: 'a',
    channelType: 'webinar-stars',
    field: 'apiToken',
    plaintext: 'synthetic-provider-token',
  });
  const row = { id: 'connection', projectId: 'a', revision: 3, tokenEncrypted };
  const db = {
    webinarConnection: {
      findUnique: vi.fn().mockResolvedValue(row as typeof row | null),
      upsert: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const service = new WebinarStarsService(
    { client: db } as unknown as DatabaseService,
    new ConfigService({ CHANNEL_SECRETS_KEY: key }) as ConfigService<ApiEnvironment, true>,
  );
  return { db, row, service };
}
afterEach(() => vi.unstubAllGlobals());
describe('project-owned webinar credentials', () => {
  it('encrypts replacement tokens, invalidates verification and returns only a safe projection', async () => {
    const { db, service } = fixture();
    await service.save('a', { token: 'new-synthetic-secret' });
    const write = db.webinarConnection.upsert.mock.calls[0]![0];
    expect(JSON.stringify(write)).not.toContain('new-synthetic-secret');
    expect(write.update).toMatchObject({ verifiedAt: null, revision: { increment: 1 } });
    expect(
      new ChannelSecretsService(key).decryptSecret({
        projectId: 'a',
        channelConnectionId: 'a',
        channelType: 'webinar-stars',
        field: 'apiToken',
        envelope: write.create.tokenEncrypted,
      }),
    ).toBe('new-synthetic-secret');
    expect(db.webinarConnection.findUnique).toHaveBeenLastCalledWith({
      where: { projectId: 'a' },
      select: expect.objectContaining({
        id: true,
        verifiedAt: true,
        updatedAt: true,
        revision: true,
      }),
    });
  });
  it('rejects credentials copied across projects before contacting the provider', async () => {
    const { service } = fixture();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(service.webinars('b', { limit: 25, offset: 0 })).rejects.toMatchObject({
      status: 503,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cannot verify a replaced or disconnected credential after an in-flight test', async () => {
    const { service, db } = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 0, webinars: [], total: 0 }))),
    );
    db.webinarConnection.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.test('a')).rejects.toMatchObject({ status: 409 });
    expect(db.webinarConnection.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'a', id: 'connection', revision: 3 },
      data: { verifiedAt: expect.any(Date) },
    });
  });
  it('removes only the selected project connection and rejects missing connections', async () => {
    const { service, db } = fixture();
    await service.disconnect('b');
    expect(db.webinarConnection.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'b' },
      data: expect.objectContaining({ connected: false, enabled: false, webhookSecretHash: null }),
    });
    db.webinarConnection.findUnique.mockResolvedValue(null);
    await expect(service.webinars('b', { limit: 25, offset: 0 })).rejects.toMatchObject({
      status: 404,
    });
  });
  it('rejects impossible dates and reversed ranges before contacting the provider', async () => {
    const { service, db } = fixture();
    for (const input of [{ from: '2026-02-30' }, { from: '2026-11-03', to: '2026-11-02' }])
      await expect(service.reports('a', { limit: 25, offset: 0, ...input })).rejects.toMatchObject({
        status: 400,
      });
    expect(db.webinarConnection.findUnique).not.toHaveBeenCalled();
  });
  it('validates bounded query parameters after transforming query strings', async () => {
    expect(await validate(plainToInstance(WebinarListDto, { limit: '25', offset: '0' }))).toEqual(
      [],
    );
    for (const input of [
      { limit: '101' },
      { offset: '-1' },
      { limit: 'NaN' },
      { status: 'arbitrary' },
    ])
      expect((await validate(plainToInstance(WebinarListDto, input))).length).toBeGreaterThan(0);
  });
});
