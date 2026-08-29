import { describe, expect, it } from 'vitest';

import {
  flowToScenarioGraph,
  scenarioGraphToFlow,
  spreadCompactFlowNodes,
} from './automation-editor-graph';
import type { ScenarioGraph } from './automation-api';

describe('automation editor graph mapping', () => {
  it('round-trips branch metadata and pinned node configuration', () => {
    const graph: ScenarioGraph = {
      edges: [
        {
          condition: { field: 'message.text', operator: 'contains', value: 'yes' },
          from: 'condition',
          id: 'edge-a',
          output: 'accepted',
          priority: 0,
          to: 'template',
        },
        {
          conditionGroup: {
            combinator: 'AND',
            rules: [
              { field: 'message.text', operator: 'contains', value: 'yes' },
              {
                field: 'contact.customFields.score',
                operator: 'greater_than',
                value: 5,
              },
            ],
          },
          from: 'condition',
          id: 'edge-b',
          output: 'qualified',
          priority: 1,
          to: 'template',
        },
      ],
      nodes: [
        { config: {}, id: 'condition', position: { x: 10, y: 20 }, type: 'CONDITION' },
        {
          config: { templateId: 'template-a', templateVersionId: 'version-a' },
          id: 'template',
          position: { x: 30, y: 40 },
          type: 'SEND_TEMPLATE',
        },
      ],
    };
    const flow = scenarioGraphToFlow(graph);
    const restored = flowToScenarioGraph(
      flow.nodes,
      flow.edges,
      Object.fromEntries(graph.nodes.map((node) => [node.id, node.config ?? {}])),
    );

    expect(restored).toEqual(graph);
  });

  it('spreads compact nodes without moving independent lanes', () => {
    const nodes = [
      { data: {}, id: 'first', position: { x: 100, y: 100 } },
      { data: {}, id: 'second', position: { x: 110, y: 140 } },
      { data: {}, id: 'independent', position: { x: 500, y: 140 } },
    ];

    expect(spreadCompactFlowNodes(nodes).map((node) => node.position)).toEqual([
      { x: 100, y: 100 },
      { x: 110, y: 440 },
      { x: 500, y: 140 },
    ]);
  });
});
