import { ConfigService } from '@nestjs/config';
import { WhatsAppApiError } from '@omnicus/channel-whatsapp';
import { describe, expect, it, vi } from 'vitest';

import { WhatsAppOutboundProcessorService } from './whatsapp-outbound-processor.service';

const config = new ConfigService({
  CHANNEL_SECRETS_KEY: Buffer.alloc(32, 9).toString('base64'),
  MEDIA_STORAGE_ENABLED: false,
  REDIS_URL: 'redis://localhost:6379/0',
  WHATSAPP_OUTBOUND_LEASE_MS: 30_000,
});

const claim = (payload: Record<string, unknown> = {}) => ({
  attempts: 1,
  connectionId: 'connection-a',
  id: 'outbox-a',
  leaseToken: 'lease-a',
  maxAttempts: 8,
  payload: { channelIdentityId: 'identity-a', messageId: 'message-a', ...payload },
  projectId: 'project-a',
});

function service(client: Record<string, unknown> = {}) {
  return new WhatsAppOutboundProcessorService(config as never, { client } as never);
}

describe('WhatsApp outbound terminal semantics', () => {
  function installLogger(instance: WhatsAppOutboundProcessorService): ReturnType<typeof vi.fn> {
    const warn = vi.fn();
    const internals = instance as never as { logger: { warn: ReturnType<typeof vi.fn> } };
    internals.logger.warn = warn;
    return warn;
  }

  function sendingHarness(
    error?: unknown,
    options: {
      apiResult?: { messageId: string };
      connection?: Record<string, unknown>;
      decrypt?: () => string;
      claimPayload?: Record<string, unknown>;
      message?: Record<string, unknown>;
      identity?: Record<string, unknown>;
      recipient?: Record<string, unknown> | null;
    } = {},
  ) {
    const credentialsEncrypted = options.connection?.['credentialsEncrypted'] as
      Record<string, unknown> | undefined;
    const recipient = options.recipient === undefined ? null : options.recipient;
    const databaseClient = {
      broadcastRecipient: { findFirst: vi.fn().mockResolvedValue(recipient) },
      channelIdentity: {
        findUnique: vi.fn().mockResolvedValue(
          options.identity ?? {
            channel: 'WHATSAPP',
            connectionId: 'connection-a',
            contactId: 'contact-a',
            externalUserId: '15550001',
            id: 'identity-a',
          },
        ),
      },
      message: {
        findUnique: vi.fn().mockResolvedValue(
          options.message ?? {
            connectionId: 'connection-a',
            contactId: 'contact-a',
            content: { text: 'hello' },
            conversation: { id: 'conversation-a' },
            conversationId: 'conversation-a',
            id: 'message-a',
            mediaAsset: null,
            metadata: {},
            type: 'TEXT',
          },
        ),
      },
      outboxRecord: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      scheduledMessage: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const instance = service(databaseClient);
    const retry = vi.fn().mockResolvedValue(undefined);
    const unknown = vi.fn().mockResolvedValue(undefined);
    const failOutboxOnly = vi.fn().mockResolvedValue(undefined);
    const unknownOutboxOnly = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);
    const persistProviderSendJournal = vi.fn().mockResolvedValue(true);
    const recoverJournaledSend = vi.fn().mockResolvedValue(undefined);
    const markMessageRead = vi
      .fn()
      .mockImplementation(() =>
        error === undefined ? Promise.resolve(undefined) : Promise.reject(error),
      );

    const internals = instance as never as {
      api: {
        markMessageRead: ReturnType<typeof vi.fn>;
        sendMessage: ReturnType<typeof vi.fn>;
      };
      claim: ReturnType<typeof vi.fn>;
      connection: ReturnType<typeof vi.fn>;
      decrypt: ReturnType<typeof vi.fn>;
      fail: typeof fail;
      prepareMessage: ReturnType<typeof vi.fn>;
      persistProviderSendJournal: typeof persistProviderSendJournal;
      recoverJournaledSend: typeof recoverJournaledSend;
      replyProviderMessageId: ReturnType<typeof vi.fn>;
      retry: typeof retry;
      unknown: typeof unknown;
      failOutboxOnly: typeof failOutboxOnly;
      unknownOutboxOnly: typeof unknownOutboxOnly;
    };

    internals.claim = vi.fn().mockResolvedValue(claim(options.claimPayload));
    internals.connection = vi.fn().mockResolvedValue({
      credentialsEncrypted: credentialsEncrypted ?? { accessToken: {} },
      graphApiVersion: 'v23.0',
      id: options.connection?.['id'] ? (options.connection['id'] as string) : 'connection-a',
      phoneNumberId: options.connection?.['phoneNumberId']
        ? (options.connection['phoneNumberId'] as string)
        : 'phone-a',
      projectId: options.connection?.['projectId']
        ? (options.connection['projectId'] as string)
        : 'project-a',
      ...(options.connection ? options.connection : {}),
    } as Record<string, unknown>);
    internals.prepareMessage = vi
      .fn()
      .mockResolvedValue({ message: { template: {}, type: 'template' }, template: true });
    internals.replyProviderMessageId = vi.fn().mockResolvedValue(undefined);
    internals.api = {
      markMessageRead,
      sendMessage: vi
        .fn()
        .mockImplementation(() =>
          error === undefined
            ? Promise.resolve(options.apiResult ?? { messageId: 'wamid.1' })
            : Promise.reject(error),
        ),
    };
    internals.decrypt = vi.fn().mockImplementation(() => options.decrypt?.() ?? 'mock-token');
    internals.persistProviderSendJournal = persistProviderSendJournal;
    internals.recoverJournaledSend = recoverJournaledSend;
    internals.retry = retry;
    internals.unknown = unknown;
    internals.failOutboxOnly = failOutboxOnly;
    internals.unknownOutboxOnly = unknownOutboxOnly;
    internals.fail = fail;

    return {
      failOutboxOnly,
      unknownOutboxOnly,
      fail,
      instance,
      markMessageRead,
      persistProviderSendJournal,
      recoverJournaledSend,
      retry,
      unknown,
      sendMessage: internals.api.sendMessage,
    };
  }

  it('sends a text message successfully through the normal outbound path', async () => {
    const {
      instance,
      retry,
      unknown,
      fail,
      persistProviderSendJournal,
      recoverJournaledSend,
      sendMessage,
    } = sendingHarness(undefined, { apiResult: { messageId: 'wamid.ok' } });

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '15550001',
        message: expect.objectContaining({ type: 'template' }),
      }),
    );
    expect(persistProviderSendJournal).toHaveBeenCalledWith(claim(), 'wamid.ok');
    expect(recoverJournaledSend).toHaveBeenCalledWith(claim(), 'message-a', 'wamid.ok');
    expect(fail).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();
  });

  it('marks an inbound message as read through MARK_READ action', async () => {
    const { instance, fail, failOutboxOnly, markMessageRead, retry, unknownOutboxOnly, unknown } =
      sendingHarness(undefined, {
        claimPayload: {
          action: 'MARK_READ',
          messageId: 'message-a',
          providerMessageId: 'wamid.inbound',
        },
      });

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(markMessageRead).toHaveBeenCalledWith({
      accessToken: 'mock-token',
      graphApiVersion: 'v23.0',
      messageId: 'wamid.inbound',
      phoneNumberId: 'phone-a',
    });
    expect(fail).not.toHaveBeenCalled();
    expect(failOutboxOnly).not.toHaveBeenCalled();
    expect(unknownOutboxOnly).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();
  });

  it('fails mark-read when provider message id is missing and does not send request', async () => {
    const { instance, failOutboxOnly, markMessageRead } = sendingHarness(undefined, {
      claimPayload: { action: 'MARK_READ' },
    });

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(markMessageRead).not.toHaveBeenCalled();
    expect(failOutboxOnly).toHaveBeenCalledWith(
      claim({ action: 'MARK_READ' }),
      'whatsapp_read_target_invalid',
    );
  });

  it('fails mark-read when access token is missing without sending request', async () => {
    const { instance, failOutboxOnly, markMessageRead, unknown } = sendingHarness(undefined, {
      claimPayload: {
        action: 'MARK_READ',
        messageId: 'message-a',
        providerMessageId: 'wamid.inbound',
      },
      connection: { credentialsEncrypted: {} },
    });
    const warn = installLogger(instance);

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(markMessageRead).not.toHaveBeenCalled();
    expect(failOutboxOnly).toHaveBeenCalledWith(
      claim({ action: 'MARK_READ', messageId: 'message-a', providerMessageId: 'wamid.inbound' }),
      'whatsapp_mark_read_failed',
    );
    expect(unknown).not.toHaveBeenCalled();
    const event = JSON.parse(warn.mock.calls.at(-1)![0] as string);
    expect(event.safeReason).toBe('ACCESS_TOKEN_MISSING');
  });

  it('retries mark-read on retryable provider failures', async () => {
    const { instance, retry, markMessageRead } = sendingHarness(
      new WhatsAppApiError(500, 7, 190, 463, true),
      {
        claimPayload: {
          action: 'MARK_READ',
          messageId: 'message-a',
          providerMessageId: 'wamid.inbound',
        },
      },
    );

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(markMessageRead).toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith(
      claim({ action: 'MARK_READ', messageId: 'message-a', providerMessageId: 'wamid.inbound' }),
      'whatsapp_mark_read_retryable',
      7,
      true,
    );
  });

  it('stores unknown on timeout for mark-read', async () => {
    const timeout = new Error('request timed out');
    timeout.name = 'TimeoutError';
    const { instance, unknownOutboxOnly, markMessageRead } = sendingHarness(timeout, {
      claimPayload: {
        action: 'MARK_READ',
        messageId: 'message-a',
        providerMessageId: 'wamid.inbound',
      },
    });

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(markMessageRead).toHaveBeenCalled();
    expect(unknownOutboxOnly).toHaveBeenCalledWith(
      claim({ action: 'MARK_READ', messageId: 'message-a', providerMessageId: 'wamid.inbound' }),
      'whatsapp_mark_read_unknown',
    );
  });

  it('fails mark-read permanently on 401/403 provider errors', async () => {
    const { instance, failOutboxOnly, markMessageRead } = sendingHarness(
      new WhatsAppApiError(
        401,
        undefined,
        190,
        463,
        false,
        'OAuthException',
        'Invalid OAuth access token',
      ),
      {
        claimPayload: {
          action: 'MARK_READ',
          messageId: 'message-a',
          providerMessageId: 'wamid.inbound',
        },
      },
    );
    const warn = installLogger(instance);

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(markMessageRead).toHaveBeenCalled();
    expect(failOutboxOnly).toHaveBeenCalledWith(
      claim({ action: 'MARK_READ', messageId: 'message-a', providerMessageId: 'wamid.inbound' }),
      'whatsapp_mark_read_failed',
    );
    const event = JSON.parse(warn.mock.calls.at(-1)![0] as string);
    expect(event.safeReason).toBe('GRAPH_API_UNAUTHORIZED');
    expect(event.httpStatus).toBe(401);
  });

  it('never logs sensitive data for mark-read failures', async () => {
    const { instance, markMessageRead, failOutboxOnly } = sendingHarness(
      new WhatsAppApiError(403, undefined, 200, 400, false, 'OAuthException', 'Permissions error'),
      {
        claimPayload: {
          action: 'MARK_READ',
          messageId: 'message-a',
          providerMessageId: 'wamid.inbound',
        },
        connection: {
          credentialsEncrypted: { accessToken: {} },
        },
        decrypt: () => 'super-secret-access-token',
      },
    );
    const warn = installLogger(instance);

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(markMessageRead).toHaveBeenCalled();
    expect(failOutboxOnly).toHaveBeenCalledWith(
      claim({ action: 'MARK_READ', messageId: 'message-a', providerMessageId: 'wamid.inbound' }),
      'whatsapp_mark_read_failed',
    );
    const event = JSON.parse(warn.mock.calls.at(-1)![0] as string);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('super-secret-access-token');
    expect(serialized).not.toContain('rawBody');
    expect(serialized).not.toContain('providerResponse');
    expect(serialized).not.toContain('providerMessage');
    expect(serialized).not.toContain('requestBody');
  });

  it('retries an explicit 429 exactly once', async () => {
    const { instance, retry, unknown } = sendingHarness(new WhatsAppApiError(429, 7));
    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(claim(), 'whatsapp_outbound_retryable', 7);
    expect(unknown).not.toHaveBeenCalled();
  });

  it.each([
    ['server rejection with 5xx', new WhatsAppApiError(500, undefined, 1000)],
    [
      'timeout',
      (() => {
        const timeout = new Error('Request timed out');
        timeout.name = 'TimeoutError';
        return timeout;
      })(),
    ],
    ['network error', new Error('network timeout')],
  ])('classifies %s as retryable/unknown as expected', async (_, error) => {
    const { instance, retry, unknown } = sendingHarness(error);
    await instance.process({ outboxRecordId: 'outbox-a' });

    if (error instanceof WhatsAppApiError && error.status >= 500) {
      expect(retry).toHaveBeenCalledWith(claim(), 'whatsapp_outbound_retryable', undefined);
      expect(unknown).not.toHaveBeenCalled();
    } else {
      expect(unknown).toHaveBeenCalledWith(claim(), 'message-a', 'whatsapp_outbound_unknown');
      expect(retry).not.toHaveBeenCalled();
    }
  });

  it('maps 400 to a safe provider-rejected reason when template/recipient patterns are absent', async () => {
    const { fail, instance, retry, unknown } = sendingHarness(
      new WhatsAppApiError(
        400,
        undefined,
        1001,
        2002,
        false,
        'SomeType',
        'Invalid request payload',
      ),
    );
    const warn = installLogger(instance);

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(fail).toHaveBeenCalledWith(
      claim(),
      'whatsapp_outbound_rejected',
      'message-a',
      'GRAPH_API_PROVIDER_REJECTED',
    );
    expect(retry).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();

    const event = JSON.parse(warn.mock.calls.at(-1)![0] as string);
    expect(event.safeReason).toBe('GRAPH_API_PROVIDER_REJECTED');
    expect(event.httpStatus).toBe(400);
    expect(event.providerErrorCode).toBe(1001);
    expect(event.providerErrorSubcode).toBe(2002);
    expect(event.retryable).toBe(false);
  });

  it('maps 401 to GRAPH_API_UNAUTHORIZED with safe diagnostics', async () => {
    const { fail, instance, retry, unknown } = sendingHarness(
      new WhatsAppApiError(
        401,
        undefined,
        190,
        463,
        false,
        'OAuthException',
        'Invalid OAuth access token',
      ),
    );
    const warn = installLogger(instance);

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(fail).toHaveBeenCalledWith(
      claim(),
      'whatsapp_outbound_rejected',
      'message-a',
      'GRAPH_API_UNAUTHORIZED',
    );
    expect(fail).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();

    const event = JSON.parse(warn.mock.calls.at(-1)![0] as string);
    expect(event.safeReason).toBe('GRAPH_API_UNAUTHORIZED');
    expect(event.httpStatus).toBe(401);
    expect(event.retryable).toBe(false);
    expect(event.providerErrorCode).toBe(190);
    expect(event.providerErrorSubcode).toBe(463);
  });

  it('maps 403 to GRAPH_API_PERMISSION_DENIED with safe diagnostics', async () => {
    const { fail, instance, retry, unknown } = sendingHarness(
      new WhatsAppApiError(403, undefined, 200, 400, false, 'OAuthException', 'Permissions error'),
    );
    const warn = installLogger(instance);

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(fail).toHaveBeenCalledWith(
      claim(),
      'whatsapp_outbound_rejected',
      'message-a',
      'GRAPH_API_PERMISSION_DENIED',
    );
    expect(fail).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();

    const event = JSON.parse(warn.mock.calls.at(-1)![0] as string);
    expect(event.safeReason).toBe('GRAPH_API_PERMISSION_DENIED');
    expect(event.httpStatus).toBe(403);
    expect(event.retryable).toBe(false);
  });

  it('fails closed when access token is not decryptable and never sends request', async () => {
    const { fail, instance, retry, unknown, sendMessage } = sendingHarness(
      new WhatsAppApiError(500),
      {
        decrypt: () => {
          throw new Error('bad key');
        },
      },
    );
    const warn = installLogger(instance);

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(claim(), 'whatsapp_outbound_rejected', 'message-a');
    expect(retry).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();

    const event = JSON.parse(warn.mock.calls.at(-1)![0] as string);
    expect(event.safeReason).toBe('ACCESS_TOKEN_DECRYPT_FAILED');
    expect(event.accessTokenPresent).toBe(true);
    expect(event.accessTokenDecryptSucceeded).toBe(false);
  });

  it('fails with RECIPIENT_MISSING before sending request and logs the reason', async () => {
    const { fail, instance, retry, unknown, sendMessage } = sendingHarness(undefined, {
      identity: {
        channel: 'WHATSAPP',
        connectionId: 'connection-a',
        contactId: 'contact-a',
        externalUserId: '',
        id: 'identity-a',
      },
    });
    const warn = installLogger(instance);

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(claim(), 'whatsapp_outbound_rejected', 'message-a');
    expect(retry).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();

    const event = JSON.parse(warn.mock.calls.at(-1)![0] as string);
    expect(event.safeReason).toBe('RECIPIENT_MISSING');
    expect(event.recipientPresent).toBe(false);
  });

  it('fails with ACCESS_TOKEN_MISSING when encrypted token is absent and never sends request', async () => {
    const { fail, instance, retry, unknown, sendMessage } = sendingHarness(undefined, {
      connection: { credentialsEncrypted: {} },
    });
    const warn = installLogger(instance);

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(claim(), 'whatsapp_outbound_rejected', 'message-a');
    expect(retry).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();

    const event = JSON.parse(warn.mock.calls.at(-1)![0] as string);
    expect(event.safeReason).toBe('ACCESS_TOKEN_MISSING');
    expect(event.accessTokenPresent).toBe(false);
  });

  it('never logs sensitive data in outbound failure diagnostics', async () => {
    const { fail, instance, retry, unknown, sendMessage } = sendingHarness(
      new WhatsAppApiError(
        401,
        undefined,
        190,
        463,
        false,
        'OAuthException',
        'Invalid OAuth access token',
      ),
      {
        connection: { credentialsEncrypted: { accessToken: {} } },
        decrypt: () => 'super-secret-access-token',
      },
    );
    const warn = installLogger(instance);

    await instance.process({ outboxRecordId: 'outbox-a' });

    expect(sendMessage).toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      claim(),
      'whatsapp_outbound_rejected',
      'message-a',
      'GRAPH_API_UNAUTHORIZED',
    );
    expect(retry).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();

    const event = JSON.parse(warn.mock.calls.at(-1)![0] as string);
    expect(event).toBeDefined();
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('super-secret-access-token');
    expect(serialized).not.toContain('rawBody');
    expect(serialized).not.toContain('raw body');
    expect(serialized).not.toContain('providerResponse');
    expect(serialized).not.toContain('providerMessage');
    expect(serialized).not.toContain('requestBody');
    expect(serialized).not.toContain('request body');
  });

  it('finishes a journaled provider acceptance as SENT after a worker crash', async () => {
    const outboxUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const messageUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const recipientUpdate = vi.fn().mockResolvedValue({ count: 0 });
    const identityUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const scheduledUpdate = vi.fn().mockResolvedValue({ count: 0 });
    const transaction = {
      broadcastRecipient: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: recipientUpdate,
      },
      crmProjectConfig: { findUnique: vi.fn().mockResolvedValue(null) },
      channelIdentity: { updateMany: identityUpdate },
      message: {
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: messageUpdate,
      },
      outboxRecord: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: outboxUpdate,
      },
      scheduledMessage: { updateMany: scheduledUpdate },
    };
    const instance = service({
      $transaction: (callback: (value: typeof transaction) => unknown) => callback(transaction),
    });
    await (
      instance as never as {
        recoverJournaledSend(
          claimed: ReturnType<typeof claim>,
          messageId: string,
          providerMessageId: string,
        ): Promise<void>;
      }
    ).recoverJournaledSend(claim(), 'message-a', 'wamid.accepted');

    expect(outboxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED' }) }),
    );
    expect(messageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalMessageId: 'wamid.accepted',
          status: 'SENT',
        }),
      }),
    );
    expect(recipientUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }),
    );
    expect(identityUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ whatsAppReachability: 'PENDING' }),
      }),
    );
    expect(scheduledUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }),
    );
  });

  it('does not mutate message projections after the outbox lease is lost', async () => {
    const messageUpdate = vi.fn();
    const transaction = {
      broadcastRecipient: { updateMany: vi.fn() },
      message: { updateMany: messageUpdate },
      outboxRecord: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      scheduledMessage: { updateMany: vi.fn() },
    };
    const instance = service({
      $transaction: (callback: (value: typeof transaction) => unknown) => callback(transaction),
    });
    await expect(
      (
        instance as never as {
          unknown(
            claimed: ReturnType<typeof claim>,
            messageId: string,
            code: string,
          ): Promise<void>;
        }
      ).unknown(claim(), 'message-a', 'ambiguous'),
    ).rejects.toThrow();
    expect(messageUpdate).not.toHaveBeenCalled();
    expect(transaction.broadcastRecipient.updateMany).not.toHaveBeenCalled();
  });
});

