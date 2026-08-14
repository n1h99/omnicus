import { describe, expect, it, vi } from 'vitest';

import { AutomationActivityService } from './automation-activity.service';

describe('AutomationActivityService', () => {
  it('returns a bounded human-readable project activity projection', async () => {
    const createdAt = new Date('2026-08-03T08:00:00.000Z');
    const scenarioExecution = {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi
        .fn()
        .mockResolvedValueOnce([
          {
            cancellationRequestedAt: null,
            completedAt: null,
            contact: {
              displayName: 'Ada',
              email: 'ada@example.test',
              firstName: null,
              id: 'contact-a',
              lastName: null,
              phone: null,
              username: null,
            },
            createdAt,
            currentNodeId: 'http-a',
            delayedActions: [],
            errorSafe: { code: 'external_http_unknown_requires_review', secret: 'hidden' },
            failedAt: null,
            id: 'execution-a',
            nodeExecutions: [
              {
                completedAt: createdAt,
                errorSafe: { code: 'external_http_unknown_requires_review' },
                nodeId: 'http-a',
                nodeType: 'EXTERNAL_HTTP_REQUEST',
                startedAt: createdAt,
                status: 'FAILED',
              },
            ],
            scenario: { id: 'scenario-a', name: 'Welcome journey' },
            scenarioVersion: { version: 3 },
            startedAt: createdAt,
            status: 'PAUSED',
            updatedAt: createdAt,
            waitStates: [],
          },
        ])
        .mockResolvedValueOnce([
          {
            cancellationRequestedAt: null,
            createdAt,
            errorSafe: { code: 'external_http_unknown_requires_review' },
            status: 'PAUSED',
          },
        ]),
      groupBy: vi
        .fn()
        .mockResolvedValueOnce([{ _count: { _all: 1 }, status: 'PAUSED' }])
        .mockResolvedValueOnce([
          { _count: { _all: 1 }, scenarioId: 'scenario-a', status: 'PAUSED' },
        ]),
    };
    const service = new AutomationActivityService({
      client: {
        scenario: {
          findMany: vi.fn().mockResolvedValue([{ id: 'scenario-a', name: 'Welcome journey' }]),
        },
        scenarioExecution,
        trackedLink: { findMany: vi.fn().mockResolvedValue([]) },
      },
    } as never);

    const result = await service.list('project-a', {
      page: 1,
      pageSize: 25,
      periodDays: 30,
    });

    expect(result.summary).toEqual({ active: 0, completed: 0, problems: 0, total: 1, waiting: 1 });
    expect(result.items[0]).toMatchObject({
      contact: { displayName: 'Ada', id: 'contact-a' },
      currentStep: { label: 'Contact an external service' },
      reason: 'The external service result is uncertain and needs a safe review.',
      scenario: { name: 'Welcome journey', version: 3 },
      statusLabel: 'Paused for review',
    });
    expect(JSON.stringify(result)).not.toContain('hidden');
    expect(scenarioExecution.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        skip: 0,
        take: 25,
        where: expect.objectContaining({ projectId: 'project-a' }),
      }),
    );
  });
});
