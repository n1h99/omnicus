import { randomBytes, randomUUID } from 'node:crypto';
import { convert } from 'html-to-text';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnvironment } from '@omnicus/config/server';
import {
  blockedMailAttachment,
  isAutomaticMail,
  mailboxAddressesEquivalent,
  mailAttachmentLimit,
  mailHeader,
  mailMessageIds,
  mailTextLimit,
  parseMailAddress,
  replyAliasToken,
  safeMailFilename,
  type ReceivedMail,
} from '@omnicus/email-core';
import { ResendMailApiError, ResendMailClient } from '@omnicus/email-core/server';
import { S3MediaStorage } from '@omnicus/media-core';
import { DatabaseService } from '../database/database.service';
import { AutomationRuntimeService } from '../automation/automation-runtime.service';
import { downloadEmailAttachment } from './email-attachment-download';

@Injectable()
export class EmailInboundService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(EmailInboundService.name);
  private readonly workerId = 'email-inbound:' + randomUUID();
  private readonly provider: ResendMailClient | undefined;
  private readonly storage: S3MediaStorage | undefined;
  private timer: NodeJS.Timeout | undefined;
  private draining = false;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(AutomationRuntimeService) private readonly runtime: AutomationRuntimeService,
  ) {
    const key = config.get('RESEND_API_KEY', { infer: true });
    if (key) this.provider = new ResendMailClient(key);
    if (config.get('MEDIA_STORAGE_ENABLED', { infer: true }))
      this.storage = new S3MediaStorage({
        accessKeyId: config.get('MEDIA_BUCKET_ACCESS_KEY_ID', { infer: true })!,
        secretAccessKey: config.get('MEDIA_BUCKET_SECRET_ACCESS_KEY', { infer: true })!,
        bucket: config.get('MEDIA_BUCKET', { infer: true })!,
        endpoint: config.get('MEDIA_BUCKET_ENDPOINT', { infer: true })!,
        region: config.get('MEDIA_BUCKET_REGION', { infer: true }),
        forcePathStyle: config.get('MEDIA_BUCKET_FORCE_PATH_STYLE', { infer: true }),
      });
  }

  onApplicationBootstrap() {
    if (!this.provider) return;
    this.timer = setInterval(() => void this.drain(), 5_000);
    this.timer.unref();
    void this.drain();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async drain() {
    if (this.draining || !this.provider) return;
    this.draining = true;
    try {
      await this.database.client.emailInboundReceipt.updateMany({
        where: { status: 'PROCESSING', lockedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
        data: { status: 'RETRY', lockedAt: null, lockedBy: null, nextAttemptAt: new Date() },
      });
      for (let count = 0; count < 5; count += 1) {
        const receipt = await this.database.client.emailInboundReceipt.findFirst({
          where: {
            status: { in: ['PENDING', 'RETRY'] },
            nextAttemptAt: { lte: new Date() },
            mailbox: { status: 'ACTIVE', mode: 'TWO_WAY', project: { status: 'ACTIVE' } },
          },
          orderBy: { occurredAt: 'asc' },
        });
        if (!receipt) break;
        const claimed = await this.database.client.emailInboundReceipt.updateMany({
          where: { id: receipt.id, status: receipt.status },
          data: {
            status: 'PROCESSING',
            lockedAt: new Date(),
            lockedBy: this.workerId,
            attempts: { increment: 1 },
          },
        });
        if (!claimed.count) continue;
        try {
          await this.process(receipt.id);
        } catch (error) {
          const code =
            error instanceof Error && /^email_[a-z0-9_]+$/.test(error.message)
              ? error.message
              : 'email_inbound_processing_failed';
          const permanent = error instanceof ResendMailApiError && !error.retryable;
          await this.database.client.emailInboundReceipt.updateMany({
            where: { id: receipt.id, status: 'PROCESSING', lockedBy: this.workerId },
            data: {
              status: permanent || receipt.attempts >= 11 ? 'FAILED' : 'RETRY',
              lockedAt: null,
              lockedBy: null,
              lastError: code,
              nextAttemptAt: new Date(
                Date.now() + Math.min(900_000, 15_000 * 2 ** receipt.attempts),
              ),
            },
          });
          this.logger.warn({ message: 'email_inbound_failed', receiptId: receipt.id, code });
        }
      }
      const replies = await this.database.client.emailMessage.findMany({
        where: {
          automationStatus: 'PENDING',
          direction: 'INBOUND',
          thread: {
            project: { status: 'ACTIVE' },
            mailbox: { status: 'ACTIVE', mode: 'TWO_WAY' },
          },
        },
        select: { id: true },
        orderBy: { occurredAt: 'asc' },
        take: 25,
      });
      for (const reply of replies) {
        try {
          await this.runtime.processInboundEmail(reply.id);
        } catch {
          await this.database.client.emailMessage.updateMany({
            where: { id: reply.id, automationStatus: 'PENDING' },
            data: { automationStatus: 'FAILED', automationError: 'email_automation_resume_failed' },
          });
          this.logger.warn({ message: 'email_automation_resume_failed', messageId: reply.id });
        }
      }
    } catch {
      this.logger.warn({ message: 'email_inbound_scan_failed' });
    } finally {
      this.draining = false;
    }
  }

  async process(receiptId: string) {
    const receipt = await this.database.client.emailInboundReceipt.findUnique({
      where: { id: receiptId },
      include: { mailbox: true },
    });
    if (!receipt || receipt.status !== 'PROCESSING' || receipt.lockedBy !== this.workerId) return;
    const incoming = await this.provider!.received(receipt.providerEmailId);
    const sender = parseMailAddress(incoming.from);
    if (incoming.id !== receipt.providerEmailId || !sender)
      throw new Error('email_inbound_identity_invalid');
    const recipients = [...incoming.to, ...incoming.cc, ...incoming.bcc].map(parseMailAddress);
    if (!recipients.includes(receipt.recipient))
      throw new Error('email_inbound_recipient_mismatch');
    const message = await this.database.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${receipt.mailboxId}), hashtext(${sender}))`;
      const mailbox = await tx.emailMailbox.findFirst({
        where: {
          id: receipt.mailboxId,
          projectId: receipt.projectId,
          status: 'ACTIVE',
          mode: 'TWO_WAY',
          project: { status: 'ACTIVE' },
        },
      });
      if (!mailbox) throw new Error('email_mailbox_paused');
      const existing = await tx.emailMessage.findFirst({
        where: {
          mailboxId: receipt.mailboxId,
          projectId: receipt.projectId,
          providerEmailId: incoming.id,
          direction: 'INBOUND',
        },
      });
      if (existing) return existing;
      const token = replyAliasToken(receipt.recipient);
      const tokenThreads = token
        ? await tx.emailThread.findMany({
            where: {
              projectId: receipt.projectId,
              mailboxId: receipt.mailboxId,
              replyToken: token,
            },
            take: 5,
          })
        : [];
      let thread =
        tokenThreads.find((candidate) =>
          mailboxAddressesEquivalent(candidate.peerEmail, sender),
        ) ?? null;
      const referenceIds = [
        ...mailMessageIds(mailHeader(incoming.headers, 'in-reply-to')),
        ...mailMessageIds(mailHeader(incoming.headers, 'references')).reverse(),
      ];
      if (!thread && referenceIds.length) {
        const candidates = await tx.emailMessage.findMany({
          where: {
            projectId: receipt.projectId,
            mailboxId: receipt.mailboxId,
            rfcMessageId: { in: referenceIds },
          },
          include: { thread: true },
          take: 30,
        });
        thread =
          referenceIds
            .map(
              (id) =>
                candidates.find(
                  (candidate) =>
                    candidate.rfcMessageId === id &&
                    mailboxAddressesEquivalent(candidate.thread.peerEmail, sender),
                )?.thread,
            )
            .find(Boolean) ?? null;
      }
      if (!thread) {
        const contacts = await tx.contact.findMany({
          where: { projectId: receipt.projectId, normalizedEmail: sender, status: 'ACTIVE' },
          take: 2,
          select: { id: true },
        });
        thread = await tx.emailThread.create({
          data: {
            projectId: receipt.projectId,
            mailboxId: receipt.mailboxId,
            peerEmail: sender,
            contactId: contacts.length === 1 ? contacts[0]!.id : null,
            subject: incoming.subject.slice(0, 200),
            lastMessageAt: receipt.occurredAt,
            replyToken: randomBytes(18).toString('hex'),
          },
        });
      }
      const automatic = isAutomaticMail(incoming.headers, sender);
      if (!thread.contactId) {
        const matches = await tx.contact.findMany({
          where: { projectId: receipt.projectId, normalizedEmail: sender, status: 'ACTIVE' },
          take: 2,
          select: { id: true },
        });
        if (matches.length === 1)
          await tx.emailThread.update({
            where: { id: thread.id },
            data: { contactId: matches[0]!.id },
          });
      }
      const text = (
        incoming.text ||
        convert(incoming.html ?? '', {
          wordwrap: false,
          limits: { maxInputLength: 2_000_000 },
          selectors: [
            { selector: 'img', format: 'skip' },
            { selector: 'a', options: { ignoreHref: true } },
          ],
        })
      ).slice(0, mailTextLimit);
      const message = await tx.emailMessage.create({
        data: {
          projectId: receipt.projectId,
          mailboxId: receipt.mailboxId,
          threadId: thread.id,
          providerEmailId: incoming.id,
          direction: 'INBOUND',
          source: 'RECEIVED',
          fromAddress: sender,
          toAddress: mailbox.address,
          replyToAddress: incoming.reply_to[0] ? parseMailAddress(incoming.reply_to[0]) : null,
          subject: incoming.subject,
          textBody: text,
          htmlBody: incoming.html ?? '',
          rfcMessageId: mailMessageIds(incoming.message_id ?? '')[0] ?? null,
          inReplyTo: referenceIds[0] ?? null,
          referencesHeader: mailMessageIds(mailHeader(incoming.headers, 'references')).join(' '),
          isAutomatic: automatic,
          automationStatus: 'AWAITING_CONTENT',
          occurredAt: receipt.occurredAt,
        },
      });
      await tx.emailThread.update({
        where: { id: thread.id },
        data: {
          messageCount: { increment: 1 },
          ...(receipt.occurredAt >= thread.lastMessageAt
            ? {
                lastMessageAt: receipt.occurredAt,
                preview: (text || incoming.subject).slice(0, 240),
              }
            : {}),
          ...(!thread.lastInboundAt || receipt.occurredAt > thread.lastInboundAt
            ? { lastInboundAt: receipt.occurredAt }
            : {}),
        },
      });
      await tx.emailThreadUserState.updateMany({
        where: {
          projectId: receipt.projectId,
          threadId: thread.id,
          archivedAt: { lt: receipt.occurredAt },
        },
        data: { archivedAt: null },
      });
      let total = 0;
      await tx.emailAttachment.createMany({
        data: incoming.attachments.map((file, index) => {
          total += file.size;
          const blocked =
            index >= 20 ||
            total > mailAttachmentLimit ||
            file.size > mailAttachmentLimit ||
            blockedMailAttachment(file.filename ?? '', file.content_type);
          return {
            projectId: receipt.projectId,
            messageId: message.id,
            providerAttachmentId: file.id,
            filename: safeMailFilename(file.filename),
            contentType: file.content_type,
            contentId: file.content_id ?? null,
            sizeBytes: file.size,
            status: blocked ? 'BLOCKED' : 'PENDING',
            errorCode: blocked ? 'email_attachment_blocked_or_too_large' : null,
          };
        }),
        skipDuplicates: true,
      });
      return message;
    });
    await this.importAttachments(message.id, receipt.projectId, incoming, receiptId);
    await this.database.client.$transaction(async (tx) => {
      const completed = await tx.emailInboundReceipt.updateMany({
        where: { id: receipt.id, status: 'PROCESSING', lockedBy: this.workerId },
        data: {
          status: 'COMPLETED',
          processedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
      if (completed.count)
        await tx.emailMessage.updateMany({
          where: {
            id: message.id,
            projectId: receipt.projectId,
            automationStatus: 'AWAITING_CONTENT',
          },
          data: { automationStatus: message.isAutomatic ? 'NONE' : 'PENDING' },
        });
    });
  }

  private async importAttachments(
    messageId: string,
    projectId: string,
    incoming: ReceivedMail,
    receiptId: string,
  ) {
    const attachments = await this.database.client.emailAttachment.findMany({
      where: { messageId, projectId, status: 'PENDING' },
    });
    for (const attachment of attachments) {
      const lease = await this.database.client.emailInboundReceipt.updateMany({
        where: { id: receiptId, status: 'PROCESSING', lockedBy: this.workerId },
        data: { lockedAt: new Date() },
      });
      if (!lease.count) throw new Error('email_inbound_lease_lost');
      if (!this.storage) {
        throw new Error('email_storage_unavailable');
      }
      const file = await this.provider!.attachment(incoming.id, attachment.providerAttachmentId);
      const bytes = await downloadEmailAttachment(file.download_url, attachment.sizeBytes);
      const bucketKey = 'projects/' + projectId + '/email/' + messageId + '/' + attachment.id;
      await this.storage.putObject(bucketKey, bytes, 'application/octet-stream');
      await this.database.client.emailAttachment.update({
        where: { id: attachment.id },
        data: { bucketKey, status: 'AVAILABLE', errorCode: null },
      });
    }
  }
}
