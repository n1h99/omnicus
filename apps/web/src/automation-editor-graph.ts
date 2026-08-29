import type { Edge, Node } from '@xyflow/react';

import type { ScenarioGraph } from './automation-api';

export type AutomationEdgeData = {
  condition?: { field: string; operator: string; value?: unknown };
  conditionGroup?: {
    combinator: 'AND' | 'OR';
    rules: Array<{ field: string; operator: string; value?: unknown }>;
  };
  output?: string;
  priority?: number;
};

export function automationEdgeLabel(output?: string): string | undefined {
  if (!output || output === 'default') return undefined;
  const branch = /^branch-(\d+)$/i.exec(output);
  if (branch) return `Branch ${branch[1]}`;
  return output.replaceAll('_', ' ');
}

export function spreadCompactFlowNodes(nodes: Node[]): Node[] {
  const minimumVerticalStep = 340;
  const overlappingLaneWidth = 360;
  const placed: Node[] = [];
  const positions = new Map<string, { x: number; y: number }>();

  for (const node of [...nodes].sort(
    (left, right) => left.position.y - right.position.y || left.position.x - right.position.x,
  )) {
    let y = node.position.y;
    for (const previous of placed) {
      const sharesLane = Math.abs(node.position.x - previous.position.x) < overlappingLaneWidth;
      if (sharesLane && y - previous.position.y < minimumVerticalStep)
        y = previous.position.y + minimumVerticalStep;
    }
    const position = { x: node.position.x, y };
    positions.set(node.id, position);
    placed.push({ ...node, position });
  }

  return nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
}

function compactPreview(value: unknown, maximum = 64): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maximum ? `${compact.slice(0, maximum - 3)}...` : compact;
}

export function automationNodePreview(type: string, config: Record<string, unknown> | undefined) {
  const value = config ?? {};
  if (type === 'SEND_MESSAGE') {
    const text = compactPreview(value.text, 52);
    const additionalAssets = Array.isArray(value.mediaAssetIds) ? value.mediaAssetIds.length : 0;
    const attachments = (typeof value.mediaAssetId === 'string' ? 1 : 0) + additionalAssets;
    const buttons = [
      ...(Array.isArray(value.telegramButtons) ? value.telegramButtons : []),
      ...(Array.isArray(value.whatsappButtons) ? value.whatsappButtons : []),
    ];
    return [
      text,
      attachments ? `${attachments} attachment${attachments === 1 ? '' : 's'}` : undefined,
      buttons.length ? `${buttons.length} button${buttons.length === 1 ? '' : 's'}` : undefined,
    ]
      .filter(Boolean)
      .join(' | ');
  }
  if (type === 'DELAY' && typeof value.delaySeconds === 'number')
    return `Wait ${value.delaySeconds}s`;
  if (type === 'WAIT_FOR_REPLY' && typeof value.timeoutSeconds === 'number')
    return `Timeout ${value.timeoutSeconds}s`;
  if (type === 'CONDITION')
    return compactPreview(
      [value.field, value.operator, value.value].filter((part) => part !== undefined).join(' '),
    );
  if (type === 'INCOMING_MESSAGE' && value.triggerType === 'WEBSITE_REGISTRATION')
    return compactPreview(`Website: ${String(value.sourceKey ?? '')}`);
  if (type === 'SEND_EMAIL') return 'Published email template';
  if (type === 'SEND_TEMPLATE') return 'Published message template';
  return undefined;
}

export function scenarioGraphToFlow(graph: ScenarioGraph): { edges: Edge[]; nodes: Node[] } {
  return {
    edges: graph.edges.map((edge, index) => ({
      data: {
        ...(edge.condition ? { condition: edge.condition } : {}),
        ...(edge.conditionGroup ? { conditionGroup: edge.conditionGroup } : {}),
        output: edge.output ?? 'default',
        ...(edge.priority === undefined ? {} : { priority: edge.priority }),
      },
      id: edge.id ?? `edge-${index}-${edge.from}-${edge.to}`,
      label: automationEdgeLabel(edge.output),
      source: edge.from,
      target: edge.to,
    })),
    nodes: graph.nodes.map((node) => {
      const preview = automationNodePreview(node.type, node.config);
      return {
      data: {
        config: node.config ?? {},
        label: node.type,
        ...(preview ? { preview } : {}),
      },
        id: node.id,
        position: node.position ?? { x: 0, y: 0 },
        type: 'default',
      };
    }),
  };
}

export function flowToScenarioGraph(
  nodes: Node[],
  edges: Edge[],
  configs: Record<string, Record<string, unknown>>,
): ScenarioGraph {
  return {
    edges: edges.map((edge) => {
      const data = (edge.data ?? {}) as AutomationEdgeData;
      return {
        ...(data.condition ? { condition: data.condition } : {}),
        ...(data.conditionGroup ? { conditionGroup: data.conditionGroup } : {}),
        from: edge.source,
        id: edge.id,
        output: data.output ?? (typeof edge.label === 'string' ? edge.label : 'default'),
        ...(data.priority === undefined ? {} : { priority: data.priority }),
        to: edge.target,
      };
    }),
    nodes: nodes.map((node) => ({
      config: configs[node.id] ?? {},
      id: node.id,
      position: node.position,
      type: String(node.data.label).split('\u0000')[0] ?? '',
    })),
  };
}
