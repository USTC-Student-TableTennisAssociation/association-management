import { describe, expect, it } from "vitest";

import {
  handbookGuidelineIds,
  handbookGuidelineLinks,
  handbookGuidelines,
} from "../../../prisma/handbook-guidance.data";
import {
  buildGuidanceAiContext,
  parseGuidanceAiExplanation,
} from "./guidance-ai";
import { buildGuidanceGraph } from "./guidance-graph";
import { buildGuidanceTree } from "./guidance-tree";

describe("指导层 AI 上下文", () => {
  it("聚焦节点时只收集树路径、直接子节点和直接关系端点", () => {
    const graph = buildGuidanceGraph(handbookGuidelines, handbookGuidelineLinks);
    const tree = buildGuidanceTree(graph);
    const workflow = graph.nodeById.get(handbookGuidelineIds.largeEventWorkflow);
    const unrelated = graph.nodes.find((node) => node.title.includes("新干事"));

    expect(workflow).toBeDefined();
    const context = buildGuidanceAiContext(graph, tree, workflow?.id ?? null);
    const contextNodeIds = new Set(context.nodes.map((node) => node.id));

    expect(context.focusNodeId).toBe(workflow?.id);
    expect(context.nodes.length).toBeGreaterThan(1);
    expect(contextNodeIds.has(unrelated?.id ?? "")).toBe(false);
    expect(context.edges.every((edge) => contextNodeIds.has(edge.fromGuidelineId) && contextNodeIds.has(edge.toGuidelineId))).toBe(true);
  });

  it("解析结构化解释时过滤不存在的节点引用", () => {
    const explanation = parseGuidanceAiExplanation(
      `\`\`\`json
      {
        "summary": "这是一个流程解释。",
        "readingOrder": [{ "text": "先看审批规则", "nodeIds": ["known", "invented"] }],
        "mandatoryPoints": [{ "text": "无有效引用", "nodeIds": ["invented"] }],
        "cautions": [],
        "unresolved": ["缺少活动日期"]
      }
      \`\`\``,
      new Set(["known"]),
    );

    expect(explanation?.readingOrder).toEqual([{ text: "先看审批规则", nodeIds: ["known"] }]);
    expect(explanation?.mandatoryPoints).toEqual([]);
    expect(explanation?.unresolved).toEqual(["缺少活动日期"]);
  });

  it("拒绝无法解析或缺少摘要的模型输出", () => {
    expect(parseGuidanceAiExplanation("不是 JSON", new Set())).toBeNull();
    expect(parseGuidanceAiExplanation('{"readingOrder": []}', new Set())).toBeNull();
  });
});
