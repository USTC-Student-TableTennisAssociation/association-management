"use client";

import { useMemo, useState, type ReactNode } from "react";

import { KindBadge, StatusBadge } from "./GuidanceBadges";
import { getGuidanceTreePath, type GuidanceTree } from "./guidance-tree";
import {
  guidanceRelationLabels,
  type GuidanceGraph,
  type GuidanceGraphEdge,
  type GuidanceRelationType,
  type InspectorSelection,
} from "./guidance-types";

type GuidanceTreeViewProps = {
  graph: GuidanceGraph;
  tree: GuidanceTree;
  selection: InspectorSelection;
  matchingNodeIds: readonly string[];
  onlyShowMatches: boolean;
  hoveredNodeId: string | null;
  diagnosticNodeIds: readonly string[];
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (edgeId: string) => void;
};

const relationOrder: GuidanceRelationType[] = ["requires", "next", "triggers", "exception", "contains"];

function relationBadgeStyle(relationType: GuidanceRelationType): string {
  const styles: Record<GuidanceRelationType, string> = {
    contains: "border-emerald-200 bg-emerald-50 text-emerald-700",
    triggers: "border-blue-200 bg-blue-50 text-blue-700",
    requires: "border-orange-200 bg-orange-50 text-orange-700",
    next: "border-purple-200 bg-purple-50 text-purple-700",
    exception: "border-red-200 bg-red-50 text-red-700",
  };
  return styles[relationType];
}

function getIncidentCrossEdges(
  graph: GuidanceGraph,
  nodeId: string,
  secondaryContainmentEdgeIds: ReadonlySet<string>,
): GuidanceGraphEdge[] {
  const node = graph.nodeById.get(nodeId);
  if (!node) {
    return [];
  }

  return [...node.incomingEdgeIds, ...node.outgoingEdgeIds]
    .map((edgeId) => graph.edgeById.get(edgeId))
    .filter(
      (edge): edge is GuidanceGraphEdge =>
        edge !== undefined &&
        (edge.relationType !== "contains" || secondaryContainmentEdgeIds.has(edge.id)),
    );
}

