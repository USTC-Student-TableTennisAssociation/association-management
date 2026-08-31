import { describe, expect, it } from "vitest";

import {
  auditGroundedAnswer,
  GroundingState,
  type GroundingContract,
} from "@/ai/grounding-gates";
import { describeViewContextEvidence } from "@/agent-runtime/view-context";

function contract(overrides: Partial<GroundingContract> = {}): GroundingContract {
  return {
    targetKind: "general",
    businessViewActionRequested: false,
    requiresReadableTarget: false,
    targetLocated: false,
    targetReadable: false,
    coverageByLayer: {},
    evidenceSemantics: { observations: [], answerability: [] },
    memoryProvenance: {
      durableWriteCommitted: false,
      actorPrivateMemoryGrounded: false,
    },
    ...overrides,
  };
}

function emptyBusinessContext(targetHints: string[]) {
  const view = {
    ref: "V1",
    viewKey: "activity_operations",
    viewLabel: "Activity Operations",
    totalCardCount: 0,
  };
  const relevantCards: [] = [];
  return {
    view,
    targetHints,
    relevantCards,
    coverage: {
      level: "complete" as const,
      missingAspects: [],
      observationComplete: true,
      contentPresence: "absent" as const,
    },
    semantics: describeViewContextEvidence({
      viewKey: view.viewKey,
      viewLabel: view.viewLabel,
      viewRef: view.ref,
      totalCardCount: view.totalCardCount,
      targetHints,
      relevantCards,
      references: [],
      unresolvedAspects: [],
    }),
  };
}

