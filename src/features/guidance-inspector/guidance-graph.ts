import type {
  GuidanceGraph,
  GuidanceGraphEdge,
  GuidanceGraphLinkInput,
  GuidanceGraphNode,
  GuidanceGraphNodeInput,
  GuidanceNeighborResult,
} from "./guidance-types";

function createCanonicalEdgeId(link: GuidanceGraphLinkInput): string {
  return `guidance-edge:${link.fromGuidelineId}:${link.relationType}:${link.toGuidelineId}`;
}

function createEdgeId(link: GuidanceGraphLinkInput, index: number): string {
  return `${createCanonicalEdgeId(link)}:${index}`;
}

/**
 * 将任意数据源转为 UI 可查询的图领域模型。
 * 该函数保留不可渲染的异常边，供结构诊断定位，绝不静默丢弃它们。
 */
export function buildGuidanceGraph(
  nodeInputs: readonly GuidanceGraphNodeInput[],
  linkInputs: readonly GuidanceGraphLinkInput[],
): GuidanceGraph {
  const inputNodeById = new Map(nodeInputs.map((node) => [node.id, node]));
  const incomingByNodeId = new Map<string, string[]>();
  const outgoingByNodeId = new Map<string, string[]>();
  const neighborsByNodeId = new Map<string, Set<string>>();

  nodeInputs.forEach((node) => {
    incomingByNodeId.set(node.id, []);
    outgoingByNodeId.set(node.id, []);
    neighborsByNodeId.set(node.id, new Set());
  });

  const edges: GuidanceGraphEdge[] = linkInputs.map((link, sourceIndex) => {
    const isRenderable =
      inputNodeById.has(link.fromGuidelineId) && inputNodeById.has(link.toGuidelineId);

    return {
      ...link,
      id: createEdgeId(link, sourceIndex),
      canonicalId: createCanonicalEdgeId(link),
      sourceIndex,
      isRenderable,
    };
  });

  edges.forEach((edge) => {
    if (!edge.isRenderable) {
      return;
    }

    outgoingByNodeId.get(edge.fromGuidelineId)?.push(edge.id);
    incomingByNodeId.get(edge.toGuidelineId)?.push(edge.id);

    if (edge.fromGuidelineId !== edge.toGuidelineId) {
      neighborsByNodeId.get(edge.fromGuidelineId)?.add(edge.toGuidelineId);
      neighborsByNodeId.get(edge.toGuidelineId)?.add(edge.fromGuidelineId);
    }
  });

  const nodes: GuidanceGraphNode[] = nodeInputs.map((node) => ({
    ...node,
    incomingEdgeIds: [...(incomingByNodeId.get(node.id) ?? [])],
    outgoingEdgeIds: [...(outgoingByNodeId.get(node.id) ?? [])],
    directNeighborIds: [...(neighborsByNodeId.get(node.id) ?? new Set())],
  }));

  return {
    nodes,
    edges,
    renderableEdges: edges.filter((edge) => edge.isRenderable),
    nodeById: new Map(nodes.map((node) => [node.id, node])),
    edgeById: new Map(edges.map((edge) => [edge.id, edge])),
  };
}

/**
 * 以入边和出边共同构成的无向邻接关系做两层 BFS，供节点聚焦使用。
 */
export function getGuidelineNeighbors(
  graph: GuidanceGraph,
  nodeId: string,
): GuidanceNeighborResult | null {
  const selectedNode = graph.nodeById.get(nodeId);
  if (!selectedNode) {
    return null;
  }

  const depthByNodeId = new Map<string, 0 | 1 | 2>([[nodeId, 0]]);
  const queue: string[] = [nodeId];

  while (queue.length > 0) {
    const currentNodeId = queue.shift();
    if (!currentNodeId) {
      continue;
    }

    const currentDepth = depthByNodeId.get(currentNodeId) ?? 0;
    if (currentDepth >= 2) {
      continue;
    }

    const currentNode = graph.nodeById.get(currentNodeId);
    currentNode?.directNeighborIds.forEach((neighborId) => {
      if (depthByNodeId.has(neighborId)) {
        return;
      }

      depthByNodeId.set(neighborId, (currentDepth + 1) as 1 | 2);
      queue.push(neighborId);
    });
  }

  const firstDegreeNodeIds = graph.nodes
    .filter((node) => depthByNodeId.get(node.id) === 1)
    .map((node) => node.id);
  const secondDegreeNodeIds = graph.nodes
    .filter((node) => depthByNodeId.get(node.id) === 2)
    .map((node) => node.id);

  return {
    selectedNodeId: nodeId,
    firstDegreeNodeIds,
    secondDegreeNodeIds,
    firstDegreeEdgeIds: [...selectedNode.incomingEdgeIds, ...selectedNode.outgoingEdgeIds],
    depthByNodeId,
  };
}

export function getIncidentEdges(graph: GuidanceGraph, nodeId: string): GuidanceGraphEdge[] {
  const node = graph.nodeById.get(nodeId);
  if (!node) {
    return [];
  }

  return [...node.incomingEdgeIds, ...node.outgoingEdgeIds]
    .map((edgeId) => graph.edgeById.get(edgeId))
    .filter((edge): edge is GuidanceGraphEdge => edge !== undefined);
}
