import type { GuidanceGraph, GuidanceNeighborResult, GuidancePosition } from "./guidance-types";

export type GuidancePositionMap = Readonly<Record<string, GuidancePosition>>;

function stableHash(value: string): number {
  return [...value].reduce((hash, character) => ((hash * 31 + character.charCodeAt(0)) >>> 0), 2166136261);
}

function fallbackDirection(seed: string): GuidancePosition {
  const angle = (stableHash(seed) % 360) * (Math.PI / 180);
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

export function createDefaultGuidancePositions(graph: GuidanceGraph): Record<string, GuidancePosition> {
  const total = Math.max(graph.nodes.length, 1);
  const radius = Math.max(240, total * 34);

  return Object.fromEntries(
    graph.nodes.map((node, index) => {
      const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
      return [node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }];
    }),
  );
}

/**
 * 根据基础位置计算聚焦时的临时位置。它从不运行布局算法，也不依赖随机数。
 */
export function getFocusedPositions(
  graph: GuidanceGraph,
  basePositions: GuidancePositionMap,
  selectedNodeId: string,
  neighbors: GuidanceNeighborResult,
): Record<string, GuidancePosition> {
  const defaults = createDefaultGuidancePositions(graph);
  const selectedPosition = basePositions[selectedNodeId] ?? defaults[selectedNodeId];
  const firstDegree = new Set(neighbors.firstDegreeNodeIds);
  const secondDegree = new Set(neighbors.secondDegreeNodeIds);

  return Object.fromEntries(
    graph.nodes.map((node) => {
      const basePosition = basePositions[node.id] ?? defaults[node.id];
      if (node.id === selectedNodeId || secondDegree.has(node.id)) {
        return [node.id, basePosition];
      }

      const vector = {
        x: selectedPosition.x - basePosition.x,
        y: selectedPosition.y - basePosition.y,
      };
      const distance = Math.hypot(vector.x, vector.y);
      const direction =
        distance > 0.001
          ? { x: vector.x / distance, y: vector.y / distance }
          : fallbackDirection(`${selectedNodeId}:${node.id}`);

      if (firstDegree.has(node.id)) {
        const pullDistance = Math.min(distance * 0.16, 58);
        return [
          node.id,
          {
            x: basePosition.x + direction.x * pullDistance,
            y: basePosition.y + direction.y * pullDistance,
          },
        ];
      }

      const pushDistance = Math.min(38, 12 + distance * 0.08);
      return [
        node.id,
        {
          x: basePosition.x - direction.x * pushDistance,
          y: basePosition.y - direction.y * pushDistance,
        },
      ];
    }),
  );
}
