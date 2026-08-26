import { describe, expect, it } from "vitest";

import {
  authoritativeBusinessViewObjectIds,
  ensureAuthoritativeViewReconciliation,
  objectUpdatesFromAssertionGraph,
} from "@/memory/knowledge-consolidator";

const objectId = "00000000-0000-4000-8000-000000000001";

function semanticContext() {
  return {
    conversation: [],
    systemInstruction: "",
    modelCalls: [],
    finalAnswer: "",
    toolExecutions: [{
      toolCallId: "tool-1",
      toolName: "openBusinessContext",
      input: {},
      success: true,
      output: {
        formalCardMissing: false,
        relevantCards: [{ relatedObjectIds: [objectId] }],
        semantics: {
          observations: [{
            layer: "business_view",
            predicate: "contains_matching_card",
            status: "present",
            authority: "authoritative",
          }],
        },
      },
    }],
  };
}

describe("Knowledge Consolidator authoritative View reconciliation", () => {
  it("extracts only object ids from a successful authoritative present View read", () => {
    expect(authoritativeBusinessViewObjectIds(semanticContext())).toEqual([objectId]);
    expect(authoritativeBusinessViewObjectIds({
      ...semanticContext(),
      toolExecutions: [{
        ...semanticContext().toolExecutions[0],
        success: false,
      }],
    })).toEqual([]);
  });

  it("forces current-situation and working-set reconciliation when old memory says the formal Card is absent", () => {
    const result = ensureAuthoritativeViewReconciliation({
      semanticContext: semanticContext(),
      objects: [{ ref: "O1", id: objectId, canonicalName: "Echo正式闭环人工测试赛-20260821" }],
      oldObjectMemories: [{
        globalObjectId: objectId,
        cognitiveMemory: {
          identityAndBoundaries: "这是一次测试活动。",
          narrativeAndMeaning: "",
          structuralModel: "",
          operatingModel: "",
          currentSituation: "正式 Activity Operations View 仍为 0 个 Card，卡片尚未审批生效。",
          openQuestions: [],
        },
        operationalIndex: { aspects: [] },
        maintainedAt: new Date("2026-08-21T00:00:00.000Z"),
      }],
      oldAmbientMemories: [{
        scope: "working_set",
        contentMarkdown: "Echo正式闭环人工测试赛-20260821 的正式卡片尚未落地。",
        maintainedAt: "2026-08-21T00:00:00.000Z",
      }],
      result: { objectUpdates: [], ambientUpdates: [] },
    });

    expect(result.objectUpdates).toEqual([expect.objectContaining({
      globalObjectId: objectId,
    })]);
    expect(result.ambientUpdates).toEqual([expect.objectContaining({ scope: "working_set" })]);
  });

  it("derives every Object maintenance candidate directly from Assertion graph links", () => {
    const otherId = "00000000-0000-4000-8000-000000000002";
    const updates = objectUpdatesFromAssertionGraph({
      publishedAssertions: 1,
      publishedAssertionIds: ["assertion-1"],
      affectedObjectIds: [objectId, otherId],
      affectedObjects: [{
        id: objectId,
        canonicalName: "对象一",
        resolution: "existing",
      }, {
        id: otherId,
        canonicalName: "对象二",
        resolution: "existing",
      }],
    });

    expect(updates.map((update) => update.globalObjectId)).toEqual([objectId, otherId]);
    expect(updates.every((update) => update.focus.includes("直接图连接"))).toBe(true);
  });

  it("does not refresh an already reconciled memory on every ordinary read", () => {
    expect(ensureAuthoritativeViewReconciliation({
      semanticContext: semanticContext(),
      objects: [{ ref: "O1", id: objectId, canonicalName: "测试赛" }],
      oldObjectMemories: [{
        globalObjectId: objectId,
        cognitiveMemory: {
          identityAndBoundaries: "这是一次测试活动。",
          narrativeAndMeaning: "",
          structuralModel: "",
          operatingModel: "",
          currentSituation: "正式活动卡片已收录，当前处于筹备阶段。",
          openQuestions: [],
        },
        operationalIndex: { aspects: [] },
        maintainedAt: new Date("2026-08-21T00:00:00.000Z"),
      }],
      oldAmbientMemories: [],
      result: { objectUpdates: [], ambientUpdates: [] },
    })).toEqual({ objectUpdates: [], ambientUpdates: [] });
  });
});