describe('WhatsApp outbound scoped actions and media journal', () => {
  it('removes a reaction with an empty emoji and creates no message bubble', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'wamid.reaction' });
    const messageCreate = vi.fn();
    const instance = service({
      channelIdentity: {
        findUnique: vi.fn().mockResolvedValue({
          channel: 'WHATSAPP',
          connectionId: 'connection-a',
          contactId: 'contact-a',
          externalUserId: '15550001',
        }),
      },
      message: {
        create: messageCreate,
        findUnique: vi.fn().mockResolvedValue({
          connectionId: 'connection-a',
          contactId: 'contact-a',
          conversationId: 'conversation-a',
          externalMessageId: 'wamid.target',
        }),
      },
    });
    const succeed = vi.fn().mockResolvedValue(undefined);
    const internals = instance as never as {
      api: { sendMessage: typeof sendMessage };
      assertServiceWindow: ReturnType<typeof vi.fn>;
      decrypt: ReturnType<typeof vi.fn>;
      setReaction(
        claimed: ReturnType<typeof claim>,
        connection: unknown,
        payload: unknown,
      ): Promise<void>;
      succeedOutboxOnly: typeof succeed;
    };
    internals.decrypt = vi.fn().mockReturnValue('mock-token');
    internals.api = { sendMessage };
    internals.assertServiceWindow = vi.fn().mockResolvedValue(undefined);
    internals.succeedOutboxOnly = succeed;
    await internals.setReaction(
      claim(),
      {
        credentialsEncrypted: {},
        graphApiVersion: 'v23.0',
        id: 'connection-a',
        phoneNumberId: 'phone-a',
        projectId: 'project-a',
      },
      {
        action: 'SET_REACTION',
        channelIdentityId: 'identity-a',
        emoji: '',
        messageId: 'message-a',
        providerMessageId: 'wamid.target',
      },
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: { emoji: '', messageId: 'wamid.target', type: 'reaction' },
      }),
    );
    expect(succeed).toHaveBeenCalledTimes(1);
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it('rejects a reply target from another contact or conversation', async () => {
    const instance = service({
      message: {
        findUnique: vi.fn().mockResolvedValue({
          connectionId: 'connection-a',
          contactId: 'contact-b',
          conversationId: 'conversation-b',
          externalMessageId: 'wamid.other',
        }),
      },
    });
    await expect(
      (
        instance as never as {
          replyProviderMessageId(
            metadata: unknown,
            claimed: ReturnType<typeof claim>,
            current: { contactId: string; conversationId: string },
          ): Promise<string | undefined>;
        }
      ).replyProviderMessageId({ replyToMessageId: 'other-message' }, claim(), {
        contactId: 'contact-a',
        conversationId: 'conversation-a',
      }),
    ).rejects.toThrow('whatsapp_reply_target_invalid');
  });

  it('reuses a persisted provider media ID without a second upload', async () => {
    const instance = service();
    const uploadMedia = vi.fn();
    (instance as never as { api: { uploadMedia: typeof uploadMedia } }).api = { uploadMedia };
    const claimed = claim() as {
      payload: {
        channelIdentityId: string;
        messageId: string;
        whatsAppMediaUploads?: Record<string, string>;
      };
    };
    claimed.payload = {
      ...claimed.payload,
      whatsAppMediaUploads: { 'asset-a': 'media.cached' },
    };
    const providerMediaId = await (
      instance as never as {
        providerMediaId(connection: unknown, asset: unknown, claimed: unknown): Promise<string>;
      }
    ).providerMediaId(
      {
        credentialsEncrypted: {},
        graphApiVersion: 'v23.0',
        id: 'connection-a',
        phoneNumberId: 'phone-a',
        projectId: 'project-a',
      },
      {
        bucketKey: 'asset-a',
        connectionId: null,
        declaredMimeType: 'image/jpeg',
        detectedMimeType: 'image/jpeg',
        id: 'asset-a',
        kind: 'PHOTO',
        originalFilename: 'photo.jpg',
        providerMediaId: null,
        source: 'CRM',
        status: 'AVAILABLE',
      },
      claimed,
    );
    expect(providerMediaId).toBe('media.cached');
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('marks an ambiguous media upload as UNKNOWN instead of uploading again', async () => {
    const instance = service();
    const unknown = vi.fn().mockResolvedValue(undefined);
    const internals = instance as never as {
      api: { uploadMedia: ReturnType<typeof vi.fn> };
      providerMediaId(connection: unknown, asset: unknown, claimed: unknown): Promise<string>;
      storage: { getObject(key: string): Promise<{ bytes: Uint8Array; contentType: string }> };
      unknown: typeof unknown;
    };
    internals.storage = {
      getObject: vi.fn().mockResolvedValue({
        bytes: new TextEncoder().encode('jpeg'),
        contentType: 'image/jpeg',
      }),
    };
    internals.api = { uploadMedia: vi.fn().mockRejectedValue(new WhatsAppApiError(500)) };
    internals.unknown = unknown;
    await expect(
      internals.providerMediaId(
        {
          credentialsEncrypted: {},
          graphApiVersion: 'v23.0',
          id: 'connection-a',
          phoneNumberId: 'phone-a',
          projectId: 'project-a',
        },
        {
          bucketKey: 'asset-a',
          connectionId: null,
          declaredMimeType: 'image/jpeg',
          detectedMimeType: 'image/jpeg',
          id: 'asset-a',
          kind: 'PHOTO',
          originalFilename: 'photo.jpg',
          providerMediaId: null,
          source: 'CRM',
          status: 'AVAILABLE',
        },
        claim(),
      ),
    ).rejects.toThrow('whatsapp_media_upload_unknown');
    expect(unknown).toHaveBeenCalledWith(claim(), 'message-a', 'whatsapp_media_upload_unknown');
  });
});

