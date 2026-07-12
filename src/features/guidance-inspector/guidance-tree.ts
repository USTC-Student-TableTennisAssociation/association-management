import type { GuidanceGraph, GuidanceKind } from "./guidance-types";

export type GuidanceTree = {
  rootNodeIds: readonly string[];
  childrenByNodeId: ReadonlyMap<string, readonly string[]>;
  parentByNodeId: ReadonlyMap<string, string>;
  primaryContainmentEdgeIdByNodeId: ReadonlyMap<string, string>;
  secondaryContainmentEdgeIds: readonly string[];
};

const kindOrder: Record<GuidanceKind, number> = {
  workflow: 0,
  rule: 1,
  checklist: 2,
  experience: 3,
};

function compareNodeIds(graph: GuidanceGraph, leftId: string, rightId: string): number {
  const left = graph.nodeById.get(leftId);
  const right = graph.nodeById.get(rightId);
  if (!left || !right) {
    return leftId.localeCompare(rightId);
  }

  return kindOrder[left.kind] - kindOrder[right.kind] || left.title.localeCompare(right.title, "zh-CN");
}

function wouldCreateContainmentCycle(
  parentNodeId: string,
  childNodeId: string,
  parentByNodeId: ReadonlyMap<string, string>,
): boolean {
  if (parentNodeId === childNodeId) {
    return true;
  }

  let currentNodeId: string | undefined = parentNodeId;
  const visited = new Set<string>();
  while (currentNodeId && !visited.has(currentNodeId)) {
    if (currentNodeId === childNodeId) {
      return true;
    }
    visited.add(currentNodeId);
    currentNodeId = parentByNodeId.get(currentNodeId);
  }

  return false;
}

function sortSiblingIds(graph: GuidanceGraph, siblingIds: readonly string[]): string[] {
  const siblingIdSet = new Set(siblingIds);
  const baseOrder = [...siblingIds].sort((leftId, rightId) => compareNodeIds(graph, leftId, rightId));
  const outgoingNextByNodeId = new Map<string, Set<string>>();
  const incomingNextCountByNodeId = new Map(baseOrder.map((nodeId) => [nodeId, 0]));

  graph.renderableEdges
    .filter(
      (edge) =>
        edge.relationType === "next" &&
        siblingIdSet.has(edge.fromGuidelineId) &&
        siblingIdSet.has(edge.toGuidelineId) &&
        edge.fromGuidelineId !== edge.toGuidelineId,
    )
    .forEach((edge) => {
      const targets = outgoingNextByNodeId.get(edge.fromGuidelineId) ?? new Set<string>();
      if (!targets.has(edge.toGuidelineId)) {
        targets.add(edge.toGuidelineId);
        outgoingNextByNodeId.set(edge.fromGuidelineId, targets);
        incomingNextCountByNodeId.set(
          edge.toGuidelineId,
          (incomingNextCountByNodeId.get(edge.toGuidelineId) ?? 0) + 1,
        );
      }
    });

  const remaining = new Set(baseOrder);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const availableNodeId = baseOrder.find(
      (nodeId) => remaining.has(nodeId) && (incomingNextCountByNodeId.get(nodeId) ?? 0) === 0,
    );
    if (!availableNodeId) {
      break;
    }

    ordered.push(availableNodeId);
    remaining.delete(availableNodeId);
    outgoingNextByNodeId.get(availableNodeId)?.forEach((targetNodeId) => {
      incomingNextCountByNodeId.set(
        targetNodeId,
        Math.max(0, (incomingNextCountByNodeId.get(targetNodeId) ?? 0) - 1),
      );
    });
  }

  return [...ordered, ...baseOrder.filter((nodeId) => remaining.has(nodeId))];
}

/**
 * 使用 contains 建立稳定的展示树。知识仍然保留为图：额外父级和成环边会作为横向引用保留。
 */
export function buildGuidanceTree(graph: GuidanceGraph): GuidanceTree {
  const parentByNodeId = new Map<string, string>();
  const primaryContainmentEdgeIdByNodeId = new Map<string, string>();
  const secondaryContainmentEdgeIds: string[] = [];

  const containmentEdges = graph.renderableEdges
    .filter((edge) => edge.relationType === "contains")
    .sort((left, right) => left.sourceIndex - right.sourceIndex);

  containmentEdges.forEach((edge) => {
    const alreadyHasParent = parentByNodeId.has(edge.toGuidelineId);
    if (
      alreadyHasParent ||
      wouldCreateContainmentCycle(edge.fromGuidelineId, edge.toGuidelineId, parentByNodeId)
    ) {
      secondaryContainmentEdgeIds.push(edge.id);
      return;
    }

    parentByNodeId.set(edge.toGuidelineId, edge.fromGuidelineId);
    primaryContainmentEdgeIdByNodeId.set(edge.toGuidelineId, edge.id);
  });

  const mutableChildrenByNodeId = new Map<string, string[]>();
  graph.nodes.forEach((node) => mutableChildrenByNodeId.set(node.id, []));
  parentByNodeId.forEach((parentNodeId, childNodeId) => {
    mutableChildrenByNodeId.get(parentNodeId)?.push(childNodeId);
  });

  const childrenByNodeId = new Map<string, readonly string[]>();
  mutableChildrenByNodeId.forEach((childNodeIds, parentNodeId) => {
    childrenByNodeId.set(parentNodeId, sortSiblingIds(graph, childNodeIds));
  });

  const rootNodeIds = graph.nodes
    .filter((node) => !parentByNodeId.has(node.id))
    .map((node) => node.id)
    .sort((leftId, rightId) => compareNodeIds(graph, leftId, rightId));

  return {
    rootNodeIds,
    childrenByNodeId,
    parentByNodeId,
    primaryContainmentEdgeIdByNodeId,
    secondaryContainmentEdgeIds,
  };
}

export function getGuidanceTreePath(tree: GuidanceTree, nodeId: string): string[] {
  const path = [nodeId];
  const visited = new Set(path);
  let currentNodeId = tree.parentByNodeId.get(nodeId);

  while (currentNodeId && !visited.has(currentNodeId)) {
    path.unshift(currentNodeId);
    visited.add(currentNodeId);
    currentNodeId = tree.parentByNodeId.get(currentNodeId);
  }

  return path;
}
