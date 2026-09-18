import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@omnicus/database';

// Shared by Communications and CRM first contact. Preparing an identity does not send a message.
export async function ensureWhatsAppContactIdentity(
  transaction: Prisma.TransactionClient,
  projectId: string,
  contactId: string,
  connectionId: string,
  source: 'omnicus_communications' | 'crm',
) {
  const [contact, connection] = await Promise.all([
    transaction.contact.findUnique({ where: { projectId_id: { id: contactId, projectId } } }),
    transaction.channelConnection.findUnique({
      where: { projectId_id: { id: connectionId, projectId } },
    }),
  ]);
  if (!contact || contact.status !== 'ACTIVE')
    throw new ConflictException({ code: 'COMMUNICATION_CONTACT_UNAVAILABLE' });
  if (!connection || connection.type !== 'WHATSAPP' || connection.status !== 'ACTIVE')
    throw new NotFoundException({ code: 'CHANNEL_CONNECTION_NOT_FOUND' });
  if (contact.whatsAppConsentStatus !== 'GRANTED')
    throw new ConflictException({ code: 'COMMUNICATION_WHATSAPP_CONSENT_REQUIRED' });
  const phone = contact.normalizedPhone ?? contact.phone?.replace(/\D/g, '') ?? '';
  if (!/^\d{5,15}$/.test(phone))
    throw new ConflictException({ code: 'COMMUNICATION_WHATSAPP_PHONE_REQUIRED' });

  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}), hashtext(${`whatsapp-identity:${connectionId}:${phone}`}))`;
  const existing = await transaction.channelIdentity.findUnique({
    where: {
      projectId_connectionId_externalUserId: { connectionId, externalUserId: phone, projectId },
    },
  });
  if (existing && existing.contactId !== contactId)
    throw new ConflictException({ code: 'COMMUNICATION_WHATSAPP_IDENTITY_CONFLICT' });
  if (existing?.whatsAppReachability === 'BLOCKED')
    throw new ConflictException({ code: 'COMMUNICATION_WHATSAPP_RECIPIENT_BLOCKED' });
  if (existing && (existing.status !== 'ACTIVE' || existing.channel !== 'WHATSAPP'))
    throw new ConflictException({ code: 'COMMUNICATION_IDENTITY_UNAVAILABLE' });
  return (
    existing ??
    transaction.channelIdentity.create({
      data: {
        channel: 'WHATSAPP',
        connectionId,
        contactId,
        externalUserId: phone,
        metadata: { source },
        projectId,
        status: 'ACTIVE',
        whatsAppReachability: 'PENDING',
        whatsAppReachabilityCheckedAt: new Date(),
      },
    })
  );
}
