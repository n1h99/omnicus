import { describe, expect, it, vi } from 'vitest';
import { ensureWhatsAppContactIdentity } from './whatsapp-contact-identity';

function fixture() {
  const identity = {
    id: 'identity-a',
    contactId: 'contact-a',
    connectionId: 'sender-a',
    channel: 'WHATSAPP',
    status: 'ACTIVE',
    whatsAppReachability: 'PENDING',
    externalUserId: '351930592376',
  };
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    contact: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          status: 'ACTIVE',
          phone: '+351 930 592 376',
          whatsAppConsentStatus: 'GRANTED',
        }),
    },
    channelConnection: {
      findUnique: vi.fn().mockResolvedValue({ type: 'WHATSAPP', status: 'ACTIVE' }),
    },
    channelIdentity: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(identity),
    },
  };
  const prepare = () =>
    ensureWhatsAppContactIdentity(
      transaction as never,
      'project-a',
      'contact-a',
      'sender-a',
      'crm',
    );
  return { transaction, identity, prepare };
}

describe('WhatsApp first-contact identity', () => {
  it('prepares a normalized identity and reuses it on retry', async () => {
    const { transaction, identity, prepare } = fixture();
    await expect(prepare()).resolves.toEqual(identity);
    expect(transaction.channelIdentity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        externalUserId: '351930592376',
        contactId: 'contact-a',
        projectId: 'project-a',
        connectionId: 'sender-a',
        whatsAppReachability: 'PENDING',
        metadata: { source: 'crm' },
      }),
    });
    transaction.channelIdentity.findUnique.mockResolvedValue(identity);
    await expect(prepare()).resolves.toEqual(identity);
    expect(transaction.channelIdentity.create).toHaveBeenCalledTimes(1);
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'consent',
      { status: 'ACTIVE', phone: '+351930592376', whatsAppConsentStatus: 'REVOKED' },
      'COMMUNICATION_WHATSAPP_CONSENT_REQUIRED',
    ],
    [
      'missing phone',
      { status: 'ACTIVE', phone: null, whatsAppConsentStatus: 'GRANTED' },
      'COMMUNICATION_WHATSAPP_PHONE_REQUIRED',
    ],
    [
      'inactive contact',
      { status: 'ARCHIVED', phone: '+351930592376', whatsAppConsentStatus: 'GRANTED' },
      'COMMUNICATION_CONTACT_UNAVAILABLE',
    ],
  ])('rejects %s without creating an identity', async (_label, contact, code) => {
    const { transaction, prepare } = fixture();
    transaction.contact.findUnique.mockResolvedValue(contact);
    await expect(prepare()).rejects.toMatchObject({ response: { code } });
    expect(transaction.channelIdentity.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'different contact',
      { contactId: 'other-contact' },
      'COMMUNICATION_WHATSAPP_IDENTITY_CONFLICT',
    ],
    [
      'blocked number',
      { whatsAppReachability: 'BLOCKED' },
      'COMMUNICATION_WHATSAPP_RECIPIENT_BLOCKED',
    ],
    ['inactive identity', { status: 'INACTIVE' }, 'COMMUNICATION_IDENTITY_UNAVAILABLE'],
  ])('preserves an existing identity belonging to %s', async (_label, overrides, code) => {
    const { transaction, identity, prepare } = fixture();
    transaction.channelIdentity.findUnique.mockResolvedValue({ ...identity, ...overrides });
    await expect(prepare()).rejects.toMatchObject({ response: { code } });
    expect(transaction.channelIdentity.create).not.toHaveBeenCalled();
  });

  it('rejects an inactive or foreign project sender', async () => {
    const { transaction, prepare } = fixture();
    transaction.channelConnection.findUnique.mockResolvedValue(null);
    await expect(prepare()).rejects.toMatchObject({
      response: { code: 'CHANNEL_CONNECTION_NOT_FOUND' },
    });
    expect(transaction.channelConnection.findUnique).toHaveBeenCalledWith({
      where: { projectId_id: { id: 'sender-a', projectId: 'project-a' } },
    });
    expect(transaction.channelIdentity.create).not.toHaveBeenCalled();
  });
});
