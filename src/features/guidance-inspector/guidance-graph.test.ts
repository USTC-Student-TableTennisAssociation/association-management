import { describe, expect, it } from "vitest";

import {
  handbookGuidelineLinks,
  handbookGuidelines,
} from "../../../prisma/handbook-guidance.data";
import { analyzeGuidanceGraph } from "./guidance-analysis";
import { buildGuidanceGraph, getGuidelineNeighbors } from "./guidance-graph";
import type { GuidanceGraphLinkInput, GuidanceGraphNodeInput } from "./guidance-types";

function createNode(
  id: string,
  overrides: Partial<GuidanceGraphNodeInput> = {},
): GuidanceGraphNodeInput {
  return {
    id,
    title: id,
    kind: "rule",
    status: "draft",
    isMandatory: false,
    contentMarkdown: "说明",
    appliesWhen: { field: "activity.type", operator: "eq", value: "large_tournament" },
    suggestedActions: [
      {
        type: "show_checklist",
        title: "查看检查表",
      },
    ],
    basisNote: "测试依据",
    ...overrides,
  };
}

function createLink(
  fromGuidelineId: string,
  toGuidelineId: string,
  relationType: GuidanceGraphLinkInput["relationType"] = "contains",
): GuidanceGraphLinkInput {
  return {
    fromGuidelineId,
    toGuidelineId,
    relationType,
    note: "测试关系",
  };
}

describe("指导层图数据适配", () => {
  it("从当前种子构建全部节点、关系和去重后的直接邻居", () => {
    const graph = buildGuidanceGraph(handbookGuidelines, handbookGuidelineLinks);
    const largeWorkflow = handbookGuidelines.find((node) => node.title === "大型赛事四阶段筹备流程");

    expect(graph.nodes).toHaveLength(12);
    expect(graph.edges).toHaveLength(12);
    expect(graph.renderableEdges).toHaveLength(12);
    expect(largeWorkflow).toBeDefined();

    const workflowNode = graph.nodeById.get(largeWorkflow?.id ?? "");
    expect(workflowNode?.outgoingEdgeIds).toHaveLength(6);
    expect(workflowNode?.directNeighborIds).toHaveLength(6);
  });

  it("能查询节点的一度和二度邻居，同时安全处理未知节点", () => {
    const graph = buildGuidanceGraph(handbookGuidelines, handbookGuidelineLinks);
    const largeWorkflow = handbookGuidelines.find((node) => node.title === "大型赛事四阶段筹备流程");
    const regularActivity = handbookGuidelines.find((node) => node.title.includes("常规活动"));

    expect(largeWorkflow).toBeDefined();
    expect(regularActivity).toBeDefined();

    const neighbors = getGuidelineNeighbors(graph, largeWorkflow?.id ?? "");
    expect(neighbors?.firstDegreeNodeIds).toHaveLength(6);
    expect(neighbors?.secondDegreeNodeIds).toContain(regularActivity?.id);
    expect(getGuidelineNeighbors(graph, "不存在的节点")).toBeNull();
  });
});

describe("指导层结构诊断", () => {
  it("对当前种子报告孤立卡片和无出边流程", () => {
    const graph = buildGuidanceGraph(handbookGuidelines, handbookGuidelineLinks);
    const codes = analyzeGuidanceGraph(graph).diagnostics.map((diagnostic) => diagnostic.code);

    expect(codes).toContain("isolated-node");
    expect(codes).toContain("workflow-without-outgoing");
  });

  it("覆盖异常边、缺失内容、发布依赖草稿和 requires 循环", () => {
    const nodes = [
      createNode("workflow", { kind: "workflow", suggestedActions: [] }),
      createNode("isolated"),
      createNode("mandatory", {
        isMandatory: true,
        appliesWhen: { all: [] },
      }),
      createNode("published", { status: "published" }),
      createNode("draft"),
      createNode("cycle-a"),
      createNode("cycle-b"),
      createNode("no-basis", { basisNote: null }),
      createNode("no-actions", { suggestedActions: [] }),
    ];
    const links = [
      createLink("published", "missing"),
      createLink("draft", "draft", "exception"),
      createLink("published", "draft", "requires"),
      createLink("published", "draft", "requires"),
      createLink("cycle-a", "cycle-b", "requires"),
      createLink("cycle-b", "cycle-a", "requires"),
    ];

    const analysis = analyzeGuidanceGraph(buildGuidanceGraph(nodes, links));
    const codes = analysis.diagnostics.map((diagnostic) => diagnostic.code);

    [
      "dangling-edge",
      "self-loop",
      "duplicate-edge",
      "isolated-node",
      "workflow-without-outgoing",
      "missing-basis-note",
      "missing-suggested-actions",
      "mandatory-rule-without-condition",
      "published-requires-draft",
      "requires-cycle",
    ].forEach((code) => expect(codes).toContain(code));
  });
});
