import { describe, expect, it } from "vitest";

import {
  ACTIVITY_PLAYBOOK_STARTER_NAMES,
  activityPlaybookActionSchema,
  activityPlaybookEditorSchema,
  buildActivityPlaybooks,
  guideNodeEditorSchema,
} from "@/semantic-view/activity-playbook";
import { ACTIVITY_PLAYBOOK_STARTERS } from "@/semantic-view/activity-playbook-service";
import type { SemanticViewCard, SemanticViewState } from "@/semantic-view/types";

const playbookId = "11111111-1111-4111-8111-111111111111";
const decisionId = "22222222-2222-4222-8222-222222222222";
const venueId = "33333333-3333-4333-8333-333333333333";
const submitId = "44444444-4444-4444-8444-444444444444";

function dimension(name: string, contentMarkdown: string) {
  return { id: `${name}-${contentMarkdown}`, name, contentMarkdown };
}

function target(cardId: string, objectName: string) {
  return {
    cardId,
    viewKey: "activity_operations" as const,
    cardTypeKey: "GuideNodeCard",
    objectName,
  };
}

function card(input: Pick<SemanticViewCard, "id" | "cardTypeKey" | "objectName"> &
  Partial<SemanticViewCard>): SemanticViewCard {
  return {
    viewKey: "activity_operations",
    cardTypeLabel: input.cardTypeKey,
    seedContentDimensions: [],
    contentDimensions: [],
    slots: [],
    ...input,
  };
}

function view(cards: SemanticViewCard[]): SemanticViewState {
  return {
    viewKey: "activity_operations",
    viewLabel: "Activity Operations",
    viewDescription: "",
    compilationId: null,
    compatible: true,
    cardTypes: [],
    cards,
  };
}

describe("Activity Playbook projection", () => {
  it("projects swimlanes, natural-language guidance, and yes/no navigation", () => {
    const result = buildActivityPlaybooks(view([
      card({
        id: playbookId,
        cardTypeKey: "ActivityPlaybookCard",
        objectName: "活动筹备",
        contentDimensions: [
          dimension("名称", "活动筹备操作手册"),
          dimension("简介", "用于理解，不用于打卡。"),
          dimension("泳道顺序", "项目负责人\n行政与资源\n二课系统"),
        ],
        slots: [
          {
            key: "nodes", label: "指南节点", meaning: "", cardinality: "many",
            targets: [target(decisionId, "是否需要场地？"), target(venueId, "申请场地"), target(submitId, "二课申报")],
          },
          {
            key: "start_nodes", label: "起点", meaning: "", cardinality: "many",
            targets: [target(decisionId, "是否需要场地？")],
          },
        ],
      }),
      card({
        id: decisionId,
        cardTypeKey: "GuideNodeCard",
        objectName: "是否需要场地？",
        contentDimensions: [
          dimension("节点类型", "DECISION"),
          dimension("泳道", "行政与资源"),
          dimension("纵向位置", "1"),
          dimension("操作指南", "如需校内场地，请查看申请说明。"),
          dimension("AI 协助说明", "根据 Activity 信息协助准备表单初稿。"),
        ],
        slots: [
          { key: "when_yes", label: "是", meaning: "", cardinality: "one", targets: [target(venueId, "申请场地")] },
          { key: "when_no", label: "否", meaning: "", cardinality: "one", targets: [target(submitId, "二课申报")] },
        ],
      }),
      card({
        id: venueId,
        cardTypeKey: "GuideNodeCard",
        objectName: "申请场地",
        contentDimensions: [dimension("泳道", "行政与资源"), dimension("纵向位置", "2")],
        slots: [{ key: "next", label: "后续", meaning: "", cardinality: "many", targets: [target(submitId, "二课申报")] }],
      }),
      card({
        id: submitId,
        cardTypeKey: "GuideNodeCard",
        objectName: "二课申报",
        contentDimensions: [dimension("泳道", "二课系统"), dimension("纵向位置", "3")],
      }),
    ]));

    expect(result.playbooks[0]).toMatchObject({
      name: "活动筹备操作手册",
      lanes: ["项目负责人", "行政与资源", "二课系统"],
      startNodeCardIds: [decisionId],
    });
    expect(result.playbooks[0].nodes.find((node) => node.cardId === decisionId)).toMatchObject({
      nodeType: "DECISION",
      guide: "如需校内场地，请查看申请说明。",
      aiAssistance: "根据 Activity 信息协助准备表单初稿。",
      paths: { whenYesCardId: venueId, whenNoCardId: submitId },
    });
    expect(result.playbooks[0].edges).toEqual(expect.arrayContaining([
      { sourceCardId: decisionId, targetCardId: venueId, kind: "when_yes", label: "是" },
      { sourceCardId: decisionId, targetCardId: submitId, kind: "when_no", label: "否" },
      { sourceCardId: venueId, targetCardId: submitId, kind: "next", label: "" },
    ]));
  });

  it("keeps guide schemas free of Runtime progress controls", () => {
    const node = guideNodeEditorSchema.parse({
      name: "申请场地",
      nodeType: "ACTION",
      lane: "行政与资源",
      row: 2,
      status: "COMPLETED",
      current: true,
      locked: true,
    });
    const playbook = activityPlaybookEditorSchema.parse({
      name: "活动筹备",
      lanes: ["项目负责人", "行政与资源"],
      progress: 80,
    });

    expect(node).not.toHaveProperty("status");
    expect(node).not.toHaveProperty("current");
    expect(node).not.toHaveProperty("locked");
    expect(playbook).not.toHaveProperty("progress");
  });

  it("ships several internally connected starter maps instead of one giant flow", () => {
    expect(ACTIVITY_PLAYBOOK_STARTERS.map((starter) => starter.name)).toEqual(
      ACTIVITY_PLAYBOOK_STARTER_NAMES,
    );
    expect(ACTIVITY_PLAYBOOK_STARTERS.find((starter) =>
      starter.name === "采购与报销操作指南")?.nodes.map((node) => node.name))
      .toEqual(expect.arrayContaining([
        "确认预算来源与报销条件",
        "取得发票与付款凭证",
        "完成二课结项材料",
        "填写签领表与报销表",
        "提交报销审核",
      ]));

    for (const starter of ACTIVITY_PLAYBOOK_STARTERS) {
      const nodeKeys = starter.nodes.map((node) => node.key);
      const nodeKeySet = new Set(nodeKeys);
      expect(nodeKeySet.size).toBe(nodeKeys.length);
      expect(nodeKeySet.has(starter.startNodeKey)).toBe(true);
      for (const node of starter.nodes) {
        expect(starter.lanes).toContain(node.lane);
        for (const target of [
          ...(node.next ?? []),
          ...(node.yes ? [node.yes] : []),
          ...(node.no ? [node.no] : []),
        ]) {
          expect(nodeKeySet.has(target)).toBe(true);
        }
      }
    }
  });

  it("accepts the idempotent starter installation action", () => {
    expect(activityPlaybookActionSchema.parse({
      type: "INSTALL_STARTER_PLAYBOOKS",
    })).toEqual({ type: "INSTALL_STARTER_PLAYBOOKS" });
  });
});
