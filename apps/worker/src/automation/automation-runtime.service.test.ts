import { describe, expect, it, vi } from 'vitest';

import { AutomationRuntimeService } from './automation-runtime.service';

describe('AutomationRuntimeService Wait for Reply criteria', () => {
  it('resolves only waits whose bounded criteria match the inbound event', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      normalizedEvent: {
        findUnique: vi.fn().mockResolvedValue({
          payload: { content: { text: 'Yes, continue' }, type: 'MESSAGE' },
        }),
      },
      waitState: {
        findMany: vi.fn().mockResolvedValue([
          {
            criteria: { caseSensitive: false, kind: 'TEXT', operator: 'contains', value: 'yes' },
            id: 'matching',
            projectId: 'project-a',
            scenarioExecutionId: 'execution-a',
            successNodeId: 'send-a',
          },
          {
            criteria: { kind: 'MEDIA', mediaTypes: ['PHOTO'] },
            id: 'not-matching',
            projectId: 'project-a',
            scenarioExecutionId: 'execution-b',
            successNodeId: 'send-b',
          },
        ]),
        updateMany,
      },
    };
    const service = new AutomationRuntimeService({} as never);
    const resumeExecutionInTransaction = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, { resumeExecutionInTransaction });

    const consumed = await service.resolveWaitsInTransaction(transaction as never, {
      connectionId: 'connection-a',
      contactId: 'contact-a',
      conversationId: 'conversation-a',
      normalizedEventId: 'event-a',
      projectId: 'project-a',
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'matching' }) }),
    );
    expect(resumeExecutionInTransaction).toHaveBeenCalledTimes(1);
    expect(consumed).toBe(true);
  });

  it('keeps typed custom-field projections synchronized with the contact JSON', async () => {
    const contactUpdate = vi.fn();
    const projectionUpsert = vi.fn();
    const service = new AutomationRuntimeService({} as never) as unknown as {
      applyNode(
        transaction: unknown,
        node: unknown,
        edges: unknown[],
        context: unknown,
        executionId: string,
      ): Promise<unknown>;
    };
    await service.applyNode(
      {
        contact: { update: contactUpdate },
        contactCustomFieldValue: { upsert: projectionUpsert },
        customFieldDefinition: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'field-a',
            key: 'score',
            options: null,
            type: 'NUMBER',
          }),
        },
      },
      { config: { key: 'score', value: 42 }, id: 'set-score', type: 'SET_CUSTOM_FIELD' },
      [],
      {
        connectionId: 'connection-a',
        contactId: 'contact-a',
        contactVariables: {},
        conversationId: 'conversation-a',
        customFields: {},
        eventPayload: { type: 'MESSAGE' },
        normalizedEventId: 'event-a',
        projectId: 'project-a',
        subflowDepth: 0,
      },
      'execution-a',
    );

    expect(contactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { customFields: { score: 42 } } }),
    );
    expect(projectionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ definitionId: 'field-a', valueJson: 42 }),
        where: {
          projectId_contactId_definitionId: {
            contactId: 'contact-a',
            definitionId: 'field-a',
            projectId: 'project-a',
          },
        },
      }),
    );
  });

  it('clears a custom-field value and its typed projection in one transaction', async () => {
    const contactUpdate = vi.fn();
    const projectionDelete = vi.fn();
    const context = {
      connectionId: 'connection-a',
      contactId: 'contact-a',
      contactVariables: {},
      conversationId: 'conversation-a',
      customFields: { keep: 'yes', score: 42 },
      eventPayload: { type: 'MESSAGE' },
      normalizedEventId: 'event-a',
      projectId: 'project-a',
      subflowDepth: 0,
    };
    const service = new AutomationRuntimeService({} as never) as unknown as {
      applyNode(
        transaction: unknown,
        node: unknown,
        edges: unknown[],
        runtimeContext: typeof context,
        executionId: string,
      ): Promise<unknown>;
    };

    await service.applyNode(
      {
        contact: { update: contactUpdate },
        contactCustomFieldValue: { deleteMany: projectionDelete },
        customFieldDefinition: {
          findFirst: vi.fn().mockResolvedValue({ id: 'field-a', key: 'score' }),
        },
      },
      { config: { key: 'score' }, id: 'clear-score', type: 'CLEAR_CUSTOM_FIELD' },
      [],
      context,
      'execution-a',
    );

    expect(contactUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { customFields: { keep: 'yes' } } }),
    );
    expect(projectionDelete).toHaveBeenCalledWith({
      where: { contactId: 'contact-a', definitionId: 'field-a', projectId: 'project-a' },
    });
    expect(context.customFields).toEqual({ keep: 'yes' });
  });

  it('selects an AND branch deterministically and exposes a safe branch reason', async () => {
    const service = new AutomationRuntimeService({} as never) as unknown as {
      applyNode(
        transaction: unknown,
        node: unknown,
        edges: unknown[],
        context: unknown,
        executionId: string,
      ): Promise<{ next?: { output: string }; reasonCode?: string }>;
    };

    const result = await service.applyNode(
      {},
      { config: {}, id: 'condition', type: 'CONDITION' },
      [
        {
          conditionGroup: {
            combinator: 'AND',
            rules: [
              { field: 'message.text', operator: 'contains', value: 'yes' },
              { field: 'contact.customFields.score', operator: 'greater_than', value: 5 },
            ],
          },
          from: 'condition',
          output: 'qualified',
          priority: 0,
          to: 'send',
        },
        { from: 'condition', output: 'fallback', priority: 1, to: 'stop' },
      ],
      {
        connectionId: 'connection-a',
        contactId: 'contact-a',
        contactVariables: {},
        conversationId: 'conversation-a',
        customFields: { score: 9 },
        eventPayload: { content: { text: 'yes please' }, type: 'MESSAGE' },
        normalizedEventId: 'event-a',
        projectId: 'project-a',
        subflowDepth: 0,
      },
      'execution-a',
    );

    expect(result).toMatchObject({
      next: { output: 'qualified' },
      reasonCode: 'CONDITION_MATCHED',
    });
  });

  it('queues one durable idempotent HTTP operation and suspends the execution', async () => {
    const outboxCreate = vi.fn().mockResolvedValue({ id: 'outbox-a' });
    const operationCreate = vi.fn().mockResolvedValue({ id: 'operation-a' });
    const outboxUpdate = vi.fn();
    const executionUpdate = vi.fn();
    const service = new AutomationRuntimeService({} as never) as unknown as {
      applyNode(
        transaction: unknown,
        node: unknown,
        edges: unknown[],
        context: unknown,
        executionId: string,
      ): Promise<unknown>;
    };

    await expect(
      service.applyNode(
        {
          externalHttpOperation: { create: operationCreate },
          outboxRecord: {
            create: outboxCreate,
            findUnique: vi.fn().mockResolvedValue(null),
            update: outboxUpdate,
          },
          scenarioExecution: { update: executionUpdate },
        },
        {
          config: {
            headers: [],
            mappings: [],
            maxAttempts: 3,
            method: 'POST',
            query: [],
            timeoutMs: 5_000,
            url: 'https://example.test/hook',
          },
          id: 'http-a',
          type: 'EXTERNAL_HTTP_REQUEST',
        },
        [
          { from: 'http-a', output: 'success', to: 'success-a' },
          { from: 'http-a', output: 'failure', to: 'failure-a' },
        ],
        {
          connectionId: 'connection-a',
          contactId: 'contact-a',
          contactVariables: {},
          conversationId: 'conversation-a',
          customFields: {},
          eventPayload: { type: 'MESSAGE' },
          normalizedEventId: 'event-a',
          projectId: 'project-a',
          subflowDepth: 0,
          variables: {},
        },
        'execution-a',
      ),
    ).resolves.toEqual({ suspended: true });

    expect(outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: 'http-execution-a-http-a',
        kind: 'HTTP',
        maxAttempts: 3,
        projectId: 'project-a',
      }),
    });
    expect(operationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        failureNodeId: 'failure-a',
        successNodeId: 'success-a',
      }),
    });
    expect(outboxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { payload: { externalHttpOperationId: 'operation-a' } } }),
    );
    expect(executionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentNodeId: 'http-a', status: 'WAITING' } }),
    );
  });

  it('does not queue a second inbound CRM delivery from a legacy forward node', async () => {
    const outboxFindUnique = vi.fn();
    const service = new AutomationRuntimeService({} as never) as unknown as {
      queueCrmOperation(
        transaction: unknown,
        node: unknown,
        context: unknown,
        executionId: string,
      ): Promise<void>;
    };

    await service.queueCrmOperation(
      {
        crmOperation: {
          findFirst: vi.fn().mockResolvedValue({ id: 'automatic-inbound-operation' }),
        },
        outboxRecord: { findUnique: outboxFindUnique },
      },
      { config: {}, id: 'forward-a', type: 'FORWARD_TO_CRM' },
      {
        contactId: 'contact-a',
        normalizedEventId: 'event-a',
        projectId: 'project-a',
      },
      'execution-a',
    );

    expect(outboxFindUnique).not.toHaveBeenCalled();
  });

  it('returns safe Telegram delivery references when a message is queued', async () => {
    const service = new AutomationRuntimeService({} as never) as unknown as {
      applyNode(
        transaction: unknown,
        node: unknown,
        edges: unknown[],
        context: unknown,
        executionId: string,
      ): Promise<unknown>;
    };

    await expect(
      service.applyNode(
        {
          channelConnection: {
            findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', type: 'TELEGRAM' }),
          },
          channelIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity-a' }) },
          message: { create: vi.fn().mockResolvedValue({ id: 'message-a' }) },
          outboxRecord: {
            create: vi.fn().mockResolvedValue({ id: 'outbox-a' }),
            findUnique: vi.fn().mockResolvedValue(null),
          },
        },
        { config: { text: 'Hello {{contact.firstName}}' }, id: 'send-a', type: 'SEND_MESSAGE' },
        [{ from: 'send-a', to: 'stop-a' }],
        {
          connectionId: 'connection-a',
          contactId: 'contact-a',
          contactVariables: { firstName: 'Alex' },
          conversationId: 'conversation-a',
          customFields: {},
          eventPayload: { type: 'MESSAGE' },
          normalizedEventId: 'event-a',
          projectId: 'project-a',
          subflowDepth: 0,
          variables: {},
        },
        'execution-a',
      ),
    ).resolves.toEqual({
      next: { from: 'send-a', to: 'stop-a' },
      operationSafe: {
        deliveryStatus: 'QUEUED',
        messageId: 'message-a',
        outboxRecordId: 'outbox-a',
      },
    });
  });

  it('fails a send-message step when no active Telegram identity exists', async () => {
    const service = new AutomationRuntimeService({} as never) as unknown as {
      applyNode(
        transaction: unknown,
        node: unknown,
        edges: unknown[],
        context: unknown,
        executionId: string,
      ): Promise<unknown>;
    };

    await expect(
      service.applyNode(
        {
          channelConnection: {
            findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', type: 'TELEGRAM' }),
          },
          channelIdentity: { findFirst: vi.fn().mockResolvedValue(null) },
        },
        { config: { text: 'Hello' }, id: 'send-a', type: 'SEND_MESSAGE' },
        [],
        {
          connectionId: 'connection-a',
          contactId: 'contact-a',
          contactVariables: {},
          conversationId: 'conversation-a',
          customFields: {},
          eventPayload: { type: 'MESSAGE' },
          normalizedEventId: 'event-a',
          projectId: 'project-a',
          subflowDepth: 0,
          variables: {},
        },
        'execution-a',
      ),
    ).rejects.toThrow('automation_channel_identity_unavailable');
  });

  it('queues WhatsApp freeform text only inside the persisted service window', async () => {
    const outboxCreate = vi.fn().mockResolvedValue({ id: 'outbox-wa' });
    const messageCreate = vi.fn().mockResolvedValue({ id: 'message-wa' });
    const service = new AutomationRuntimeService({} as never) as unknown as {
      applyNode(
        transaction: unknown,
        node: unknown,
        edges: unknown[],
        context: unknown,
        executionId: string,
      ): Promise<unknown>;
    };

    await service.applyNode(
      {
        channelConnection: {
          findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', type: 'WHATSAPP' }),
        },
        channelIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity-wa' }) },
        conversation: {
          findUnique: vi.fn().mockResolvedValue({
            serviceWindowExpiresAt: new Date(Date.now() + 60_000),
          }),
        },
        message: { create: messageCreate },
        outboxRecord: {
          create: outboxCreate,
          findUnique: vi.fn().mockResolvedValue(null),
        },
      },
      { config: { text: 'Hello {{contact.firstName}}' }, id: 'send-wa', type: 'SEND_MESSAGE' },
      [],
      {
        connectionId: 'connection-wa',
        contactId: 'contact-a',
        contactVariables: { firstName: 'Alex' },
        conversationId: 'conversation-a',
        customFields: {},
        eventPayload: { type: 'MESSAGE' },
        normalizedEventId: 'event-a',
        projectId: 'project-a',
        subflowDepth: 0,
        variables: {},
      },
      'execution-a',
    );

    expect(outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'WHATSAPP' }),
    });
    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ content: { text: 'Hello Alex' } }),
    });
  });

  it('rejects WhatsApp freeform automation when the service window is closed', async () => {
    const service = new AutomationRuntimeService({} as never) as unknown as {
      queueMessage(
        transaction: unknown,
        node: unknown,
        context: unknown,
        executionId: string,
      ): Promise<unknown>;
    };
    await expect(
      service.queueMessage(
        {
          channelConnection: {
            findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', type: 'WHATSAPP' }),
          },
          channelIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity-wa' }) },
          conversation: {
            findUnique: vi.fn().mockResolvedValue({ serviceWindowExpiresAt: new Date(0) }),
          },
        },
        { config: { text: 'Hello' }, id: 'send-wa', type: 'SEND_MESSAGE' },
        {
          connectionId: 'connection-wa',
          contactId: 'contact-a',
          contactVariables: {},
          conversationId: 'conversation-a',
          eventPayload: {},
          projectId: 'project-a',
          variables: {},
        },
        'execution-a',
      ),
    ).rejects.toThrow('automation_whatsapp_service_window_closed');
  });

  it('resolves a portable WhatsApp template against the active connection', async () => {
    const messageCreate = vi.fn().mockResolvedValue({ id: 'message-wa' });
    const outboxCreate = vi.fn().mockResolvedValue({ id: 'outbox-wa' });
    const service = new AutomationRuntimeService({} as never) as unknown as {
      queueMessage(
        transaction: unknown,
        node: unknown,
        context: unknown,
        executionId: string,
      ): Promise<unknown>;
    };
    await service.queueMessage(
      {
        channelConnection: {
          findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', type: 'WHATSAPP' }),
        },
        channelIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity-wa' }) },
        message: { create: messageCreate },
        outboxRecord: {
          create: outboxCreate,
          findUnique: vi.fn().mockResolvedValue(null),
        },
        whatsAppMessageTemplate: {
          findUnique: vi.fn().mockResolvedValue({
            languageCode: 'en_US',
            name: 'welcome',
            status: 'APPROVED',
            components: [{ text: 'Hello {{1}}', type: 'BODY' }],
          }),
        },
      },
      {
        config: {
          whatsAppTemplate: {
            components: [
              { parameters: [{ text: '{{contact.firstName}}', type: 'text' }], type: 'body' },
            ],
            languageCode: 'en_US',
            name: 'welcome',
          },
        },
        id: 'template-wa',
        type: 'SEND_TEMPLATE',
      },
      {
        connectionId: 'connection-wa',
        contactId: 'contact-a',
        contactVariables: { firstName: 'Alex' },
        conversationId: 'conversation-a',
        eventPayload: {},
        projectId: 'project-a',
        variables: {},
      },
      'execution-a',
    );
    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: {
          whatsAppTemplate: {
            components: [{ parameters: [{ text: 'Alex', type: 'text' }], type: 'body' }],
            languageCode: 'en_US',
            name: 'welcome',
          },
        },
      }),
    });
    expect(outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'WHATSAPP' }),
    });
  });

  it('persists a media delivery failure instead of rolling back the inbound transaction', async () => {
    const nodeExecutionUpsert = vi.fn().mockResolvedValue({});
    const scenarioExecutionUpdate = vi.fn().mockResolvedValue({});
    const service = new AutomationRuntimeService({} as never) as unknown as {
      executeGraph(
        transaction: unknown,
        graph: unknown,
        executionId: string,
        context: unknown,
      ): Promise<void>;
    };
    Object.assign(service, {
      applyNode: vi.fn().mockRejectedValue(new Error('automation_telegram_media_group_kind_invalid')),
    });

    await service.executeGraph(
      {
        nodeExecution: { upsert: nodeExecutionUpsert },
        scenarioExecution: { update: scenarioExecutionUpdate },
      },
      {
        edges: [],
        nodes: [{ config: {}, id: 'trigger-a', type: 'INCOMING_MESSAGE' }],
      },
      'execution-a',
      {
        connectionId: '',
        contactId: 'contact-a',
        contactVariables: {},
        conversationId: '',
        customFields: {},
        eventPayload: { type: 'LEAD_CAPTURED' },
        normalizedEventId: '',
        projectId: 'project-a',
        subflowDepth: 0,
        variables: {},
      },
    );

    expect(nodeExecutionUpsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          outputSafe: { reasonCode: 'automation_telegram_media_group_kind_invalid' },
          status: 'FAILED',
        }),
      }),
    );
    expect(scenarioExecutionUpdate).toHaveBeenLastCalledWith({
      data: { completedAt: expect.any(Date), currentNodeId: null, status: 'FAILED' },
      where: { projectId_id: { id: 'execution-a', projectId: 'project-a' } },
    });
  });
});
