import { describe, expect, it, vi } from 'vitest';

import {
  isWhatsAppAutomationEligibleMessageType,
  WhatsAppInboundProcessorService,
} from './whatsapp-inbound-processor.service';

function normalizer() {
  return new WhatsAppInboundProcessorService({} as never, {} as never) as unknown as {
    normalizeMessage(
      message: Record<string, unknown>,
      type: string,
      occurredAt: Date,
    ): {
      content: Record<string, unknown>;
      normalizedPayload: Record<string, unknown>;
    };
  };
}

describe('WhatsApp inbound business normalization', () => {
  it('rejects invalid coordinates and never preserves an arbitrary location URL', () => {
    const service = normalizer();
    expect(() =>
      service.normalizeMessage(
        { location: { latitude: 91, longitude: 10 }, type: 'location' },
        'location',
        new Date(),
      ),
    ).toThrow();
    expect(
      service.normalizeMessage(
        {
          location: {
            address: 'Safe address',
            latitude: 40.4,
            longitude: 49.8,
            name: 'Office',
            url: 'https://attacker.example/tracker',
          },
          type: 'location',
        },
        'location',
        new Date(),
      ).content,
    ).toEqual({
      address: 'Safe address',
      latitude: 40.4,
      longitude: 49.8,
      name: 'Office',
      occurredAt: expect.any(String),
    });
  });

  it('keeps all bounded safe contact fields for up to twenty shared contacts', () => {
    const service = normalizer();
    const result = service.normalizeMessage(
      {
        contacts: Array.from({ length: 21 }, (_, index) => ({
          emails: [{ email: `person-${index}@example.test`, type: 'WORK' }],
          name: {
            first_name: `First ${index}`,
            formatted_name: `First ${index} Last`,
            last_name: 'Last',
          },
          phones: [{ phone: `+9945000${index}`, type: 'CELL', wa_id: `9945000${index}` }],
        })),
      },
      'contacts',
      new Date(),
    );
    const contacts = result.content.contacts as Array<Record<string, unknown>>;
    expect(contacts).toHaveLength(20);
    expect(contacts[0]).toMatchObject({
      emails: [{ email: 'person-0@example.test', type: 'WORK' }],
      name: { firstName: 'First 0', formattedName: 'First 0 Last', lastName: 'Last' },
      phones: [{ phone: '+99450000', type: 'CELL', waId: '99450000' }],
    });
  });

  it('rejects oversized provider strings before they enter normalized rows', () => {
    expect(() =>
      normalizer().normalizeMessage({ text: { body: 'x'.repeat(4_097) } }, 'text', new Date()),
    ).toThrow('whatsapp_field_too_long');
  });

  it('accepts exactly one reaction emoji grapheme or an empty removal', () => {
    const service = normalizer();
    expect(() =>
      service.normalizeMessage(
        { reaction: { emoji: '👨‍👩‍👧‍👦', message_id: 'wamid.target' } },
        'reaction',
        new Date(),
      ),
    ).not.toThrow();
    expect(() =>
      service.normalizeMessage(
        { reaction: { emoji: '', message_id: 'wamid.target' } },
        'reaction',
        new Date(),
      ),
    ).not.toThrow();
    expect(() =>
      service.normalizeMessage(
        { reaction: { emoji: '👍🔥', message_id: 'wamid.target' } },
        'reaction',
        new Date(),
      ),
    ).toThrow();
    expect(() =>
      service.normalizeMessage(
        { reaction: { emoji: 'ok', message_id: 'wamid.target' } },
        'reaction',
        new Date(),
      ),
    ).toThrow();
  });

  it('keeps unsupported provider placeholders out of automation runtime', () => {
    expect(isWhatsAppAutomationEligibleMessageType('TEXT')).toBe(true);
    expect(isWhatsAppAutomationEligibleMessageType('CONTACT')).toBe(true);
    expect(isWhatsAppAutomationEligibleMessageType('UNSUPPORTED')).toBe(false);
  });

  it('updates the channel profile without overwriting an existing CRM contact name', async () => {
    const contactUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const identityUpdate = vi.fn().mockResolvedValue({});
    const service = new WhatsAppInboundProcessorService({} as never, {} as never) as unknown as {
      resolveContact(
        transaction: unknown,
        claimed: unknown,
        senderId: string,
        profileName: string,
        eventAt: Date,
      ): Promise<unknown>;
    };
    await service.resolveContact(
      {
        channelIdentity: {
          findUnique: vi.fn().mockResolvedValue({
            contact: { crmLeadId: 'lead-a', id: 'contact-a' },
            contactId: 'contact-a',
          }),
          update: identityUpdate,
        },
        contact: { updateMany: contactUpdate },
      },
      { connectionId: 'connection-a', projectId: 'project-a' },
      '15550001',
      'New WhatsApp profile',
      new Date(),
    );
    expect(identityUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ displayName: 'New WhatsApp profile' }),
      }),
    );
    expect(contactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ displayName: expect.anything() }),
      }),
    );
  });

  it('completes an unmatched provider status after its retry budget is exhausted', async () => {
    const receivedAt = new Date();
    const inboxRecordUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      channelConnection: {
        findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', type: 'WHATSAPP' }),
      },
      message: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const database = {
      client: {
        $transaction: vi.fn(async (callback: (value: unknown) => Promise<unknown>) =>
          callback(transaction),
        ),
        inboxRecord: {
          findUnique: vi.fn().mockResolvedValue({
            attempts: 7,
            connectionId: 'connection-a',
            id: 'inbox-a',
            maxAttempts: 8,
            projectId: 'project-a',
            rawWebhookEvent: {
              externalUpdateId: 'status-a',
              payload: {
                entry: [
                  {
                    changes: [
                      {
                        value: {
                          statuses: [
                            {
                              id: 'wamid.foreign',
                              status: 'delivered',
                              timestamp: String(Math.floor(receivedAt.getTime() / 1_000)),
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
              receivedAt,
            },
            status: 'RETRY',
          }),
          updateMany: inboxRecordUpdateMany,
        },
      },
    };
    const service = new WhatsAppInboundProcessorService(
      { get: vi.fn().mockReturnValue(30_000) } as never,
      database as never,
    );

    await expect(service.process({ inboxRecordId: 'inbox-a' })).resolves.toBeUndefined();
    expect(inboxRecordUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastError: null, status: 'COMPLETED' }),
      }),
    );
  });
});
