import type { CSSProperties } from 'react';

import type { ScenarioGraph } from './automation-api';
import { automationNodeLabel } from './automation-studio';

type PreviewNode = ScenarioGraph['nodes'][number];

interface PreviewPoint {
  left: number;
  top: number;
}

function graphDepths(graph: ScenarioGraph): Map<string, number> {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const depths = new Map(graph.nodes.map((node) => [node.id, 0]));
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const remaining = new Map(incoming);
  const queue = graph.nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
  const visited = new Set<string>();

  while (queue.length) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const targetId of outgoing.get(nodeId) ?? []) {
      depths.set(targetId, Math.max(depths.get(targetId) ?? 0, (depths.get(nodeId) ?? 0) + 1));
      const nextIncoming = (remaining.get(targetId) ?? 1) - 1;
      remaining.set(targetId, nextIncoming);
      if (nextIncoming === 0) queue.push(targetId);
    }
  }

  let fallbackDepth = Math.max(0, ...depths.values()) + 1;
  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue;
    depths.set(node.id, fallbackDepth);
    fallbackDepth += 1;
  }
  return depths;
}

function previewLayout(graph: ScenarioGraph, compact: boolean) {
  const width = compact ? 126 : 720;
  const nodeHeight = compact ? 7 : 38;
  const paddingX = compact ? 5 : 32;
  const paddingY = compact ? 5 : 28;
  const horizontalGap = compact ? 3 : 24;
  const depths = graphDepths(graph);
  const maximumDepth = Math.max(0, ...depths.values());
  const height = compact
    ? 64
    : Math.max(
        380,
        Math.min(620, paddingY * 2 + (maximumDepth + 1) * nodeHeight + maximumDepth * 22),
      );
  const layers = new Map<number, PreviewNode[]>();
  const originalOrder = new Map(graph.nodes.map((node, index) => [node.id, index]));

  for (const node of graph.nodes) {
    const depth = depths.get(node.id) ?? 0;
    layers.set(depth, [...(layers.get(depth) ?? []), node]);
  }
  for (const layer of layers.values()) {
    layer.sort(
      (left, right) =>
        (left.position?.x ?? originalOrder.get(left.id) ?? 0) -
        (right.position?.x ?? originalOrder.get(right.id) ?? 0),
    );
  }

  const widestLayer = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const availableNodeWidth =
    (width - paddingX * 2 - horizontalGap * (widestLayer - 1)) / widestLayer;
  const nodeWidth = Math.max(
    compact ? 10 : 56,
    Math.min(compact ? 30 : 140, availableNodeWidth),
  );
  const verticalRange = height - paddingY * 2 - nodeHeight;
  const placement = new Map<string, PreviewPoint>();

  for (const [depth, layer] of layers) {
    const layerWidth = layer.length * nodeWidth + Math.max(0, layer.length - 1) * horizontalGap;
    const startX = (width - layerWidth) / 2;
    const top =
      maximumDepth === 0 ? (height - nodeHeight) / 2 : paddingY + (depth / maximumDepth) * verticalRange;
    layer.forEach((node, index) => {
      placement.set(node.id, {
        left: startX + index * (nodeWidth + horizontalGap),
        top,
      });
    });
  }

  return { height, nodeHeight, nodeWidth, placement, width };
}

function compactLabel(label: string): string {
  return label.length > 22 ? `${label.slice(0, 21)}...` : label;
}

export function AutomationGraphPreview({
  compact = false,
  graph,
}: {
  compact?: boolean;
  graph: ScenarioGraph;
}) {
  const { height, nodeHeight, nodeWidth, placement, width } = previewLayout(graph, compact);

  return (
    <div
      aria-label="Version canvas preview"
      className={`automation-version-preview${compact ? ' is-compact' : ''}`}
      style={
        { '--preview-height': `${height}px`, '--preview-width': `${width}px` } as CSSProperties
      }
    >
      <svg
        aria-hidden="true"
        preserveAspectRatio="xMidYMid meet"
        viewBox={`0 0 ${width} ${height}`}
      >
        <g className="automation-version-edges">
          {graph.edges.map((edge, index) => {
            const source = placement.get(edge.from);
            const target = placement.get(edge.to);
            if (!source || !target) return null;
            const sourceX = source.left + nodeWidth / 2;
            const sourceY = source.top + nodeHeight;
            const targetX = target.left + nodeWidth / 2;
            const targetY = target.top;
            const middleY = sourceY + (targetY - sourceY) / 2;
            return (
              <path
                d={`M ${sourceX} ${sourceY} C ${sourceX} ${middleY}, ${targetX} ${middleY}, ${targetX} ${targetY}`}
                key={edge.id ?? `${edge.from}-${edge.to}-${index}`}
              />
            );
          })}
        </g>
        <g className="automation-version-nodes">
          {graph.nodes.map((node) => {
            const point = placement.get(node.id);
            if (!point) return null;
            const label = automationNodeLabel(node.type);
            return (
              <g
                className={`automation-version-node automation-version-node--${node.type.toLowerCase()}`}
                key={node.id}
                transform={`translate(${point.left} ${point.top})`}
              >
                <title>{label}</title>
                <rect height={nodeHeight} rx={compact ? 3 : 9} width={nodeWidth} />
                {compact ? null : (
                  <text
                    dominantBaseline="middle"
                    textAnchor="middle"
                    x={nodeWidth / 2}
                    y={nodeHeight / 2}
                  >
                    {compactLabel(label)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
