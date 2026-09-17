import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { AutomationRuntimeService } from '../automation/automation-runtime.service';
import { EmailDeliveryService } from './email-delivery.service';
import { createDefaultEmailDocument } from '@omnicus/email-core';

function replyFixture(automatic = false, text = 'Yes, please') {
  const reply = {
    id: 'reply',
    projectId: 'p1',
    threadId: 't1',
    mailboxId: 'm1',
    automationStatus: 'PENDING',
    isAutomatic: automatic,
    fromAddress: 'alice@example.com',
    subject: 'Re: Hello',
    textBody: text,
    occurredAt: new Date('2026-09-15T10:01:00Z'),
    thread: {
      contact: {
        id: 'c1',
        status: 'ACTIVE',
        automationMode: 'ENABLED',
        customFields: {},
        displayName: 'Alice',
        email: 'alice@example.com',
      },
      mailbox: { status: 'ACTIVE', mode: 'TWO_WAY' },
      project: { status: 'ACTIVE' },
    },
  };
  const tx = {
    $executeRaw: vi.fn(),
    emailMessage: {
      findUnique: vi.fn().mockResolvedValue(reply),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({ occurredAt: new Date('2026-09-15T10:00:00Z') }),
    },
    waitState: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'w1',
          scenarioExecutionId: 'e1',
          successNodeId: 'next',
          criteria: { kind: 'TEXT', operator: 'contains', value: 'yes', caseSensitive: false },
          createdAt: new Date('2026-09-15T10:00:00Z'),
        },
      ]),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    scenario: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const runtime = new AutomationRuntimeService({
    client: { $transaction: (callback: (value: unknown) => unknown) => callback(tx) },
  } as never);
  const resume = vi.fn();
  Object.assign(runtime, { resumeExecutionInTransaction: resume });
  return { tx, runtime, resume, reply };
}
describe('Email automation continuation', () => {
  it('resolves matching waits before new triggers and scopes to exact tenant, thread and contact', async () => {
    const { tx, runtime, resume } = replyFixture();
    await runtime.processInboundEmail('reply');
    expect(tx.waitState.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'p1',
          emailThreadId: 't1',
          execution: { contactId: 'c1', status: 'WAITING' },
        }),
      }),
    );
    expect(tx.waitState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'w1', status: 'ACTIVE' },
        data: expect.objectContaining({ resolvedByEmailMessageId: 'reply', status: 'RESOLVED' }),
      }),
    );
    expect(resume).toHaveBeenCalledWith(
      tx,
      'e1',
      'p1',
      'next',
      expect.objectContaining({ emailThreadId: 't1', normalizedEventId: '' }),
    );
    expect(tx.emailMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { automationStatus: 'COMPLETED', automationError: null } }),
    );
  });
  it('ignores automatic replies, unrelated text and reprocessed messages', async () => {
    const automatic = replyFixture(true);
    await automatic.runtime.processInboundEmail('reply');
    expect(automatic.resume).not.toHaveBeenCalled();
    const unrelated = replyFixture(false, 'No');
    await unrelated.runtime.processInboundEmail('reply');
    expect(unrelated.resume).not.toHaveBeenCalled();
    const duplicate = replyFixture();
    duplicate.reply.automationStatus = 'COMPLETED';
    await duplicate.runtime.processInboundEmail('reply');
    expect(duplicate.tx.emailMessage.updateMany).not.toHaveBeenCalled();
  });
  it('does not consume a reply twice or accept a message older than the outgoing email', async () => {
    const used = replyFixture();
    used.tx.waitState.findFirst.mockResolvedValue({ id: 'prior-wait' } as never);
    await used.runtime.processInboundEmail('reply');
    expect(used.resume).not.toHaveBeenCalled();
    const old = replyFixture();
    old.reply.occurredAt = new Date('2026-09-15T09:00:00Z');
    await old.runtime.processInboundEmail('reply');
    expect(old.resume).not.toHaveBeenCalled();
  });
  it('respects paused projects and disabled mailboxes', async () => {
    const paused = replyFixture();
    paused.reply.thread.project.status = 'PAUSED';
    await paused.runtime.processInboundEmail('reply');
    expect(paused.tx.emailMessage.updateMany).not.toHaveBeenCalled();
    const disabled = replyFixture();
    disabled.reply.thread.mailbox.status = 'DISABLED';
    await disabled.runtime.processInboundEmail('reply');
    expect(disabled.resume).not.toHaveBeenCalled();
    const sendOnly = replyFixture();
    sendOnly.reply.thread.mailbox.mode = 'SEND_ONLY';
    await sendOnly.runtime.processInboundEmail('reply');
    expect(sendOnly.tx.emailMessage.updateMany).not.toHaveBeenCalled();
  });
  it('does not race an already received but still importing reply into the timeout branch', async () => {
    const tx = {
      $executeRaw: vi.fn(),
      waitState: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'w1',
          emailThreadId: 't1',
          projectId: 'p1',
          status: 'ACTIVE',
          expiresAt: new Date(0),
          createdAt: new Date(0),
          scenarioExecutionId: 'e1',
        }),
        updateMany: vi.fn(),
      },
      emailThread: { findFirst: vi.fn().mockResolvedValue({ id: 't1', mailboxId: 'm1' }) },
      emailMessage: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      emailInboundReceipt: { count: vi.fn().mockResolvedValue(1) },
    };
    const runtime = new AutomationRuntimeService({
      client: { $transaction: (callback: (value: unknown) => unknown) => callback(tx) },
    } as never);
    await runtime.timeoutWait('w1');
    expect(tx.waitState.updateMany).not.toHaveBeenCalled();
  });
});

