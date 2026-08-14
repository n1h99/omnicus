import { describe, expect, it } from 'vitest';

import {
  automationValueFor,
  evaluateCondition,
  evaluateConditionGroup,
  matchesWaitForReplyCriteria,
  simulateScenarioGraph,
  validateScenarioGraph,
} from './index';

describe('automation graph validation', () => {
  it('requires deterministic condition branch priorities', () => {
    const result = validateScenarioGraph({
      edges: [
        { from: 'trigger', to: 'condition' },
        { from: 'condition', output: 'true', priority: 0, to: 'stop-a' },
        { from: 'condition', output: 'false', priority: 0, to: 'stop-b' },
      ],
      nodes: [
        { id: 'trigger', type: 'INCOMING_MESSAGE' },
        { id: 'condition', type: 'CONDITION' },
        { id: 'stop-a', type: 'STOP' },
        { id: 'stop-b', type: 'STOP' },
      ],
    });
    expect(result.errors).toContain('Condition node condition has duplicate branch priorities');
  });

  it('does not coerce null or strings to numbers', () => {
    expect(evaluateCondition('greater_than', null, 1)).toBe(false);
    expect(evaluateCondition('greater_than', '2', 1)).toBe(false);
    expect(evaluateCondition('greater_than', 2, 1)).toBe(true);
    expect(evaluateCondition('contains', ['vip', 'active'], 'vip')).toBe(true);
  });

  it('accepts a cycle guarded by a durable delay', () => {
    const result = validateScenarioGraph({
      edges: [
        { from: 'trigger', to: 'delay' },
        { from: 'delay', to: 'condition' },
        { from: 'condition', output: 'default', priority: 0, to: 'delay' },
      ],
      nodes: [
        { id: 'trigger', type: 'INCOMING_MESSAGE' },
        { config: { delaySeconds: 5 }, id: 'delay', type: 'DELAY' },
        { id: 'condition', type: 'CONDITION' },
      ],
    });
    expect(result.errors).not.toContain('Graph contains an unguarded cycle');
  });

  it('rejects a delay without an explicit positive duration', () => {
    const result = validateScenarioGraph({
      edges: [{ from: 'trigger', to: 'delay' }],
      nodes: [
        { id: 'trigger', type: 'INCOMING_MESSAGE' },
        { id: 'delay', type: 'DELAY' },
      ],
    });
    expect(result.errors).toContain('Delay node delay requires a positive integer delaySeconds');
  });

  it('requires pinned versions for templates and subflows', () => {
    const result = validateScenarioGraph({
      edges: [
        { from: 'trigger', to: 'template' },
        { from: 'template', to: 'subflow' },
      ],
      nodes: [
        { id: 'trigger', type: 'INCOMING_MESSAGE' },
        { config: { templateId: 'template-a' }, id: 'template', type: 'SEND_TEMPLATE' },
        { config: { scenarioId: 'scenario-a' }, id: 'subflow', type: 'START_SUBFLOW' },
      ],
    });

    expect(result.errors).toContain(
      'Send Template node template requires a pinned template version or a WhatsApp template',
    );
    expect(result.errors).toContain(
      'Subflow node subflow requires a pinned published scenario version',
    );
  });

  it('accepts a portable WhatsApp template without pinning it to one connection', () => {
    const result = validateScenarioGraph({
      edges: [
        { from: 'trigger', to: 'template' },
        { from: 'template', to: 'stop' },
      ],
      nodes: [
        { id: 'trigger', type: 'INCOMING_MESSAGE' },
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
          id: 'template',
          type: 'SEND_TEMPLATE',
        },
        { id: 'stop', type: 'STOP' },
      ],
    });
    expect(result.errors).toEqual([]);
  });

  it('rejects loose or provider-invalid WhatsApp template parameter shapes', () => {
    const validateTemplate = (whatsAppTemplate: unknown) =>
      validateScenarioGraph({
        edges: [
          { from: 'trigger', to: 'template' },
          { from: 'template', to: 'stop' },
        ],
        nodes: [
          { id: 'trigger', type: 'INCOMING_MESSAGE' },
          { config: { whatsAppTemplate }, id: 'template', type: 'SEND_TEMPLATE' },
          { id: 'stop', type: 'STOP' },
        ],
      });
    const invalidTemplates = [
      {
        components: [
          {
            index: 0,
            parameters: [],
            subType: 'quick_reply',
            type: 'button',
          },
        ],
        languageCode: 'en_US',
        name: 'quick_reply',
      },
      {
        components: [
          {
            index: 0,
            parameters: [{ text: 'wrong', type: 'text' }],
            subType: 'quick_reply',
            type: 'button',
          },
        ],
        languageCode: 'en_US',
        name: 'quick_reply',
      },
      {
        components: [
          {
            parameters: [{ amount1000: 1_000, code: 'US', fallbackValue: '$1', type: 'currency' }],
            type: 'body',
          },
        ],
        languageCode: 'en_US',
        name: 'currency',
      },
      { extra: true, languageCode: 'en_US', name: 'loose' },
    ];
    for (const template of invalidTemplates)
      expect(validateTemplate(template).errors).toContain(
        'Send Template node template requires a pinned template version or a WhatsApp template',
      );
  });

  it('rejects a send-message step without message content', () => {
    const result = validateScenarioGraph({
      edges: [
        { from: 'trigger', to: 'send' },
        { from: 'send', to: 'stop' },
      ],
      nodes: [
        { id: 'trigger', type: 'INCOMING_MESSAGE' },
        { config: { text: '   ' }, id: 'send', type: 'SEND_MESSAGE' },
        { id: 'stop', type: 'STOP' },
      ],
    });

    expect(result.errors).toContain('Send Message node send requires message text');
  });

  it('blocks unreachable nodes and requires a field for clear custom field', () => {
    const result = validateScenarioGraph({
      edges: [{ from: 'trigger', to: 'stop' }],
      nodes: [
        { id: 'trigger', type: 'INCOMING_MESSAGE' },
        { id: 'stop', type: 'STOP' },
        { config: {}, id: 'clear', type: 'CLEAR_CUSTOM_FIELD' },
      ],
    });

    expect(result.errors).toContain('Node clear is unreachable');
    expect(result.errors).toContain('Clear Custom Field node clear requires a custom field');
    expect(result.warnings).toEqual([]);
  });

  it('validates bounded Wait for Reply criteria while keeping legacy empty criteria compatible', () => {
    const valid = validateScenarioGraph({
      edges: [
        { from: 'trigger', to: 'wait' },
        { from: 'wait', output: 'reply', to: 'stop' },
      ],
      nodes: [
        { id: 'trigger', type: 'INCOMING_MESSAGE' },
        { config: { criteria: {}, timeoutSeconds: 60 }, id: 'wait', type: 'WAIT_FOR_REPLY' },
        { id: 'stop', type: 'STOP' },
      ],
    });
    const invalid = validateScenarioGraph({
      edges: [{ from: 'trigger', to: 'wait' }],
      nodes: [
        { id: 'trigger', type: 'INCOMING_MESSAGE' },
        {
          config: {
            criteria: { kind: 'TEXT', operator: 'contains', value: '' },
            timeoutSeconds: 60,
          },
          id: 'wait',
          type: 'WAIT_FOR_REPLY',
        },
      ],
    });

    expect(valid.errors).not.toContain('Wait for Reply node wait has invalid reply criteria');
    expect(invalid.errors).toContain('Wait for Reply node wait has invalid reply criteria');
  });

  it('requires a bounded external HTTP config and explicit outcome paths', () => {
    const graph = {
      edges: [
        { from: 'trigger', to: 'http' },
        { from: 'http', output: 'success', to: 'stop' },
      ],
      nodes: [
        { id: 'trigger', type: 'INCOMING_MESSAGE' },
        {
          config: { method: 'POST', timeoutMs: 10_000, url: 'https://example.test/hooks' },
          id: 'http',
          type: 'EXTERNAL_HTTP_REQUEST',
        },
        { id: 'stop', type: 'STOP' },
      ],
    };

    expect(validateScenarioGraph(graph).errors).toContain(
      'External HTTP node http requires exactly one success and one failure path',
    );
    expect(
      validateScenarioGraph({
        ...graph,
        edges: [...graph.edges, { from: 'http', output: 'failure', to: 'stop' }],
      }).errors,
    ).toEqual([]);
  });
});

