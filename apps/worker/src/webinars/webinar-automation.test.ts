import { describe, expect, it, vi } from 'vitest';
import { AutomationRuntimeService } from '../automation/automation-runtime.service';

describe('Webinar automation dispatch', () => {
  it('selects the event/session trigger, fences completion and does not dispatch a completed action again', async () => {
    const action = {
      id: 'action',
      projectId: 'project',
      contactId: 'contact',
      eventType: 'WEBINAR_ATTENDED',
      state: 'PROCESSING',
      payload: { type: 'WEBINAR_ATTENDED', webinar: { eventId: 'session' }, watchedMinutes: 4 },
    };
    const graph = (session: string) => ({
      edges: [],
      nodes: [
        {
          id: 'trigger',
          type: 'INCOMING_MESSAGE',
          config: {
            triggerType: 'WEBINAR_EVENT',
            webinarEventType: 'WEBINAR_ATTENDED',
            webinarEventId: session,
          },
        },
      ],
    });
    const tx = {
      webinarAction: {
        findFirst: vi.fn(async () => (action.state === 'PROCESSING' ? action : null)),
        updateMany: vi.fn(async ({ data }: { data: { state?: string } }) => {
          if (data.state) action.state = data.state;
          return { count: 1 };
        }),
      },
      contact: {
        findUnique: vi.fn(async () => ({
          id: 'contact',
          status: 'ACTIVE',
          automationMode: 'ENABLED',
          displayName: 'Viewer',
          customFields: {},
        })),
      },
      scenario: {
        findMany: vi.fn(async () => [
          { id: 'matching', activeVersion: { id: 'v1', compiledDefinition: graph('session') } },
          { id: 'other', activeVersion: { id: 'v2', compiledDefinition: graph('another') } },
        ]),
      },
      scenarioExecution: { upsert: vi.fn(async () => ({ id: 'execution', status: 'RUNNING' })) },
    };
    const service = new AutomationRuntimeService({
      client: { $transaction: (run: (value: typeof tx) => Promise<void>) => run(tx) },
    } as never);
    const execute = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, { executeGraph: execute });
    await service.triggerWebinar('action', 'owner');
    await service.triggerWebinar('action', 'owner');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(tx.scenarioExecution.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          scenarioId: 'matching',
          triggerKey: 'webinar:action',
          triggerPayload: action.payload,
        }),
      }),
    );
    expect(action.state).toBe('SUCCEEDED');
  });
  it('queues a stable CRM command with the report version and rejects invocation outside a report', async () => {
    const service = new AutomationRuntimeService({} as never) as unknown as {
      applyNode(
        tx: unknown,
        node: unknown,
        edges: unknown[],
        context: unknown,
        executionId: string,
      ): Promise<unknown>;
    };
    const createMany = vi.fn(),
      node = {
        id: 'task',
        type: 'WEBINAR_CRM_ACTION',
        config: {
          command: 'CREATE_TASK',
          title: 'Call {{contact.displayName}}',
          description: 'Webinar follow-up',
          dueMinutes: 30,
        },
      };
    const context = {
      projectId: 'project',
      contactId: 'contact',
      contactVariables: { displayName: 'Viewer' },
      variables: {},
      eventPayload: { attendanceId: 'attendance', version: 3, status: 'ATTENDED' },
    };
    await service.applyNode({ webinarAction: { createMany } }, node, [], context, 'execution');
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [
          expect.objectContaining({
            dedupeKey: 'scenario:execution:task',
            payload: expect.objectContaining({
              attendanceId: 'attendance',
              version: 3,
              command: {
                type: 'CREATE_TASK',
                title: 'Call Viewer',
                description: 'Webinar follow-up',
                dueMinutes: 30,
              },
            }),
          }),
        ],
      }),
    );
    await expect(
      service.applyNode(
        { webinarAction: { createMany } },
        node,
        [],
        { ...context, eventPayload: {} },
        'execution',
      ),
    ).rejects.toThrow('webinar_report_context_required');
    expect(createMany).toHaveBeenCalledTimes(1);
  });
});
