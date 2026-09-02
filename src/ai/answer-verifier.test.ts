import { describe, expect, it } from "vitest";

import {
  buildAnswerRepairPrompt,
  verificationFailureAnswer,
  verifyGroundedAnswer,
} from "@/ai/answer-verifier";
import type { TurnEvidenceContract } from "@/evidence/turn-context";

function contract(
  overrides: Partial<TurnEvidenceContract> = {},
): TurnEvidenceContract {
  return {
    targetKind: "general",
    requiresReadableTarget: false,
    targetLocated: false,
    targetReadable: false,
    coverageByScope: [],
    coverageByLayer: {},
    evidenceSemantics: { observations: [], answerability: [] },
    viewStateReads: [],
    viewActionRequested: false,
    knowledgeInventoryObserved: false,
    memoryProvenance: {
      durableWriteCommitted: false,
      actorPrivateMemoryGrounded: false,
    },
    ...overrides,
  };
}

describe("verifyGroundedAnswer", () => {
  it("accepts a View Catalog introduction without state reads", () => {
    expect(verifyGroundedAnswer({
      text: "社团信息负责身份与当前队伍；活动运营负责任务执行；赛事档案负责比赛届次。",
      contract: contract(),
      validRefs: [],
    })).toEqual({ accepted: true, violations: [], warnings: [] });
  });

  it("keeps multiple View absence observations scoped and does not replace prose", () => {
    const result = verifyGroundedAnswer({
      text: "三个 View 的定义彼此独立；本轮读取的三个目标目前都没有匹配 Card。[V1][V2][V3]",
      contract: contract({
        targetKind: "view_state",
        viewStateReads: [
          { ref: "V1", viewKey: "one", viewLabel: "一", totalCardCount: 0, targetLabels: ["甲"], matchedCardCount: 0, contentPresence: "absent", observationComplete: true },
          { ref: "V2", viewKey: "two", viewLabel: "二", totalCardCount: 0, targetLabels: ["乙"], matchedCardCount: 0, contentPresence: "absent", observationComplete: true },
          { ref: "V3", viewKey: "three", viewLabel: "三", totalCardCount: 0, targetLabels: ["丙"], matchedCardCount: 0, contentPresence: "absent", observationComplete: true },
        ],
      }),
      validRefs: ["V1", "V2", "V3"],
    });

    expect(result).toEqual({ accepted: true, violations: [], warnings: [] });
  });

  it("reports the exact claim using an unknown reference", () => {
    const result = verifyGroundedAnswer({
      text: "第一句有证据。[V1] 第二句引用错误。[V9] 第三句仍然有用。",
      contract: contract(),
      validRefs: ["V1"],
    });

    expect(result.accepted).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        code: "unknown_reference",
        excerpt: expect.stringContaining("第二句引用错误"),
        refs: ["V9"],
      }),
    ]);
  });

  it("requires a real View reference after current state was read", () => {
    const result = verifyGroundedAnswer({
      text: "周常训练当前处于进行中。",
      contract: contract({
        targetKind: "view_state",
        viewStateReads: [{
          ref: "V1",
          viewKey: "activity_operations",
          viewLabel: "活动运营",
          totalCardCount: 1,
          targetLabels: ["周常训练"],
          matchedCardCount: 1,
          contentPresence: "present",
          observationComplete: true,
        }],
      }),
      validRefs: ["V1", "V2"],
    });

    expect(result).toMatchObject({
      accepted: false,
      violations: [expect.objectContaining({ code: "view_state_without_reference" })],
    });
  });

  it("asks a repair step to preserve unrelated valid content", () => {
    const verification = verifyGroundedAnswer({
      text: "有效内容。[V1] 错误内容。[V9]",
      contract: contract(),
      validRefs: ["V1"],
    });
    const prompt = buildAnswerRepairPrompt({
      originalText: "有效内容。[V1] 错误内容。[V9]",
      verification,
      contract: contract(),
      validRefs: ["V1"],
    });

    expect(prompt).toContain("保留所有不受影响");
    expect(prompt).toContain("V1");
    expect(prompt).toContain("V9");
    expect(verificationFailureAnswer(verification)).toContain("本轮未完成");
  });
});
