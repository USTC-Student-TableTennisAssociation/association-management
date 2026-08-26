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
  it("does not require document content for a Library inventory question", () => {
    const state = new GroundingState("当前资料库有哪些文件？");
    expect(state.contract().requiresReadableTarget).toBe(false);
  });

  it("replaces document analysis when the exact target was not read", () => {
    const state = new GroundingState("请分析当前操作手册为什么这么复杂");
    state.observeArtifactSearch({
      queryTitle: "操作手册",
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

  it("removes a Markdown table section when citation redaction removes every data row", () => {
    const result = auditGroundedAnswer({
      text: [
        "已整理活动。",
        "",
        "## 确认后的活动清单",
        "",
        "| 活动 | 频率 |",
        "|---|---|",
        "| 积分赛 | 每周 [A2] |",
        "| 周常训练 | 每周 [A3] |",
        "",
        "## 下一步",
        "",
        "将提交两张活动卡片。",
      ].join("\n"),
      contract: contract(),
      validRefs: ["A1"],
    });

    expect(result.issues).toContain("unknown_refs:A2");
    expect(result.issues).toContain("unknown_refs:A3");
    expect(result.issues).toContain("empty_markdown_table_removed");
    expect(result.text).not.toContain("确认后的活动清单");
    expect(result.text).not.toContain("| 活动 | 频率 |");
    expect(result.text).toContain("## 下一步");
  });

  it("rejects Library metadata claims supported only by a View ref", () => {
    const result = auditGroundedAnswer({
      text: "资料库里存在当前手册，处理档位是 deep。[V1]",
      contract: contract(),
      validRefs: ["V1", "F1"],
    });

    expect(result.changed).toBe(true);
    expect(result.issues).toContain("artifact_claim_without_f_ref");
  });

  it("classifies an explicit business-view clarification as a View target", () => {
    const state = new GroundingState(
      "我说的是业务视角的操作手册",
      undefined,
      [{ role: "user", text: "请分析当前操作手册为什么复杂" }],
    );

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

  it("annotates rather than replaces an explicit View question when the View was not read", () => {
    const state = new GroundingState("业务视角里的操作建议可以写细节吗？");
    const text = "可以，说明性细节适合写在 ContentDimension 中。";
    const result = auditGroundedAnswer({
      text,
      contract: state.contract(),
      validRefs: [],
    });

    expect(result.mode).toBe("annotated");
    expect(result.text).toContain("本轮没有读取正式 Business View");
    expect(result.text).toContain(text);
  });

  it("does not leak a prior View target into an unrelated new question", () => {
    const state = new GroundingState(
      "当前资料库有哪些文件？",
      undefined,
      [{ role: "user", text: "业务视角里写清楚了吗？" }],
    );
    expect(state.contract().targetKind).toBe("artifact");
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

  it("keeps a correctly grounded empty-View answer unchanged", () => {
    const state = new GroundingState("业务视角里写清楚了吗？");
    state.observeBusinessContext(emptyBusinessContext(["校内场地申请"]));
    const text = "我能看到业务视角，但目前没有匹配的正式 Card，因此不存在可评价清晰度的既有条目。[V1]";

    const result = auditGroundedAnswer({
      text,
      contract: state.contract(),
      validRefs: ["V1"],
    });

    expect(result).toEqual({ text, changed: false, mode: "passed", issues: [] });
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

  it("does not replace a Business View action result with the empty-state answer", () => {
    const state = new GroundingState("请帮我在业务视角里创建这个条目");
    state.observeBusinessContext(emptyBusinessContext(["场地申请"]));

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
