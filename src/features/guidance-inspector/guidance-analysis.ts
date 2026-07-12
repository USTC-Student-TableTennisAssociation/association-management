import type {
  GuidanceCondition,
  GuidanceDiagnostic,
  GuidanceDiagnosticCode,
  GuidanceDiagnosticSeverity,
  GuidanceGraph,
  GuidanceGraphAnalysis,
  GuidanceGraphEdge,
} from "./guidance-types";

const validConditionOperators = new Set([
  "eq",
  "ne",
  "in",
  "not_in",
  "lt",
  "lte",
  "gt",
  "gte",
  "exists",
]);

function isFactCondition(condition: GuidanceCondition): condition is Extract<GuidanceCondition, { field: string }> {
  return "field" in condition;
}

function hasValidCondition(condition: GuidanceCondition | null): boolean {
  if (!condition) {
    return false;
  }

  if (isFactCondition(condition)) {
    if (!condition.field.trim() || !validConditionOperators.has(condition.operator)) {
      return false;
    }
    if (condition.operator === "exists") {
      return typeof condition.value === "boolean";
    }
    if (condition.operator === "in" || condition.operator === "not_in") {
      return Array.isArray(condition.value) && condition.value.length > 0;
    }
    return condition.value !== undefined;
  }

  const hasAll = Array.isArray(condition.all);
  const hasAny = Array.isArray(condition.any);
  if (hasAll === hasAny) {
    return false;
  }

  const children = condition.all ?? condition.any ?? [];
  return children.length > 0 && children.every((child) => hasValidCondition(child));
}

function createDiagnostic(
  code: GuidanceDiagnosticCode,
  severity: GuidanceDiagnosticSeverity,
  title: string,
  description: string,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
): GuidanceDiagnostic {
  const sortedNodeIds = [...nodeIds].sort();
  const sortedEdgeIds = [...edgeIds].sort();

  return {
    id: `diagnostic:${code}:${sortedNodeIds.join(",")}:${sortedEdgeIds.join(",")}`,
    code,
    severity,
    title,
    description,
    nodeIds: sortedNodeIds,
    edgeIds: sortedEdgeIds,
  };
}

function findRequiresCycles(graph: GuidanceGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  graph.nodes.forEach((node) => adjacency.set(node.id, []));
  graph.renderableEdges
    .filter((edge) => edge.relationType === "requires" && edge.fromGuidelineId !== edge.toGuidelineId)
    .forEach((edge) => {
      adjacency.get(edge.fromGuidelineId)?.push(edge.toGuidelineId);
    });

  let index = 0;
  const indexByNodeId = new Map<string, number>();
  const lowLinkByNodeId = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  function strongConnect(nodeId: string): void {
    indexByNodeId.set(nodeId, index);
    lowLinkByNodeId.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    (adjacency.get(nodeId) ?? []).forEach((neighborId) => {
      if (!indexByNodeId.has(neighborId)) {
        strongConnect(neighborId);
        lowLinkByNodeId.set(
          nodeId,
          Math.min(lowLinkByNodeId.get(nodeId) ?? 0, lowLinkByNodeId.get(neighborId) ?? 0),
        );
      } else if (onStack.has(neighborId)) {
        lowLinkByNodeId.set(
          nodeId,
          Math.min(lowLinkByNodeId.get(nodeId) ?? 0, indexByNodeId.get(neighborId) ?? 0),
        );
      }
    });

    if (lowLinkByNodeId.get(nodeId) !== indexByNodeId.get(nodeId)) {
      return;
    }

    const component: string[] = [];
    let stackNodeId: string | undefined;
    do {
      stackNodeId = stack.pop();
      if (stackNodeId) {
        onStack.delete(stackNodeId);
        component.push(stackNodeId);
      }
    } while (stackNodeId !== nodeId && stackNodeId !== undefined);

    if (component.length > 1) {
      components.push(component.sort());
    }
  }

  graph.nodes.forEach((node) => {
    if (!indexByNodeId.has(node.id)) {
      strongConnect(node.id);
    }
  });

  return components;
}

function getCycleEdges(graph: GuidanceGraph, nodeIds: readonly string[]): GuidanceGraphEdge[] {
  const memberIds = new Set(nodeIds);
  return graph.renderableEdges.filter(
    (edge) =>
      edge.relationType === "requires" &&
      memberIds.has(edge.fromGuidelineId) &&
      memberIds.has(edge.toGuidelineId),
  );
}

/**
 * 对领域图做只读结构检查。即使当前种子不存在某类问题，检查逻辑仍始终执行。
 */
