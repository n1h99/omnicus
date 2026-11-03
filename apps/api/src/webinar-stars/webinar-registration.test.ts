import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { LeadCaptureService } from '../automation/lead-capture.service';

function fixture() {
  const event = {
    id: 'session',
    title: 'Test webinar',
    providerWebinarId: '123',
    scheduledAt: new Date(Date.now() + 2 * 86400000),
    endsAt: new Date(Date.now() + 3 * 86400000),
    timezone: 'Asia/Baku',
    settings: { registrationSourceKey: 'website' },
    connection: { enabled: true },
  };
  const tx = {
    webinarEvent: { findFirst: vi.fn(async () => event) },
    webinarInvitation: {
      findUnique: vi.fn(async () => null as null | { id: string; token: string }),
      upsert: vi.fn(async () => ({ id: 'invitation', token: 'opaque-token' })),
    },
    webinarAction: {
      createMany: vi.fn(
        async (input: { data: Array<Record<string, unknown>>; skipDuplicates: boolean }) => ({
          count: input.data.length,
        }),
      ),
    },
  };
  const service = new LeadCaptureService(
    {} as never,
    { get: () => 'https://api.example.test' } as never,
  ) as unknown as {
    webinarRegistration(
      tx: unknown,
      project: string,
      contact: string,
      source: string,
      metadata: Record<string, unknown>,
    ): Promise<unknown>;
  };
  const register = (source = 'website') =>
    service.webinarRegistration(tx, 'project', 'contact', source, {
      webinarEventId: 'session',
      utm_campaign: 'launch',
      distributorId: 'partner',
      other: 'ignored',
    });
  return { event, tx, register };
}
describe('Website webinar registration', () => {
  it('creates an opaque participant link and durable reminders with explicit attribution', async () => {
    const { register, tx } = fixture();
    expect(await register()).toEqual({
      invitationId: 'invitation',
      participantUrl: 'https://api.example.test/public/webinar-invitations/opaque-token',
    });
    expect(tx.webinarInvitation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          attribution: { utm_campaign: 'launch', distributorId: 'partner' },
        }),
      }),
    );
    const actions = tx.webinarAction.createMany.mock.calls[0]![0];
    expect(actions.data).toHaveLength(5);
    expect(actions.skipDuplicates).toBe(true);
    expect(actions.data.filter((row) => row.eventType === 'WEBINAR_REMINDER')).toHaveLength(3);
  });
  it('reuses an existing link even after the session ends without creating new actions', async () => {
    const { event, tx, register } = fixture();
    event.endsAt = new Date(0);
    tx.webinarInvitation.findUnique.mockResolvedValue({ id: 'existing', token: 'same-token' });
    expect(await register()).toEqual({
      invitationId: 'existing',
      participantUrl: 'https://api.example.test/public/webinar-invitations/same-token',
    });
    expect(tx.webinarInvitation.upsert).not.toHaveBeenCalled();
    expect(tx.webinarAction.createMany).not.toHaveBeenCalled();
  });
  it('rejects registration using a different source before creating an invitation', async () => {
    const { register, tx } = fixture();
    await expect(register('another-source')).rejects.toThrow('webinar_registration_source_invalid');
    expect(tx.webinarInvitation.upsert).not.toHaveBeenCalled();
  });
  it('stores registrations while paused without scheduling communication', async () => {
    const { event, register, tx } = fixture();
    event.connection.enabled = false;
    await register();
    expect(tx.webinarInvitation.upsert).toHaveBeenCalledTimes(1);
    expect(tx.webinarAction.createMany).not.toHaveBeenCalled();
  });
});
