import { randomBytes } from 'node:crypto';
import type { Prisma } from './generated/prisma/client';

export class MailboxDeliveryError extends Error {}

/** Called in the same transaction as delivery creation; no provider side effects. */
export async function attachMailboxDelivery(
  transaction: Prisma.TransactionClient,
  deliveryId: string,
  options: {
    projectId: string;
    mailboxId?: string | null;
    threadId?: string | null;
    replyToMessageId?: string | null;
    requestKey?: string;
    requestHash?: string;
    textBody?: string;
  },
) {
  const existing = await transaction.emailMessage.findFirst({
    where: { projectId: options.projectId, deliveryId },
  });
  if (existing) return existing;
  const delivery = await transaction.emailDelivery.findUnique({
    where: { projectId_id: { projectId: options.projectId, id: deliveryId } },
  });
  if (!delivery) throw new MailboxDeliveryError('email_delivery_not_found');
  if (delivery.firstAttemptAt && !delivery.mailboxId) return null;
  const mailboxId = options.mailboxId ?? delivery.mailboxId;
  const mailbox = await transaction.emailMailbox.findFirst({
    include: { domain: true },
    where: {
      projectId: options.projectId,
      ...(mailboxId ? { id: mailboxId } : { isDefault: true }),
    },
  });
  if (!mailbox) {
    if (mailboxId || options.threadId || delivery.source === 'MANUAL')
      throw new MailboxDeliveryError('email_mailbox_unavailable');
    return null; // Explicit compatibility for legacy EMAIL_FROM sends.
  }
  if (
    mailbox.status !== 'ACTIVE' ||
    mailbox.domain.status !== 'verified' ||
    !mailbox.domain.sendingEnabled
  )
    throw new MailboxDeliveryError('email_sender_not_ready');
  if (!/^[^\r\n<>]+@[^\r\n<>]+$/.test(mailbox.address) || /[\r\n<>]/.test(mailbox.displayName))
    throw new MailboxDeliveryError('email_sender_invalid');
  const thread = options.threadId
    ? await transaction.emailThread.findFirst({
        where: {
          id: options.threadId,
          projectId: options.projectId,
          mailboxId: mailbox.id,
          peerEmail: delivery.normalizedEmail,
        },
      })
    : await transaction.emailThread.create({
        data: {
          projectId: delivery.projectId,
          mailboxId: mailbox.id,
          contactId: delivery.contactId,
          peerEmail: delivery.normalizedEmail,
          subject: delivery.subject,
          replyToken: randomBytes(18).toString('hex'),
        },
      });
  if (!thread) throw new MailboxDeliveryError('email_thread_recipient_mismatch');
  const previous = await transaction.emailMessage.findFirst({
    where: {
      projectId: options.projectId,
      threadId: thread.id,
      ...(options.replyToMessageId
        ? { id: options.replyToMessageId }
        : { rfcMessageId: { not: null } }),
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
  });
  if (options.replyToMessageId && !previous)
    throw new MailboxDeliveryError('email_reply_message_unavailable');
  const parentId = previous?.rfcMessageId;
  const references = [
    ...new Set([
      // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted email headers.
      ...(previous?.referencesHeader?.match(/<[^<>\s\x00-\x1f]{1,900}>/g) ?? []),
      // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted email headers.
      ...(parentId && /^<[^<>\s\x00-\x1f]{1,900}>$/.test(parentId) ? [parentId] : []),
    ]),
  ];
  while (references.join(' ').length > 950) references.shift();
  const headers =
    // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted email headers.
    parentId && /^<[^<>\s\x00-\x1f]{1,900}>$/.test(parentId)
      ? { 'In-Reply-To': parentId, References: references.join(' ') }
      : {};
  // Replies use the visible mailbox address; RFC headers identify the conversation.
  // Existing delivery snapshots and incoming legacy reply aliases remain unchanged.
  const replyTo = mailbox.mode === 'TWO_WAY' ? mailbox.address : null;
  const message = await transaction.emailMessage.create({
    data: {
      projectId: delivery.projectId,
      mailboxId: mailbox.id,
      threadId: thread.id,
      deliveryId: delivery.id,
      direction: 'OUTBOUND',
      fromAddress: mailbox.address,
      providerEmailId: delivery.providerEmailId,
      rfcMessageId: delivery.rfcMessageId,
      toAddress: delivery.normalizedEmail,
      replyToAddress: replyTo,
      subject: delivery.subject,
      source: delivery.source,
      textBody: options.textBody ?? '',
      inReplyTo: headers['In-Reply-To'] ?? null,
      referencesHeader: headers.References ?? null,
      ...(options.requestKey ? { requestKey: options.requestKey } : {}),
      ...(options.requestHash ? { requestHash: options.requestHash } : {}),
    },
  });
  await transaction.emailDelivery.update({
    where: { id: delivery.id },
    data: {
      mailboxId: mailbox.id,
      senderSnapshot: mailbox.displayName
        ? JSON.stringify(mailbox.displayName) + ' <' + mailbox.address + '>'
        : mailbox.address,
      replyToSnapshot: replyTo,
      headersSnapshot: headers,
    },
  });
  await transaction.emailThread.update({
    where: { id: thread.id },
    data: {
      messageCount: { increment: 1 },
      lastMessageAt: message.occurredAt,
      lastOutboundAt: message.occurredAt,
      preview: (options.textBody ?? delivery.subject).slice(0, 240),
    },
  });
  return message;
}