export function analyzeGuidanceGraph(graph: GuidanceGraph): GuidanceGraphAnalysis {
  const diagnostics: GuidanceDiagnostic[] = [];

  graph.edges.forEach((edge) => {
    const sourceExists = graph.nodeById.has(edge.fromGuidelineId);
    const targetExists = graph.nodeById.has(edge.toGuidelineId);
    if (!sourceExists || !targetExists) {
      const missingParts = [
        sourceExists ? null : "起点卡片不存在",
        targetExists ? null : "终点卡片不存在",
      ].filter((part): part is string => part !== null);
      const relatedNodeIds = [edge.fromGuidelineId, edge.toGuidelineId].filter((nodeId) =>
        graph.nodeById.has(nodeId),
      );
      diagnostics.push(
        createDiagnostic(
          "dangling-edge",
          "error",
          "关系引用了不存在的卡片",
          `该关系无法展示：${missingParts.join("；")}。`,
          relatedNodeIds,
          [edge.id],
        ),
      );
    }

    if (edge.fromGuidelineId === edge.toGuidelineId) {
      diagnostics.push(
        createDiagnostic(
          "self-loop",
          "error",
          "发现自环关系",
          "一条指导卡片不应通过同一种关系指向自身，请核对关系定义。",
          graph.nodeById.has(edge.fromGuidelineId) ? [edge.fromGuidelineId] : [],
          [edge.id],
        ),
      );
    }
  });

  const edgesByCanonicalId = new Map<string, GuidanceGraphEdge[]>();
  graph.edges.forEach((edge) => {
    const group = edgesByCanonicalId.get(edge.canonicalId) ?? [];
    group.push(edge);
    edgesByCanonicalId.set(edge.canonicalId, group);
  });
  edgesByCanonicalId.forEach((duplicates) => {
    if (duplicates.length <= 1) {
      return;
    }
    const first = duplicates[0];
    diagnostics.push(
      createDiagnostic(
        "duplicate-edge",
        "error",
        "发现完全重复的关系",
        "同一起点、终点和关系类型出现了多次，数据库联合主键也不允许这种重复。",
        [first.fromGuidelineId, first.toGuidelineId].filter((nodeId) => graph.nodeById.has(nodeId)),
        duplicates.map((edge) => edge.id),
      ),
    );
  });

  const isolatedNodeIds: string[] = [];
  graph.nodes.forEach((node) => {
    if (node.incomingEdgeIds.length + node.outgoingEdgeIds.length === 0) {
      isolatedNodeIds.push(node.id);
      diagnostics.push(
        createDiagnostic(
          "isolated-node",
          "info",
          "发现孤立指导卡片",
          `“${node.title}”没有任何可渲染的入边或出边。孤立不一定错误，但值得确认它是否应加入知识图。`,
          [node.id],
          [],
        ),
      );
    }

    if (node.kind === "workflow" && node.outgoingEdgeIds.length === 0) {
      diagnostics.push(
        createDiagnostic(
          "workflow-without-outgoing",
          "warning",
          "流程卡片没有出边",
          `“${node.title}”是流程类型，但没有连接到下一步、包含项或前置项。`,
          [node.id],
          [],
        ),
      );
    }

    if (!node.basisNote?.trim()) {
      diagnostics.push(
        createDiagnostic(
          "missing-basis-note",
          "warning",
          "指导卡片缺少形成依据",
          `“${node.title}”没有 basisNote，维护者难以回到资料或讨论中核对其来源。`,
          [node.id],
          [],
        ),
      );
    }

    if (node.suggestedActions.length === 0) {
      diagnostics.push(
        createDiagnostic(
          "missing-suggested-actions",
          "warning",
          "指导卡片缺少建议动作",
          `“${node.title}”没有可展示的后续建议。`,
          [node.id],
          [],
        ),
      );
    }

    if (node.kind === "rule" && node.isMandatory && !hasValidCondition(node.appliesWhen)) {
      diagnostics.push(
        createDiagnostic(
          "mandatory-rule-without-condition",
          "warning",
          "强制规则缺少有效适用条件",
          `“${node.title}”被标记为强制规则，但没有可用的 appliesWhen 条件。`,
          [node.id],
          [],
        ),
      );
    }
  });

  graph.renderableEdges
    .filter((edge) => edge.relationType === "requires")
    .forEach((edge) => {
      const source = graph.nodeById.get(edge.fromGuidelineId);
      const target = graph.nodeById.get(edge.toGuidelineId);
      if (source?.status === "published" && target?.status === "draft") {
        diagnostics.push(
          createDiagnostic(
            "published-requires-draft",
            "warning",
            "已发布卡片依赖草稿卡片",
            `“${source.title}”已发布，但其前置卡片“${target.title}”仍是草稿。`,
            [source.id, target.id],
            [edge.id],
          ),
        );
      }
    });

  findRequiresCycles(graph).forEach((cycleNodeIds) => {
    const cycleEdges = getCycleEdges(graph, cycleNodeIds);
    diagnostics.push(
      createDiagnostic(
        "requires-cycle",
        "error",
        "前置关系形成循环",
        "这些卡片通过 requires 关系互相依赖，无法确定一个无循环的前置顺序。",
        cycleNodeIds,
        cycleEdges.map((edge) => edge.id),
      ),
    );
  });

  const diagnosticsBySeverity: Record<GuidanceDiagnosticSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  diagnostics.forEach((diagnostic) => {
    diagnosticsBySeverity[diagnostic.severity] += 1;
  });

  return {
    diagnostics: diagnostics.sort((left, right) => left.id.localeCompare(right.id, "zh-CN")),
    diagnosticsBySeverity,
    structureWarningCount: diagnosticsBySeverity.error + diagnosticsBySeverity.warning,
    isolatedNodeIds,
  };
}