describe('Wait for Reply criteria', () => {
  it('matches text without case sensitivity and ignores unrelated event types', () => {
    const criteria = {
      caseSensitive: false,
      kind: 'TEXT',
      operator: 'contains',
      value: 'YES',
    };

    expect(
      matchesWaitForReplyCriteria(criteria, {
        content: { text: 'Yes, please' },
        type: 'MESSAGE',
      }),
    ).toBe(true);
    expect(
      matchesWaitForReplyCriteria(criteria, {
        content: { text: 'Yes, please' },
        type: 'MESSAGE_EDITED',
      }),
    ).toBe(false);
  });

  it('matches only selected media types', () => {
    const criteria = { kind: 'MEDIA', mediaTypes: ['PHOTO', 'DOCUMENT'] };

    expect(matchesWaitForReplyCriteria(criteria, { content: {}, type: 'PHOTO' })).toBe(true);
    expect(matchesWaitForReplyCriteria(criteria, { content: {}, type: 'VOICE' })).toBe(false);
  });

  it('matches WhatsApp button replies by their interactive callback id', () => {
    const criteria = {
      caseSensitive: true,
      kind: 'CALLBACK',
      operator: 'equals',
      value: 'webinar_yes',
    };

    expect(
      matchesWaitForReplyCriteria(criteria, {
        interactive: { id: 'webinar_yes', title: 'Yes', type: 'button_reply' },
        occurredAt: '2026-08-14T07:53:00.000Z',
      }),
    ).toBe(true);
    expect(
      matchesWaitForReplyCriteria(criteria, {
        interactive: { id: 'webinar_no', title: 'No', type: 'button_reply' },
      }),
    ).toBe(false);
  });
});