describe('Email send reconciliation safety', () => {
  it('reuses the saved reply address for legacy send retries after configuration changes', async () => {
    const delivery = {
      id: 'delivery',
      projectId: 'p1',
      campaignId: null,
      mailboxId: null,
      contact: null,
      source: 'TEST',
      attempts: 2,
      maxAttempts: 5,
      firstAttemptAt: new Date(Date.now() - 60_000),
      senderSnapshot: 'original@example.com',
      replyToSnapshot: 'original-reply@example.com',
      headersSnapshot: { 'X-Omnicus-Delivery-Id': 'delivery' },
      renderedHtml: '<p>Original</p>',
      renderedText: 'Original',
      subject: 'Original subject',
      toEmail: 'client@example.com',
      designSnapshot: createDefaultEmailDocument(),
    };
    const tx = {
      emailMessage: { findFirst: vi.fn().mockResolvedValue(null) },
      emailDelivery: { findUnique: vi.fn().mockResolvedValue(delivery) },
    };
    const client = {
      ...tx,
      emailDelivery: {
        ...tx.emailDelivery,
        findUniqueOrThrow: vi.fn().mockResolvedValue(delivery),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      project: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      $transaction: (callback: (value: unknown) => unknown) => callback(tx),
    };
    const send = vi.fn().mockResolvedValue({ data: { id: 'provider-id' } });
    const service = new EmailDeliveryService(
      new ConfigService({ EMAIL_REPLY_TO: 'changed@example.com' }) as never,
      { client } as never,
    );
    const markSent = vi.fn(),
      failDelivery = vi.fn();
    Object.assign(service, { resend: { emails: { send } }, markSent, failDelivery });
    await (service as unknown as { processDelivery(id: string): Promise<void> }).processDelivery(
      'delivery',
    );
    expect(failDelivery).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'original@example.com',
        replyTo: 'original-reply@example.com',
        html: '<p>Original</p>',
        text: 'Original',
        subject: 'Original subject',
      }),
      expect.objectContaining({ idempotencyKey: 'delivery' }),
    );
    expect(markSent).toHaveBeenCalledTimes(1);
  });
  it('does not resend after the provider idempotency window', async () => {
    const delivery = {
      id: 'delivery',
      projectId: 'p1',
      campaignId: null,
      attempts: 1,
      maxAttempts: 5,
      firstAttemptAt: new Date(Date.now() - 25 * 60 * 60_000),
    };
    const updateMany = vi.fn();
    const service = new EmailDeliveryService(
      new ConfigService({}) as never,
      {
        client: {
          emailDelivery: {
            findUnique: vi.fn().mockResolvedValue(delivery),
            findUniqueOrThrow: vi.fn().mockResolvedValue(delivery),
            updateMany,
          },
        },
      } as never,
    ) as unknown as { processDelivery(id: string): Promise<void> };
    await service.processDelivery('delivery');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'UNKNOWN',
          lastError: 'email_delivery_unknown_reconcile_before_retry',
        }),
        where: expect.objectContaining({ status: 'PROCESSING' }),
      }),
    );
  });
  it('preserves an earlier DELIVERED webhook when the send response arrives later', async () => {
    const update = vi.fn(),
      updateMany = vi.fn();
    const tx = {
      $executeRaw: vi.fn(),
      emailDelivery: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          status: 'DELIVERED',
          rfcMessageId: '<sent@example.com>',
          sentAt: new Date(),
          providerLastEventAt: new Date(),
        }),
        update,
      },
      emailMessage: { updateMany },
      emailEvent: {
        upsert: vi.fn().mockResolvedValue({ id: 'event' }),
        findFirst: vi.fn().mockResolvedValue({ id: 'provider-event' }),
      },
    };
    const service = new EmailDeliveryService(
      new ConfigService({}) as never,
      {
        client: { $transaction: (callback: (value: unknown) => unknown) => callback(tx) },
      } as never,
    ) as unknown as { markSent(delivery: unknown, id: string): Promise<void> };
    await service.markSent({ id: 'delivery', projectId: 'p1' }, 'provider-id');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DELIVERED' }) }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { providerEmailId: 'provider-id', rfcMessageId: '<sent@example.com>' },
      }),
    );
  });
});
