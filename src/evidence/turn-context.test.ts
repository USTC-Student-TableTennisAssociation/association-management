import { describe, expect, it } from "vitest";

import { describeViewStateEvidence } from "@/agent-runtime/view-context";
import {
  TurnEvidenceContext,
} from "@/evidence/turn-context";

function emptyViewState(input: {
  ref: string;
  viewKey: string;
  viewLabel: string;
  target: string;
}) {
  const semantics = describeViewStateEvidence({
    viewRef: input.ref,
    viewKey: input.viewKey,
    viewLabel: input.viewLabel,
    totalCardCount: 0,
    targetHints: [input.target],
    relevantCards: [],
    references: [],
    unresolvedAspects: [],
  });
  return {
    view: {
      ref: input.ref,
      viewKey: input.viewKey,
      viewLabel: input.viewLabel,
      totalCardCount: 0,
    },
    targetLabels: [input.target],
    relevantCards: [],
    coverage: {
      level: "complete" as const,
      missingAspects: [],
      observationComplete: true,
      contentPresence: "absent" as const,
    },
    semantics,
  };
}

describe("TurnEvidenceContext", () => {
  it("retains independently scoped reads from multiple Views", () => {
    const context = new TurnEvidenceContext();
    context.observeViewState(emptyViewState({
      ref: "V1",
      viewKey: "society_information",
      viewLabel: "社团信息",
      target: "目标社团",
    }));
    context.observeViewState(emptyViewState({
      ref: "V2",
      viewKey: "activity_operations",
      viewLabel: "活动运营",
      target: "目标活动",
    }));
    context.observeViewState(emptyViewState({
      ref: "V3",
      viewKey: "competition_records",
      viewLabel: "赛事档案",
      target: "目标赛事",
    }));

    const contract = context.contract();
    expect(contract.viewStateReads.map((read) => read.viewKey)).toEqual([
      "society_information",
      "activity_operations",
      "competition_records",
    ]);
    expect(contract.coverageByScope.map((entry) => entry.scope)).toEqual([
      expect.stringContaining("society_information"),
      expect.stringContaining("activity_operations"),
      expect.stringContaining("competition_records"),
    ]);
    expect(contract.evidenceSemantics.observations).toHaveLength(3);
  });

  it("keeps an absent target as server-side scoped evidence", () => {
    const context = new TurnEvidenceContext();
    context.observeViewState(emptyViewState({
      ref: "V1",
      viewKey: "competition_records",
      viewLabel: "赛事档案",
      target: "第十五次积分赛",
    }));

    const contract = context.contract();
    expect(contract.coverageByScope).toEqual([
      expect.objectContaining({
        scope: "view:competition_records:target:第十五次积分赛",
        coverage: expect.objectContaining({ contentPresence: "absent" }),
      }),
    ]);
    expect(contract.evidenceSemantics.observations).toEqual([
      expect.objectContaining({
        predicate: "contains_matching_card",
        status: "absent",
      }),
    ]);
  });

  it("records View-wide Card discovery without treating a partial page as complete", () => {
    const context = new TurnEvidenceContext();
    context.observeViewCardList({
      view: {
        ref: "V1",
        viewKey: "society_information",
        viewLabel: "社团概览",
        totalCardCount: 12,
      },
      matchedCardCount: 12,
      returnedCards: [{ ref: "V2", dimensions: { purpose: "测试" } }],
      coverage: {
        level: "partial",
        missingAspects: ["仍有后续 Card 分页尚未返回。"],
        observationComplete: false,
        contentPresence: "present",
      },
      semantics: {
        observations: [{
          id: "view_cards.society_information.all",
          layer: "business_view",
          scope: "view:society_information:cards:all",
          subject: "社团概览的全部 Card",
          predicate: "lists_cards",
          status: "present",
          completeness: "partial",
          authority: "authoritative",
          refs: ["V1", "V2"],
          summary: "本页只返回一部分。",
        }],
        answerability: [],
      },
    });

    const contract = context.contract();
    expect(contract.viewStateReads).toEqual([
      expect.objectContaining({
        viewKey: "society_information",
        targetLabels: ["整个 View"],
        matchedCardCount: 12,
        observationComplete: false,
      }),
    ]);
    expect(contract.coverageByScope[0]).toMatchObject({
      scope: "view:society_information:cards:all",
      coverage: { level: "partial", observationComplete: false },
    });
  });

  it("keeps durable and private memory provenance independent", () => {
    const context = new TurnEvidenceContext();
    context.observeDurableMemoryWrite();
    context.observeActorPrivateMemory();

    expect(context.contract().memoryProvenance).toEqual({
      durableWriteCommitted: true,
      actorPrivateMemoryGrounded: true,
    });
  });
});
