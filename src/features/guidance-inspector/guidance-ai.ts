import { getGuidanceTreePath, type GuidanceTree } from "./guidance-tree";
import type {
  GuidanceCondition,
  GuidanceGraph,
  GuidanceKind,
  GuidanceRelationType,
  GuidanceStatus,
  GuidanceSuggestedAction,
} from "./guidance-types";

export type GuidanceAiPoint = {
  text: string;
  nodeIds: readonly string[];
};

export type GuidanceAiExplanation = {
  summary: string;
  readingOrder: readonly GuidanceAiPoint[];
  mandatoryPoints: readonly GuidanceAiPoint[];
  cautions: readonly GuidanceAiPoint[];
  unresolved: readonly string[];
};

export type GuidanceAiContextNode = {
  id: string;
  title: string;
  kind: GuidanceKind;
  status: GuidanceStatus;
  isMandatory: boolean;
  contentMarkdown: string;
  appliesWhen: GuidanceCondition | null;
  suggestedActions: readonly GuidanceSuggestedAction[];
  basisNote: string | null;
};

export type GuidanceAiContextEdge = {
  id: string;
  fromGuidelineId: string;
  toGuidelineId: string;
  relationType: GuidanceRelationType;
  note: string | null;
};

export type GuidanceAiContext = {
  focusNodeId: string | null;
  focusTitle: string;
  pathNodeIds: readonly string[];
  nodes: readonly GuidanceAiContextNode[];
  edges: readonly GuidanceAiContextEdge[];
};

export type GuidanceAiResponse = {
  explanation: GuidanceAiExplanation;
  context: {
    focusNodeId: string | null;
    focusTitle: string;
    nodeCount: number;
  };
};

const maxContextMarkdownLength = 2800;

function addIncidentNodeIds(graph: GuidanceGraph, nodeId: string, nodeIds: Set<string>): void {
  const node = graph.nodeById.get(nodeId);
  if (!node) {
    return;
  }

  [...node.incomingEdgeIds, ...node.outgoingEdgeIds].forEach((edgeId) => {
    const edge = graph.edgeById.get(edgeId);
    if (!edge?.isRenderable) {
      return;
    }
    nodeIds.add(edge.fromGuidelineId);
    nodeIds.add(edge.toGuidelineId);
  });
}

/**
 * 为 AI 构造最小必要上下文。聚焦节点时只读取树路径、直接子节点和直接关系端点；
 * 没有聚焦节点时读取工作流入口及其直接子节点。
 */
export function buildGuidanceAiContext(
  graph: GuidanceGraph,
  tree: GuidanceTree,
  focusNodeId: string | null,
): GuidanceAiContext {
  const contextNodeIds = new Set<string>();
  const focusNode = focusNodeId ? graph.nodeById.get(focusNodeId) : undefined;
  const pathNodeIds = focusNode ? getGuidanceTreePath(tree, focusNode.id) : [];

  if (focusNode) {
    pathNodeIds.forEach((nodeId) => contextNodeIds.add(nodeId));
    (tree.childrenByNodeId.get(focusNode.id) ?? []).forEach((nodeId) => contextNodeIds.add(nodeId));
    addIncidentNodeIds(graph, focusNode.id, contextNodeIds);
  } else {
    tree.rootNodeIds
      .filter((nodeId) => graph.nodeById.get(nodeId)?.kind === "workflow")
      .forEach((nodeId) => {
        contextNodeIds.add(nodeId);
        (tree.childrenByNodeId.get(nodeId) ?? []).forEach((childNodeId) => contextNodeIds.add(childNodeId));
        addIncidentNodeIds(graph, nodeId, contextNodeIds);
      });
  }

  const nodes = graph.nodes
    .filter((node) => contextNodeIds.has(node.id))
    .map((node) => ({
      id: node.id,
      title: node.title,
      kind: node.kind,
      status: node.status,
      isMandatory: node.isMandatory,
      contentMarkdown: node.contentMarkdown.slice(0, maxContextMarkdownLength),
      appliesWhen: node.appliesWhen,
      suggestedActions: node.suggestedActions,
      basisNote: node.basisNote,
    }));
  const includedNodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.renderableEdges
    .filter(
      (edge) =>
        includedNodeIds.has(edge.fromGuidelineId) && includedNodeIds.has(edge.toGuidelineId),
    )
    .map((edge) => ({
      id: edge.id,
      fromGuidelineId: edge.fromGuidelineId,
      toGuidelineId: edge.toGuidelineId,
      relationType: edge.relationType,
      note: edge.note,
    }));

  return {
    focusNodeId: focusNode?.id ?? null,
    focusTitle: focusNode?.title ?? "指导层工作流入口",
    pathNodeIds,
    nodes,
    edges,
  };
}

