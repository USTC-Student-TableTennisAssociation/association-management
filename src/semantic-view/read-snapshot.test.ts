import { describe, expect, it } from "vitest";

import { createSemanticViewReferenceRegistry } from "@/semantic-view/read-snapshot";
import type { SemanticViewState } from "@/semantic-view/types";

function viewState(): SemanticViewState {
  return {
    viewKey: "society_information",
    viewLabel: "社团信息",
    viewDescription: "正式社团信息",
    compilationId: "compilation-1",
    compatible: true,
    cardTypes: [{
      key: "SocietyCard",
      label: "社团",
      meaning: "社团本身",
      seedContentDimensions: ["社团星级", "成立时间"],
      slots: [{
        key: "advisor",
        label: "指导老师",
        meaning: "正式指导关系",
        cardinality: "many",
        allowedTargetCardTypes: ["PersonCard"],
      }],
    }],
    cards: [{
      id: "card-1",
      viewKey: "society_information",
      cardTypeKey: "SocietyCard",
      cardTypeLabel: "社团",
      objectId: "object-1",
      objectName: "测试社团",
      seedContentDimensions: ["社团星级", "成立时间"],
      contentDimensions: [{
        id: "dimension-1",
        name: "社团星级",
        contentMarkdown: "四星",
      }],
      slots: [{
        key: "advisor",
        label: "指导老师",
        meaning: "正式指导关系",
        cardinality: "many",
        targets: [],
      }],
    }],
  };
}

describe("Semantic View read snapshot", () => {
  it("returns a full snapshot with explicit missing dimensions and empty slots", () => {
    const registry = createSemanticViewReferenceRegistry();
    const snapshot = registry.buildSnapshot(viewState());

    expect(snapshot.isFullSnapshot).toBe(true);
    expect(snapshot.cards[0].contentDimensions).toEqual([
      expect.objectContaining({ name: "社团星级", contentMarkdown: "四星", isMissing: false }),
      expect.objectContaining({ name: "成立时间", contentMarkdown: null, isMissing: true }),
    ]);
    expect(snapshot.cards[0].slots[0]).toMatchObject({
      key: "advisor",
      targets: [],
    });
  });

  it("only emits real V refs used by the final answer", () => {
    const registry = createSemanticViewReferenceRegistry();
    const snapshot = registry.buildSnapshot(viewState());
    const dimensionRef = snapshot.cards[0].contentDimensions[0].ref;

    expect(registry.citedReferences(`正式状态是四星 [${dimensionRef}]，伪造 [V999]。`))
      .toEqual({
        references: [expect.objectContaining({ ref: dimensionRef })],
      });
  });
});