describe('condition groups and safe simulation', () => {
  it('supports deterministic AND and OR groups', () => {
    const values = new Map<string, unknown>([
      ['message.text', 'yes please'],
      ['contact.customFields.score', 10],
    ]);
    const rules = [
      { field: 'message.text', operator: 'contains' as const, value: 'yes' },
      { field: 'contact.customFields.score', operator: 'greater_or_equal' as const, value: 5 },
    ];

    expect(evaluateConditionGroup({ combinator: 'AND', rules }, (field) => values.get(field))).toBe(
      true,
    );
    expect(
      evaluateConditionGroup(
        {
          combinator: 'OR',
          rules: [{ field: 'message.text', operator: 'equals', value: 'no' }],
        },
        (field) => values.get(field),
      ),
    ).toBe(false);
  });

  it('simulates branch choice without executing action side effects', () => {
    const result = simulateScenarioGraph(
      {
        edges: [
          { from: 'incoming', to: 'condition' },
          {
            conditionGroup: {
              combinator: 'AND',
              rules: [{ field: 'message.text', operator: 'contains', value: 'yes' }],
            },
            from: 'condition',
            output: 'accepted',
            priority: 0,
            to: 'send',
          },
          { from: 'condition', output: 'fallback', priority: 1, to: 'stop' },
          { from: 'send', to: 'stop' },
        ],
        nodes: [
          { id: 'incoming', type: 'INCOMING_MESSAGE' },
          { id: 'condition', type: 'CONDITION' },
          { config: { text: 'Never sent' }, id: 'send', type: 'SEND_MESSAGE' },
          { id: 'stop', type: 'STOP' },
        ],
      },
      { event: { content: { text: 'yes' }, type: 'MESSAGE' } },
    );

    expect(result.completed).toBe(true);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'condition', selectedOutput: 'accepted' }),
        expect.objectContaining({ nodeId: 'send', result: 'WOULD_EXECUTE' }),
      ]),
    );
  });

  it('keeps legacy node-level conditions executable without turning every edge into a fallback', () => {
    const graph = {
      edges: [
        { from: 'incoming', to: 'condition' },
        { from: 'condition', output: 'matched', priority: 0, to: 'stop' },
        { from: 'condition', output: 'also-matched', priority: 1, to: 'stop-2' },
      ],
      nodes: [
        { id: 'incoming', type: 'INCOMING_MESSAGE' },
        {
          config: { field: 'message.text', operator: 'equals', value: 'yes' },
          id: 'condition',
          type: 'CONDITION',
        },
        { id: 'stop', type: 'STOP' },
        { id: 'stop-2', type: 'STOP' },
      ],
    };

    expect(validateScenarioGraph(graph).errors).not.toContain(
      'Condition node condition has multiple fallback branches',
    );
    expect(
      simulateScenarioGraph(graph, {
        event: { content: { text: 'no' }, type: 'MESSAGE' },
      }).steps.find((step) => step.nodeId === 'condition'),
    ).toMatchObject({ reasonCode: 'NO_BRANCH_MATCHED' });
  });

  it('simulates the selected external HTTP outcome without making a request', () => {
    const graph = {
      edges: [
        { from: 'incoming', to: 'http' },
        { from: 'http', output: 'success', to: 'success' },
        { from: 'http', output: 'failure', to: 'failure' },
      ],
      nodes: [
        { id: 'incoming', type: 'INCOMING_MESSAGE' },
        {
          config: { method: 'GET', url: 'https://example.test/status' },
          id: 'http',
          type: 'EXTERNAL_HTTP_REQUEST',
        },
        { id: 'success', type: 'STOP' },
        { id: 'failure', type: 'STOP' },
      ],
    };

    expect(simulateScenarioGraph(graph).steps.at(-1)).toMatchObject({
      nodeId: 'http',
      reasonCode: 'HTTP_OUTCOME_REQUIRED',
      result: 'WAITING',
    });
    expect(simulateScenarioGraph(graph, { httpOutcome: 'failure' }).steps[1]).toMatchObject({
      nextNodeId: 'failure',
      reasonCode: 'HTTP_FAILURE_SIMULATED',
      selectedOutput: 'failure',
    });
  });

  it('resolves a mapped HTTP variable by its configured path', () => {
    expect(automationValueFor('crm.leadId', {}, {}, {}, { crm: { leadId: 'lead-a' } })).toBe(
      'lead-a',
    );
  });
});
