import { describe, expect, it } from "vitest";

import {
  handbookGuidelineIds,
  handbookGuidelineLinks,
  handbookGuidelines,
} from "../../../prisma/handbook-guidance.data";
import { analyzeGuidanceGraph } from "./guidance-analysis";
import { getFocusedPositions } from "./guidance-focus";
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
  it("从细化后的当前种子构建全部节点、关系和去重后的直接邻居", () => {
    const graph = buildGuidanceGraph(handbookGuidelines, handbookGuidelineLinks);
    const largeWorkflow = handbookGuidelines.find((node) => node.id === handbookGuidelineIds.largeEventWorkflow);

    expect(graph.nodes).toHaveLength(Object.values(handbookGuidelineIds).length);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(60);
    expect(graph.edges).toHaveLength(handbookGuidelineLinks.length);
    expect(graph.edges.length).toBeGreaterThanOrEqual(100);
    expect(graph.renderableEdges).toHaveLength(handbookGuidelineLinks.length);
    expect(largeWorkflow).toBeDefined();

    const workflowNode = graph.nodeById.get(largeWorkflow?.id ?? "");
    expect(workflowNode?.outgoingEdgeIds).toHaveLength(7);
    expect(workflowNode?.directNeighborIds).toHaveLength(8);
  });

  it("能查询节点的一度和二度邻居，同时安全处理未知节点", () => {
    const graph = buildGuidanceGraph(handbookGuidelines, handbookGuidelineLinks);
    const largeWorkflow = handbookGuidelines.find((node) => node.id === handbookGuidelineIds.largeEventWorkflow);
    const regularActivity = handbookGuidelines.find((node) => node.id === handbookGuidelineIds.regularActivityT3Submission);

    expect(largeWorkflow).toBeDefined();
    expect(regularActivity).toBeDefined();

    const neighbors = getGuidelineNeighbors(graph, largeWorkflow?.id ?? "");
    expect(neighbors?.firstDegreeNodeIds).toHaveLength(8);
    expect(neighbors?.secondDegreeNodeIds).toContain(regularActivity?.id);
    expect(getGuidelineNeighbors(graph, "不存在的节点")).toBeNull();
  });

  it("聚焦时保持关联节点的基础位置，只轻推无关节点", () => {
    const graph = buildGuidanceGraph(
      [createNode("selected"), createNode("first"), createNode("second"), createNode("unrelated")],
      [createLink("selected", "first"), createLink("first", "second")],
    );
    const neighbors = getGuidelineNeighbors(graph, "selected");
    expect(neighbors).not.toBeNull();
    if (!neighbors) {
      return;
    }

    const basePositions = {
      selected: { x: 0, y: 0 },
      first: { x: 100, y: 0 },
      second: { x: 200, y: 0 },
      unrelated: { x: 300, y: 0 },
    };
    const focusedPositions = getFocusedPositions(graph, basePositions, "selected", neighbors);

    expect(focusedPositions.selected).toEqual(basePositions.selected);
    expect(focusedPositions.first).toEqual(basePositions.first);
    expect(focusedPositions.second).toEqual(basePositions.second);
    expect(focusedPositions.unrelated.x).toBeGreaterThan(basePositions.unrelated.x);
    expect(focusedPositions.unrelated.x - basePositions.unrelated.x).toBeLessThanOrEqual(18);
  });
});

describe("指导层结构诊断", () => {
  it("细化后的当前种子没有孤立卡片、无出边流程或结构错误", () => {
    const graph = buildGuidanceGraph(handbookGuidelines, handbookGuidelineLinks);
    const codes = analyzeGuidanceGraph(graph).diagnostics.map((diagnostic) => diagnostic.code);

    expect(codes).not.toContain("isolated-node");
    expect(codes).not.toContain("workflow-without-outgoing");
    expect(codes).not.toContain("requires-cycle");
    expect(codes).not.toContain("dangling-edge");
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
