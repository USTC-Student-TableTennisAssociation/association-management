import { describe, expect, it } from "vitest";

import {
  handbookGuidelineIds,
  handbookGuidelineLinks,
  handbookGuidelines,
} from "../../../prisma/handbook-guidance.data";
import { buildGuidanceGraph } from "./guidance-graph";
import { buildGuidanceTree, getGuidanceTreePath } from "./guidance-tree";
import type { GuidanceGraphLinkInput, GuidanceGraphNodeInput } from "./guidance-types";

function createNode(id: string, kind: GuidanceGraphNodeInput["kind"] = "rule"): GuidanceGraphNodeInput {
  return {
    id,
    title: id,
    kind,
    status: "draft",
    isMandatory: false,
    contentMarkdown: "说明",
    appliesWhen: null,
    suggestedActions: [],
    basisNote: "测试依据",
  };
}

function createLink(
  fromGuidelineId: string,
  toGuidelineId: string,
  relationType: GuidanceGraphLinkInput["relationType"],
): GuidanceGraphLinkInput {
  return { fromGuidelineId, toGuidelineId, relationType, note: null };
}

describe("指导层树状导航", () => {
  it("使用 contains 构建当前种子的主树，并让活动与持续运营成为两个根节点", () => {
    const graph = buildGuidanceGraph(handbookGuidelines, handbookGuidelineLinks);
    const tree = buildGuidanceTree(graph);
    const activityRoot = graph.nodeById.get(handbookGuidelineIds.activityLifecycle);
    const operationsRoot = graph.nodeById.get(handbookGuidelineIds.organizationOperations);
    const largeWorkflow = graph.nodeById.get(handbookGuidelineIds.largeEventWorkflow);

    expect(activityRoot).toBeDefined();
    expect(operationsRoot).toBeDefined();
    expect(largeWorkflow).toBeDefined();
    expect(tree.rootNodeIds[0] && graph.nodeById.get(tree.rootNodeIds[0])?.kind).toBe("workflow");
    expect(tree.rootNodeIds).toEqual(
      expect.arrayContaining([handbookGuidelineIds.activityLifecycle, handbookGuidelineIds.organizationOperations]),
    );
    expect(tree.childrenByNodeId.get(activityRoot?.id ?? "")).toHaveLength(6);
    expect(tree.childrenByNodeId.get(largeWorkflow?.id ?? "")).toHaveLength(4);
    expect(tree.secondaryContainmentEdgeIds).toHaveLength(0);

    const placedNodeIds = new Set([
      ...tree.rootNodeIds,
      ...[...tree.childrenByNodeId.values()].flatMap((nodeIds) => [...nodeIds]),
    ]);
    expect(placedNodeIds.size).toBe(graph.nodes.length);
  });

  it("使用 next 排列同层节点，同时将多父级和成环 contains 降级为横向引用", () => {
    const graph = buildGuidanceGraph(
      [createNode("root-a", "workflow"), createNode("root-b", "workflow"), createNode("one"), createNode("two")],
      [
        createLink("root-a", "one", "contains"),
        createLink("root-a", "two", "contains"),
        createLink("one", "two", "next"),
        createLink("root-b", "two", "contains"),
        createLink("one", "root-a", "contains"),
      ],
    );
    const tree = buildGuidanceTree(graph);

    expect(tree.childrenByNodeId.get("root-a")).toEqual(["one", "two"]);
    expect(tree.parentByNodeId.get("two")).toBe("root-a");
    expect(tree.secondaryContainmentEdgeIds).toHaveLength(2);
    expect(getGuidanceTreePath(tree, "two")).toEqual(["root-a", "two"]);
  });
});