describe("grounding gates", () => {
  it("accepts exact inventory claims only after the structured inventory tool ran", () => {
    const state = new GroundingState("这个环境里有多少知识？");
    state.observeKnowledgeInventory();
    const text = "Shared Brain 有 1 个 Object、0 条 Assertion；资料库有 0 个文件。";

    expect(auditGroundedAnswer({
      text,
      contract: state.contract(),
      validRefs: [],
    })).toEqual({ text, changed: false, mode: "passed", issues: [] });
  });

  it("does not require document content for a Library inventory question", () => {
    const state = new GroundingState("当前资料库有哪些文件？");
    expect(state.contract().requiresReadableTarget).toBe(false);
  });

  it("replaces document analysis when the exact target was not read", () => {
    const state = new GroundingState("请分析当前操作手册为什么这么复杂");
    state.observeArtifactSearch({
      queryTitle: "操作手册",
      purpose: "analyze",
      ref: "F1",
      items: [{
        nodeId: "related",
        name: "报名材料清单.docx",
        matchKind: "title_contains",
        ref: "F2",
      }],
    });

    const result = auditGroundedAnswer({
      text: "当前手册复杂的主要原因是步骤太多，并且包含五张申请表。",
      contract: state.contract(),
      validRefs: ["F1", "F2"],
    });

    expect(result.changed).toBe(true);
    expect(result.issues).toContain("target_not_readable");
    expect(result.text).toContain("不能替代目标正文");
    expect(result.text).toContain("[F1]");
    expect(result.text).not.toContain("五张申请表");
  });

  it("allows cited analysis after the exact target knowledge was read", () => {
    const state = new GroundingState("请分析当前操作手册");
    state.observeArtifactSearch({
      queryTitle: "操作手册",
      purpose: "analyze",
      ref: "F1",
      items: [{
        nodeId: "target",
        name: "操作手册.docx",
        matchKind: "exact_title",
        ref: "F2",
      }],
    });
    state.observeArtifactKnowledge({
      nodeId: "target",
      assertionCount: 2,
      coverage: { level: "complete", missingAspects: [] },
    });

    const result = auditGroundedAnswer({
      text: "手册明确要求先提交申请，再进行审批。[A1]",
      contract: state.contract(),
      validRefs: ["F1", "F2", "A1"],
    });

    expect(result).toEqual({
      text: "手册明确要求先提交申请，再进行审批。[A1]",
      changed: false,
      mode: "passed",
      issues: [],
    });
  });

  it("annotates a complete-sounding answer when coverage is partial", () => {
    const result = auditGroundedAnswer({
      text: "结论是流程已经完整覆盖全部场景。[A1]",
      contract: contract({
        targetKind: "shared_brain",
        coverageByLayer: {
          shared_brain: { level: "partial", missingAspects: ["当前版本正文"] },
        },
      }),
      validRefs: ["A1"],
    });

    expect(result.changed).toBe(true);
    expect(result.issues).toContain("coverage_boundary_missing");
    expect(result.text).toContain("当前版本正文");
    expect(result.text).toContain("结论是流程已经完整覆盖全部场景");
    expect(result.mode).toBe("annotated");
  });

  it("blocks citations that were never registered in this turn", () => {
    const result = auditGroundedAnswer({
      text: "该结论来自正式视图。[V3]",
      contract: contract(),
      validRefs: ["V1"],
    });

    expect(result.changed).toBe(true);
    expect(result.issues).toContain("unknown_refs:V3");
    expect(result.text).not.toContain("该结论来自正式视图");
  });

  it("does not guess claim semantics from prose while still validating references", () => {
    const result = auditGroundedAnswer({
      text: "资料库里存在当前手册，处理档位是 deep。[V1]",
      contract: contract(),
      validRefs: ["V1", "F1"],
    });

    expect(result).toEqual({
      text: "资料库里存在当前手册，处理档位是 deep。[V1]",
      changed: false,
      mode: "passed",
      issues: [],
    });
  });

  it("derives the Business View target from the structured tool observation", () => {
    const state = new GroundingState(
      "我说的是业务视角的操作手册",
    );
    expect(state.contract().targetKind).toBe("general");

    state.observeBusinessContext(emptyBusinessContext(["操作手册"]));

    expect(state.contract().targetKind).toBe("business_view");
    expect(state.contract().requiresReadableTarget).toBe(false);
  });

  it("does not turn a playbook-page affordance question into a Business View target", () => {
    const state = new GroundingState(
      "操作建议可以写更多细节吗？",
      {
        activeViewKey: "activity_operations",
        activePresentation: "inspector",
        activeObjectName: "校内场地申请操作指南",
      },
    );

    expect(state.contract().targetKind).toBe("general");
    const text = "可以。操作建议的说明性细节可以放在 ContentDimension 中。";
    expect(auditGroundedAnswer({
      text,
      contract: state.contract(),
      validRefs: [],
    })).toEqual({ text, changed: false, mode: "passed", issues: [] });
  });

  it("does not infer a Business View target from user phrasing alone", () => {
    const state = new GroundingState("业务视角里的操作建议可以写细节吗？");
    const text = "可以，说明性细节适合写在 ContentDimension 中。";
    const result = auditGroundedAnswer({
      text,
      contract: state.contract(),
      validRefs: [],
    });

    expect(state.contract().targetKind).toBe("general");
    expect(result).toEqual({ text, changed: false, mode: "passed", issues: [] });
  });

  it("does not leak a prior View target into an unrelated new question", () => {
    const state = new GroundingState(
      "当前资料库有哪些文件？",
    );
    expect(state.contract().targetKind).toBe("general");
  });

  it("turns a completely observed empty View into a deterministic negative answer", () => {
    const state = new GroundingState("你看不到业务视角吗？");
    state.observeBusinessContext(emptyBusinessContext([
      "校内场地申请操作手册",
      "场地申请",
    ]));

    const result = auditGroundedAnswer({
      text: "本轮证据不足，请继续检索。",
      contract: state.contract(),
      validRefs: ["V1"],
    });

    expect(result.mode).toBe("deterministic_answer");
    expect(result.text).toContain("我能看到 Activity Operations 业务视角");
    expect(result.text).toContain("当前共有 0 个 Card");
    expect(result.text).toContain("[V1]");
    expect(result.text).not.toContain("请继续检索");
  });

  it("normalizes an empty-View answer from structured state without phrase matching", () => {
    const state = new GroundingState("业务视角里写清楚了吗？");
    state.observeBusinessContext(emptyBusinessContext(["校内场地申请"]));
    const text = "我能看到业务视角，但目前没有匹配的正式 Card，因此不存在可评价清晰度的既有条目。[V1]";

    const result = auditGroundedAnswer({
      text,
      contract: state.contract(),
      validRefs: ["V1"],
    });

    expect(result.mode).toBe("deterministic_answer");
    expect(result.issues).toContain("business_view_absence_normalized");
    expect(result.text).toContain("当前共有 0 个 Card");
    expect(result.text).toContain("[V1]");
  });

  it("does not let Shared Brain coverage overwrite an authoritative empty View", () => {
    const state = new GroundingState("业务视角里写清楚了吗？");
    state.observeBusinessContext(emptyBusinessContext(["校内场地申请"]));
    state.observeCoverage("shared_brain", {
      level: "insufficient",
      missingAspects: ["目标 Object 没有可用 Assertion"],
      observationComplete: true,
      contentPresence: "absent",
    });

    const contract = state.contract();
    expect(contract.coverageByLayer.business_view?.level).toBe("complete");
    expect(contract.coverageByLayer.shared_brain?.level).toBe("insufficient");
    const result = auditGroundedAnswer({
      text: "相关资料显示流程非常复杂。[A1]",
      contract,
      validRefs: ["V1", "A1"],
    });
    expect(result.mode).toBe("deterministic_answer");
    expect(result.text).toContain("尚未作为正式业务条目收录");
    expect(result.text).not.toContain("流程非常复杂");
  });

  it("derives memory claim boundaries from structured write events", () => {
    const state = new GroundingState("记住这个私人约定");
    expect(state.contract().memoryProvenance).toEqual({
      durableWriteCommitted: false,
      actorPrivateMemoryGrounded: false,
    });
    expect(state.instruction()).toContain("本轮尚未观察到同步写入成功");
    expect(state.instruction()).toContain("当前没有可验证的 Actor 私有 Higher Memory");

    state.observeDurableMemoryWrite();
    state.observeActorPrivateMemory();

    expect(state.contract().memoryProvenance).toEqual({
      durableWriteCommitted: true,
      actorPrivateMemoryGrounded: true,
    });
    expect(state.instruction()).toContain("本轮已观察到同步写入成功");
    expect(state.instruction()).toContain("当前 Actor 已有可验证的私有 Higher Memory");
  });

  it("does not confuse a completed Business View save with a memory commitment", () => {
    const text = "我已保存活动 Card，并生成了对应的正式业务状态。";
    expect(auditGroundedAnswer({
      text,
      contract: contract(),
      validRefs: [],
    })).toEqual({ text, changed: false, mode: "passed", issues: [] });
  });

  it("does not replace a Business View action result with the empty-state answer", () => {
    const state = new GroundingState("请帮我在业务视角里创建这个条目");
    state.observeBusinessContext(emptyBusinessContext(["场地申请"]));
    state.observeBusinessViewActionRequest();

    expect(state.contract().businessViewActionRequested).toBe(true);
    const result = auditGroundedAnswer({
      text: "已生成待审批 Proposal。",
      contract: state.contract(),
      validRefs: ["V1"],
    });
    expect(result).toEqual({
      text: "已生成待审批 Proposal。",
      changed: false,
      mode: "passed",
      issues: [],
    });
  });
});