describe('WhatsApp CRM status intents', () => {
  it('persists a safe idempotent SENT intent for CRM-originated messages', async () => {
    const createOperation = vi.fn().mockResolvedValue({ id: 'operation-a' });
    const updateOutbox = vi.fn().mockResolvedValue({});
    const transaction = {
      crmOperation: { create: createOperation },
      crmProjectConfig: {
        findUnique: vi.fn().mockResolvedValue({ enabled: true, status: 'ACTIVE' }),
      },
      message: {
        findUnique: vi.fn().mockResolvedValue({
          connectionId: 'connection-a',
          contactId: 'contact-a',
          externalMessageId: 'wamid.accepted',
          metadata: { source: 'crm' },
        }),
      },
      outboxRecord: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ crmOperation: null, id: 'crm-outbox-a' }),
        update: updateOutbox,
      },
    };
    await (
      service() as never as {
        queueCrmMessageStatus(
          transaction: unknown,
          projectId: string,
          messageId: string,
          status: 'SENT',
          providerMessageId: string,
        ): Promise<void>;
      }
    ).queueCrmMessageStatus(transaction, 'project-a', 'message-a', 'SENT', 'wamid.accepted');
    expect(createOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          inputSafe: expect.objectContaining({
            messageId: 'message-a',
            providerMessageId: 'wamid.accepted',
            status: 'SENT',
          }),
          type: 'FORWARD_MESSAGE_STATUS',
        }),
      }),
    );
    expect(updateOutbox).toHaveBeenCalled();
  });
});