export const guidanceAiSystemPrompt = `
你是高校学生社团“指导层”的只读解释助手。

你的职责是帮助人理解给定的指导树分支，而不是替人执行任务、修改状态或补写不存在的知识。

必须遵守：
1. 只能依据用户消息中提供的 nodes、edges 和 treePath 回答。
2. 不得声称任务已经完成、审批已经通过、状态已经变化或建议动作已经执行。
3. 不得发明节点、关系、期限、制度或联系人。
4. readingOrder、mandatoryPoints、cautions 中的每一项都必须提供至少一个真实 nodeIds 引用。
5. 如果证据不足，把缺失信息写入 unresolved，不要猜测。
6. 使用简洁、自然的中文。
7. 只返回一个 JSON 对象，不要使用 Markdown 代码围栏，也不要输出 JSON 之外的文字。

返回结构：
{
  "summary": "对当前分支目标和结构的简短解释",
  "readingOrder": [{ "text": "推荐先看什么以及原因", "nodeIds": ["节点ID"] }],
  "mandatoryPoints": [{ "text": "必须遵守的要求", "nodeIds": ["节点ID"] }],
  "cautions": [{ "text": "风险、例外或容易误解的地方", "nodeIds": ["节点ID"] }],
  "unresolved": ["当前知识中无法确认的问题"]
}

readingOrder、mandatoryPoints、cautions 各最多 6 项，unresolved 最多 4 项。
`;

export function buildGuidanceAiUserPrompt(
  context: GuidanceAiContext,
  question: string | null,
): string {
  const task = question?.trim()
    ? `用户问题：${question.trim()}`
    : context.focusNodeId
      ? "请解释当前选中的树分支：它的目标、推荐阅读顺序、强制要求和风险。"
      : "请概览当前指导层的工作流入口，说明人应该从哪里开始阅读。";

  return `${task}\n\n以下是唯一可用的指导知识上下文：\n${JSON.stringify(
    {
      focusNodeId: context.focusNodeId,
      focusTitle: context.focusTitle,
      treePath: context.pathNodeIds,
      nodes: context.nodes,
      edges: context.edges,
    },
    null,
    2,
  )}`;
}

function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1)) as unknown;
  } catch {
    return null;
  }
}

function normalizePointList(
  value: unknown,
  allowedNodeIds: ReadonlySet<string>,
): GuidanceAiPoint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, 6)
    .map((item): GuidanceAiPoint | null => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const candidate = item as Record<string, unknown>;
      const text = typeof candidate.text === "string" ? candidate.text.trim().slice(0, 800) : "";
      const nodeIds = Array.isArray(candidate.nodeIds)
        ? [...new Set(candidate.nodeIds.filter((nodeId): nodeId is string => typeof nodeId === "string" && allowedNodeIds.has(nodeId)))]
        : [];
      return text && nodeIds.length > 0 ? { text, nodeIds } : null;
    })
    .filter((item): item is GuidanceAiPoint => item !== null);
}

export function parseGuidanceAiExplanation(
  rawText: string,
  allowedNodeIds: ReadonlySet<string>,
): GuidanceAiExplanation | null {
  const parsed = extractJsonObject(rawText);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  const summary = typeof candidate.summary === "string" ? candidate.summary.trim().slice(0, 1600) : "";
  if (!summary) {
    return null;
  }

  const unresolved = Array.isArray(candidate.unresolved)
    ? candidate.unresolved
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 500))
        .filter(Boolean)
        .slice(0, 4)
    : [];

  return {
    summary,
    readingOrder: normalizePointList(candidate.readingOrder, allowedNodeIds),
    mandatoryPoints: normalizePointList(candidate.mandatoryPoints, allowedNodeIds),
    cautions: normalizePointList(candidate.cautions, allowedNodeIds),
    unresolved,
  };
}