export function GuidanceTreeView({
  graph,
  tree,
  selection,
  matchingNodeIds,
  onlyShowMatches,
  hoveredNodeId,
  diagnosticNodeIds,
  onSelectNode,
  onSelectEdge,
}: GuidanceTreeViewProps) {
  const workflowRootIds = useMemo(
    () => tree.rootNodeIds.filter((nodeId) => graph.nodeById.get(nodeId)?.kind === "workflow"),
    [graph.nodeById, tree.rootNodeIds],
  );
  const otherRootIds = useMemo(
    () => tree.rootNodeIds.filter((nodeId) => graph.nodeById.get(nodeId)?.kind !== "workflow"),
    [graph.nodeById, tree.rootNodeIds],
  );
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(
    () => new Set(workflowRootIds),
  );
  const [isOtherRootsOpen, setIsOtherRootsOpen] = useState(false);
  const matchingNodeIdSet = useMemo(() => new Set(matchingNodeIds), [matchingNodeIds]);
  const diagnosticNodeIdSet = useMemo(() => new Set(diagnosticNodeIds), [diagnosticNodeIds]);
  const secondaryContainmentEdgeIdSet = useMemo(
    () => new Set(tree.secondaryContainmentEdgeIds),
    [tree.secondaryContainmentEdgeIds],
  );

  const selectedNodeId = selection?.type === "node" ? selection.id : null;
  const selectedEdge = selection?.type === "edge" ? graph.edgeById.get(selection.id) : undefined;
  const relatedNodeIdSet = useMemo(
    () =>
      new Set([
        ...diagnosticNodeIds,
        ...(selectedEdge ? [selectedEdge.fromGuidelineId, selectedEdge.toGuidelineId] : []),
      ]),
    [diagnosticNodeIds, selectedEdge],
  );

  const focusNodeIds = useMemo(() => {
    if (selectedNodeId) {
      return [selectedNodeId];
    }
    if (selectedEdge) {
      return [selectedEdge.fromGuidelineId, selectedEdge.toGuidelineId];
    }
    return [...diagnosticNodeIds];
  }, [diagnosticNodeIds, selectedEdge, selectedNodeId]);

  const forcedExpandedNodeIds = useMemo(() => {
    const expanded = new Set<string>();
    focusNodeIds.forEach((nodeId) => {
      const path = getGuidanceTreePath(tree, nodeId);
      path.slice(0, -1).forEach((pathNodeId) => expanded.add(pathNodeId));
    });
    return expanded;
  }, [focusNodeIds, tree]);

  const visibleNodeIds = useMemo(() => {
    if (!onlyShowMatches) {
      return new Set(graph.nodes.map((node) => node.id));
    }

    const visible = new Set<string>();
    matchingNodeIds.forEach((nodeId) => {
      getGuidanceTreePath(tree, nodeId).forEach((pathNodeId) => visible.add(pathNodeId));
    });
    focusNodeIds.forEach((nodeId) => {
      getGuidanceTreePath(tree, nodeId).forEach((pathNodeId) => visible.add(pathNodeId));
    });
    return visible;
  }, [focusNodeIds, graph.nodes, matchingNodeIds, onlyShowMatches, tree]);

  const relationCountsByNodeId = useMemo(() => {
    return new Map(
      graph.nodes.map((node) => {
        const counts = new Map<GuidanceRelationType, number>();
        getIncidentCrossEdges(graph, node.id, secondaryContainmentEdgeIdSet).forEach((edge) => {
          counts.set(edge.relationType, (counts.get(edge.relationType) ?? 0) + 1);
        });
        return [node.id, counts] as const;
      }),
    );
  }, [graph, secondaryContainmentEdgeIdSet]);

  const selectedNode = selectedNodeId ? graph.nodeById.get(selectedNodeId) : undefined;
  const selectedPath = selectedNode ? getGuidanceTreePath(tree, selectedNode.id) : [];
  const selectedCrossEdges = selectedNode
    ? getIncidentCrossEdges(graph, selectedNode.id, secondaryContainmentEdgeIdSet)
    : selectedEdge
      ? [selectedEdge]
      : [];
  const focusedRootIds = new Set(
    focusNodeIds.map((nodeId) => getGuidanceTreePath(tree, nodeId)[0]).filter(Boolean),
  );
  const shouldShowOtherRoots =
    isOtherRootsOpen || otherRootIds.some((rootNodeId) => focusedRootIds.has(rootNodeId));

  function toggleExpanded(nodeId: string): void {
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }

  function expandAll(): void {
    setExpandedNodeIds(
      new Set(
        graph.nodes
          .filter((node) => (tree.childrenByNodeId.get(node.id)?.length ?? 0) > 0)
          .map((node) => node.id),
      ),
    );
    setIsOtherRootsOpen(true);
  }

  function collapseToRoots(): void {
    setExpandedNodeIds(new Set());
    setIsOtherRootsOpen(false);
  }

  function renderBranch(nodeId: string): ReactNode {
    if (!visibleNodeIds.has(nodeId)) {
      return null;
    }

    const node = graph.nodeById.get(nodeId);
    if (!node) {
      return null;
    }

    const childNodeIds = (tree.childrenByNodeId.get(nodeId) ?? []).filter((childNodeId) =>
      visibleNodeIds.has(childNodeId),
    );
    const isExpanded = expandedNodeIds.has(nodeId) || forcedExpandedNodeIds.has(nodeId);
    const isSelected = selectedNodeId === nodeId;
    const isRelated = relatedNodeIdSet.has(nodeId) || diagnosticNodeIdSet.has(nodeId);
    const isHovered = hoveredNodeId === nodeId;
    const matchesFilters = matchingNodeIdSet.has(nodeId);
    const isDimmedByFilter = !matchesFilters && !isSelected && !isRelated;
    const relationCounts = relationCountsByNodeId.get(nodeId) ?? new Map();

    return (
      <div className="relative" key={nodeId}>
        <div className="flex items-stretch gap-2">
          {childNodeIds.length > 0 ? (
            <button
              type="button"
              aria-label={`${isExpanded ? "折叠" : "展开"}“${node.title}”`}
              aria-expanded={isExpanded}
              onClick={() => toggleExpanded(nodeId)}
              className="flex w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-sm font-semibold text-zinc-500 transition hover:border-emerald-300 hover:text-emerald-800"
            >
              {isExpanded ? "−" : "+"}
            </button>
          ) : (
            <span className="w-8 shrink-0" aria-hidden="true" />
          )}

          <button
            type="button"
            data-guidance-node-id={node.id}
            aria-current={isSelected ? "true" : undefined}
            onClick={() => onSelectNode(node.id)}
            className={`min-w-0 flex-1 rounded-lg border px-4 py-3 text-left transition ${
              isSelected
                ? "border-zinc-950 bg-white ring-2 ring-zinc-300"
                : isRelated
                  ? "border-emerald-500 bg-emerald-50/70 ring-1 ring-emerald-200"
                  : "border-zinc-200 bg-white hover:border-emerald-300 hover:bg-emerald-50/30"
            } ${isHovered ? "ring-2 ring-emerald-300" : ""} ${isDimmedByFilter ? "opacity-30" : ""}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-5 text-zinc-950">{node.title}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <KindBadge kind={node.kind} />
                  <StatusBadge status={node.status} />
                  {node.isMandatory ? (
                    <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                      强制
                    </span>
                  ) : null}
                </div>
              </div>
              <span className="shrink-0 text-[11px] text-zinc-400">
                入 {node.incomingEdgeIds.length} · 出 {node.outgoingEdgeIds.length}
              </span>
            </div>

            {relationCounts.size > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {relationOrder.map((relationType) => {
                  const count = relationCounts.get(relationType);
                  return count ? (
                    <span
                      key={relationType}
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${relationBadgeStyle(relationType)}`}
                    >
                      {guidanceRelationLabels[relationType]} {count}
                    </span>
                  ) : null;
                })}
              </div>
            ) : null}
          </button>
        </div>

        {isExpanded && childNodeIds.length > 0 ? (
          <div className="relative ml-4 border-l border-zinc-300 pb-1 pl-7 pt-3">
            {childNodeIds.map((childNodeId) => (
              <div
                key={childNodeId}
                className="relative pb-3 before:absolute before:-left-7 before:top-6 before:w-7 before:border-t before:border-zinc-300"
              >
                {renderBranch(childNodeId)}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
      aria-label="指导层树状导航"
    >
      <div className="flex flex-col gap-3 border-b border-zinc-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-zinc-500">当前路径</p>
          {selectedPath.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-sm text-zinc-700">
              {selectedPath.map((pathNodeId, index) => (
                <span key={pathNodeId} className="flex items-center gap-1">
                  {index > 0 ? <span className="text-zinc-300">/</span> : null}
                  <span>{graph.nodeById.get(pathNodeId)?.title ?? pathNodeId}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-sm text-zinc-500">从工作流入口开始，逐层展开包含的指导卡片。</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={expandAll}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:border-emerald-300 hover:text-emerald-800"
          >
            展开全部
          </button>
          <button
            type="button"
            onClick={collapseToRoots}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:border-emerald-300 hover:text-emerald-800"
          >
            只看入口
          </button>
        </div>
      </div>

      {selectedCrossEdges.length > 0 ? (
        <section className="border-b border-zinc-100 py-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-zinc-600">
              {selectedNode ? "当前节点的横向关系" : "当前选中的关系"}
            </h3>
            <span className="text-[11px] text-zinc-400">不改变树的父子结构</span>
          </div>
          <div className="grid gap-2 xl:grid-cols-2">
            {selectedCrossEdges.map((edge) => {
              const isOutgoing = selectedNode ? edge.fromGuidelineId === selectedNode.id : true;
              const otherNodeId = selectedNode
                ? isOutgoing
                  ? edge.toGuidelineId
                  : edge.fromGuidelineId
                : edge.toGuidelineId;
              const otherNode = graph.nodeById.get(otherNodeId);
              return (
                <button
                  key={edge.id}
                  type="button"
                  onClick={() => onSelectEdge(edge.id)}
                  className={`rounded-md border px-3 py-2 text-left transition hover:border-emerald-300 ${
                    selectedEdge?.id === edge.id ? "border-emerald-500 bg-emerald-50" : "border-zinc-200 bg-zinc-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate font-medium text-zinc-800">
                      {isOutgoing ? "→" : "←"} {otherNode?.title ?? otherNodeId}
                    </span>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${relationBadgeStyle(edge.relationType)}`}>
                      {guidanceRelationLabels[edge.relationType]}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-1 text-[11px] text-zinc-500">{edge.note ?? "未填写关系说明"}</p>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">工作流入口</h3>
            <p className="mt-1 text-xs text-zinc-500">工作流位于第一层，缩进关系表示 contains。</p>
          </div>
          <span className="rounded-full bg-zinc-100 px-2 py-1 text-[11px] text-zinc-500">{workflowRootIds.length}</span>
        </div>
        <div className="space-y-4">
          {workflowRootIds.filter((nodeId) => visibleNodeIds.has(nodeId)).map((nodeId) => renderBranch(nodeId))}
          {workflowRootIds.length === 0 ? (
            <p className="rounded-md border border-dashed border-zinc-300 p-3 text-sm text-zinc-500">当前没有可作为入口的工作流。</p>
          ) : null}
        </div>
      </section>

      <section className="border-t border-zinc-100 pt-4">
        <button
          type="button"
          aria-expanded={shouldShowOtherRoots}
          onClick={() => setIsOtherRootsOpen((open) => !open)}
          className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-2 text-left hover:bg-zinc-50"
        >
          <span>
            <span className="block text-sm font-semibold text-zinc-900">未归属工作流</span>
            <span className="mt-1 block text-xs text-zinc-500">独立规则、检查表和经验仍保留在树的单独入口中。</span>
          </span>
          <span className="shrink-0 text-xs text-zinc-500">{otherRootIds.length} · {shouldShowOtherRoots ? "收起" : "展开"}</span>
        </button>
        {shouldShowOtherRoots ? (
          <div className="mt-3 space-y-3">
            {otherRootIds.filter((nodeId) => visibleNodeIds.has(nodeId)).map((nodeId) => renderBranch(nodeId))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
