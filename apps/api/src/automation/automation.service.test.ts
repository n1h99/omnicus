import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AutomationService } from './automation.service';

describe('AutomationService lifecycle', () => {
  it('validates clear custom field references inside the active project', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new AutomationService(
      { sender: vi.fn(), assertMailbox: vi.fn() } as never,
      { record: vi.fn() } as never,
      { client: { customFieldDefinition: { findMany } } } as never,
    ) as unknown as {
      assertReferencedResources(projectId: string, graph: unknown): Promise<void>;
    };

    await expect(
      service.assertReferencedResources('project-a', {
        edges: [
          { from: 'incoming', to: 'clear' },
          { from: 'clear', to: 'stop' },
        ],
        nodes: [
          { id: 'incoming', type: 'INCOMING_MESSAGE' },
          { config: { key: 'score' }, id: 'clear', type: 'CLEAR_CUSTOM_FIELD' },
          { id: 'stop', type: 'STOP' },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: 'SCENARIO_CUSTOM_FIELD_INVALID' } });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: 'project-a' }) }),
    );
  });

  it('archives a scenario and records a safe audit event', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      activeVersion: null,
      draftVersion: null,
      id: 'scenario-a',
      versions: [],
    });
    const update = vi.fn().mockResolvedValue({ id: 'scenario-a', status: 'ARCHIVED' });
    const audit = { record: vi.fn() };
    const service = new AutomationService(
      { sender: vi.fn(), assertMailbox: vi.fn() } as never,
      audit as never,
      {
        client: { scenario: { findUnique, update } },
      } as never,
    );

    await expect(
      service.archive(
        'project-a',
        'scenario-a',
        {
          email: 'admin@example.test',
          globalPermissions: [],
          globalRoleNames: [],
          userId: 'user-a',
        },
        { correlationId: 'correlation-a' },
      ),
    ).resolves.toMatchObject({ status: 'ARCHIVED' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'ARCHIVED' } }));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scenario.archived', projectId: 'project-a' }),
    );
  });

  it('rejects a published graph that references a tag outside the active project scope', async () => {
    const graph = {
      edges: [
        { from: 'incoming', to: 'tag' },
        { from: 'tag', to: 'stop' },
      ],
      nodes: [
        { config: {}, id: 'incoming', type: 'INCOMING_MESSAGE' },
        { config: { tagId: 'foreign-tag' }, id: 'tag', type: 'ADD_TAG' },
        { config: {}, id: 'stop', type: 'STOP' },
      ],
    };
    const service = new AutomationService(
      { sender: vi.fn(), assertMailbox: vi.fn() } as never,
      { record: vi.fn() } as never,
      {
        client: {
          scenario: {
            findUnique: vi.fn().mockResolvedValue({
              activeVersionId: null,
              activeVersion: null,
              draftVersion: { graph, id: 'draft-a' },
              versions: [],
            }),
          },
          tag: { findMany: vi.fn().mockResolvedValue([]) },
        },
      } as never,
    );

    const publishing = service.publish(
      'project-a',
      'scenario-a',
      {
        email: 'admin@example.test',
        globalPermissions: [],
        globalRoleNames: [],
        userId: 'user-a',
      },
      { correlationId: 'correlation-a' },
    );

    await expect(publishing).rejects.toBeInstanceOf(BadRequestException);
    await expect(publishing).rejects.toMatchObject({ response: { code: 'SCENARIO_TAG_INVALID' } });
  });

  it('runs a side-effect-free graph simulation without requiring a persisted scenario', async () => {
    const service = new AutomationService(
      { sender: vi.fn(), assertMailbox: vi.fn() } as never,
      { record: vi.fn() } as never,
      { client: {} } as never,
    );

    await expect(
      service.testRun('project-a', {
        event: { content: { text: 'hello' }, type: 'MESSAGE' },
        graph: {
          edges: [{ from: 'incoming', to: 'stop' }],
          nodes: [
            { id: 'incoming', type: 'INCOMING_MESSAGE' },
            { id: 'stop', type: 'STOP' },
          ],
        },
      }),
    ).resolves.toMatchObject({
      completed: true,
      steps: [{ nodeId: 'incoming' }, { nodeId: 'stop' }],
    });
  });

  it('persists a structurally valid incomplete draft while retaining publish errors', async () => {
    const graph = {
      edges: [],
      nodes: [
        { id: 'incoming', type: 'INCOMING_MESSAGE' },
        { id: 'stop', type: 'STOP' },
      ],
    };
    const scenarioVersionUpdate = vi.fn();
    const transaction = {
      scenario: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'scenario-a', updatedAt: new Date() }),
        update: vi.fn(),
      },
      scenarioVersion: { update: scenarioVersionUpdate },
    };
    const audit = { record: vi.fn() };
    const service = new AutomationService(
      { sender: vi.fn(), assertMailbox: vi.fn() } as never,
      audit as never,
      {
        client: {
          $transaction: vi.fn((callback) => callback(transaction)),
          scenario: {
            findUnique: vi.fn().mockResolvedValue({
              activeVersion: null,
              draftVersion: { graph, id: 'draft-a' },
              draftVersionId: 'draft-a',
              id: 'scenario-a',
              versions: [],
            }),
          },
        },
      } as never,
    );

    await expect(
      service.update(
        'project-a',
        'scenario-a',
        { graph },
        {
          email: 'admin@example.test',
          globalPermissions: [],
          globalRoleNames: [],
          userId: 'user-a',
        },
        { correlationId: 'correlation-a' },
      ),
    ).resolves.toMatchObject({ id: 'scenario-a' });
    expect(scenarioVersionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          validation: expect.objectContaining({
            errors: expect.arrayContaining(['Incoming Message trigger must have an outgoing path']),
          }),
        }),
      }),
    );
  });

  it('rejects a stale draft update instead of overwriting a concurrent editor', async () => {
    const graph = {
      edges: [{ from: 'incoming', to: 'stop' }],
      nodes: [
        { id: 'incoming', type: 'INCOMING_MESSAGE' },
        { id: 'stop', type: 'STOP' },
      ],
    };
    const transaction = {
      scenario: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      scenarioVersion: { update: vi.fn() },
    };
    const service = new AutomationService(
      { sender: vi.fn(), assertMailbox: vi.fn() } as never,
      { record: vi.fn() } as never,
      {
        client: {
          $transaction: vi.fn((callback) => callback(transaction)),
          scenario: {
            findUnique: vi.fn().mockResolvedValue({
              activeVersion: null,
              draftVersion: { graph, id: 'draft-a' },
              draftVersionId: 'draft-a',
              id: 'scenario-a',
              versions: [],
            }),
          },
        },
      } as never,
    );

    await expect(
      service.update(
        'project-a',
        'scenario-a',
        { expectedUpdatedAt: '2026-08-02T10:00:00.000Z', graph },
        {
          email: 'admin@example.test',
          globalPermissions: [],
          globalRoleNames: [],
          userId: 'user-a',
        },
        { correlationId: 'correlation-a' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('enriches send steps with current Telegram delivery status', async () => {
    const service = new AutomationService(
      { sender: vi.fn(), assertMailbox: vi.fn() } as never,
      { record: vi.fn() } as never,
      {
        client: {
          message: {
            findMany: vi.fn().mockResolvedValue([{ id: 'message-a', status: 'SENT' }]),
          },
          outboxRecord: {
            findMany: vi.fn().mockResolvedValue([{ id: 'outbox-a', status: 'SUCCEEDED' }]),
          },
          scenario: {
            findUnique: vi.fn().mockResolvedValue({
              activeVersion: null,
              draftVersion: null,
              id: 'scenario-a',
              versions: [],
            }),
          },
          scenarioExecution: {
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'execution-a',
                nodeExecutions: [
                  {
                    nodeId: 'send-a',
                    outputSafe: { messageId: 'message-a', outboxRecordId: 'outbox-a' },
                  },
                ],
              },
            ]),
          },
        },
      } as never,
    );

    await expect(service.executions('project-a', 'scenario-a')).resolves.toEqual([
      {
        id: 'execution-a',
        nodeExecutions: [
          {
            delivery: {
              messageId: 'message-a',
              messageStatus: 'SENT',
              outboxRecordId: 'outbox-a',
              outboxStatus: 'SUCCEEDED',
            },
            nodeId: 'send-a',
            outputSafe: { messageId: 'message-a', outboxRecordId: 'outbox-a' },
          },
        ],
      },
    ]);
  });
});
