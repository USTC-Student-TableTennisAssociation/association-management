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

  it("rejects Library metadata claims supported only by a View ref", () => {
    const result = auditGroundedAnswer({
      text: "资料库里存在当前手册，处理档位是 deep。[V1]",
      contract: contract(),
      validRefs: ["V1", "F1"],
    });

    expect(result.changed).toBe(true);
    expect(result.issues).toContain("artifact_claim_without_f_ref");
  });

  it("blocks whole-library absence claims based only on complete title zero hits", () => {
    const result = auditGroundedAnswer({
      text: [
        "检索词“历任会长”返回 0 条标题匹配。[F1]",
        "在 Echo 资料库中，没有找到标题或内容包含“历任会长”或“乒协星火传承录”的文件。[F1][F2]",
        "因此当前资料库中不存在这类资料。[F1]",
        "否则目前资料库中确实没有相关内容。[F1]",
      ].join("\n"),
      contract: contract({
        coverageByLayer: {
          library: {
            level: "complete",
            missingAspects: [],
            observationComplete: true,
            contentPresence: "absent",
          },
        },
        evidenceSemantics: {
          observations: [{
            id: "library.title_search.历任会长",
            layer: "library",
            scope: "title:历任会长",
            subject: "历任会长",
            predicate: "matching_artifact_in_library_index",
            status: "absent",
            completeness: "complete",
            authority: "authoritative",
            refs: ["F1"],
            summary: "完整 Library 标题查询没有匹配到“历任会长”。",
          }],
          answerability: [],
        },
      }),
      validRefs: ["F1"],
    });

    expect(result.changed).toBe(true);
    expect(result.mode).toBe("redacted");
    expect(result.issues).toContain("library_absence_overclaimed_from_title_search");
    expect(result.issues).toContain("library_title_zero_hit_boundary_added");
    expect(result.text).toContain("Library 标题/路径索引查询未匹配到“历任会长” [F1]");
    expect(result.text).toContain("尚未读取或扫描全部文件正文");
    expect(result.text).toContain("返回 0 条标题匹配");
    expect(result.text).not.toContain("没有找到标题或内容包含");
    expect(result.text).not.toContain("不存在这类资料");
    expect(result.text).not.toContain("确实没有相关内容");
  });

  it("does not let the unreadable-target fallback hide complete title zero-hit evidence", () => {
    const result = auditGroundedAnswer({
      text: [
        "“历任会长”与“乒协星火传承录”均未命中标题索引。[F1][F2]",
        "既然索引无匹配，正文层自然也不存在相关内容。[F1][F2]",
      ].join("\n"),
      contract: contract({
        targetKind: "artifact",
        requiresReadableTarget: true,
        targetLabel: "历任会长",
        targetLocated: false,
        targetReadable: false,
        targetSearchRef: "F1",
        evidenceSemantics: {
          observations: [
            {
              id: "library.title_search.历任会长",
              layer: "library",
              scope: "title:历任会长",
              subject: "历任会长",
              predicate: "matching_artifact_in_library_index",
              status: "absent",
              completeness: "complete",
              authority: "authoritative",
              refs: ["F1"],
              summary: "完整 Library 标题查询没有匹配到“历任会长”。",
            },
            {
              id: "library.title_search.乒协星火传承录",
              layer: "library",
              scope: "title:乒协星火传承录",
              subject: "乒协星火传承录",
              predicate: "matching_artifact_in_library_index",
              status: "absent",
              completeness: "complete",
              authority: "authoritative",
              refs: ["F2"],
              summary: "完整 Library 标题查询没有匹配到“乒协星火传承录”。",
            },
          ],
          answerability: [],
        },
      }),
      validRefs: ["F1", "F2"],
    });

    expect(result.issues).toContain("target_not_readable");
    expect(result.issues).toContain("library_title_zero_hit_boundary_added");
    expect(result.text).toContain("未匹配到“历任会长、乒协星火传承录” [F1][F2]");
    expect(result.text).toContain("尚未读取或扫描全部文件正文");
    expect(result.text).not.toContain("请指定准确文件");
    expect(result.text).not.toContain("正文层自然也不存在相关内容");
  });

  it("adds a content-scope boundary even when the title zero-hit wording is cautious", () => {
    const text = "当前 Library 标题索引没有匹配到“乒协星火传承录”。[F2]";
    const result = auditGroundedAnswer({
      text,
      contract: contract({
        evidenceSemantics: {
          observations: [{
            id: "library.title_search.乒协星火传承录",
            layer: "library",
            scope: "title:乒协星火传承录",
            subject: "乒协星火传承录",
            predicate: "matching_artifact_in_library_index",
            status: "absent",
            completeness: "complete",
            authority: "authoritative",
            refs: ["F2"],
            summary: "完整 Library 标题查询没有匹配到“乒协星火传承录”。",
          }],
          answerability: [],
        },
      }),
      validRefs: ["F2"],
    });

    expect(result.changed).toBe(true);
    expect(result.mode).toBe("annotated");
    expect(result.text).toContain("尚未读取或扫描全部文件正文");
    expect(result.text).toContain(text);
  });

  it("preserves a correctly scoped Library title-index zero-hit statement", () => {
    const text = "资料库标题索引没有找到匹配文件。[F1]";
    const result = auditGroundedAnswer({
      text,
      contract: contract({
        evidenceSemantics: {
          observations: [{
            id: "library.title_search.历任会长",
            layer: "library",
            scope: "title:历任会长",
            subject: "历任会长",
            predicate: "matching_artifact_in_library_index",
            status: "absent",
            completeness: "complete",
            authority: "authoritative",
            refs: ["F1"],
            summary: "完整 Library 标题查询没有匹配到“历任会长”。",
          }],
          answerability: [],
        },
      }),
      validRefs: ["F1"],
    });

    expect(result.mode).toBe("annotated");
    expect(result.text).toContain(text);
    expect(result.text).toContain("尚未读取或扫描全部文件正文");
    expect(result.issues).not.toContain("library_absence_overclaimed_from_title_search");
  });

  it("keeps the zero-hit boundary when another title query matched", () => {
    const result = auditGroundedAnswer({
      text: "“协会章程”有标题匹配，但资料库中确实没有“历任会长”的相关内容。[F1][F2]",
      contract: contract({
        evidenceSemantics: {
          observations: [
            {
              id: "library.title_search.协会章程",
              layer: "library",
              scope: "title:协会章程",
              subject: "协会章程",
              predicate: "matching_artifact_in_library_index",
              status: "present",
              completeness: "complete",
              authority: "authoritative",
              refs: ["F1"],
              summary: "Library 标题索引匹配到 1 个与“协会章程”相关的文件。",
            },
            {
              id: "library.title_search.历任会长",
              layer: "library",
              scope: "title:历任会长",
              subject: "历任会长",
              predicate: "matching_artifact_in_library_index",
              status: "absent",
              completeness: "complete",
              authority: "authoritative",
              refs: ["F2"],
              summary: "完整 Library 标题查询没有匹配到“历任会长”。",
            },
          ],
          answerability: [],
        },
      }),
      validRefs: ["F1", "F2"],
    });

    expect(result.mode).toBe("deterministic_answer");
    expect(result.text).toContain("未匹配到“历任会长” [F2]");
    expect(result.text).toContain("尚未读取或扫描全部文件正文");
    expect(result.text).not.toContain("确实没有“历任会长”的相关内容");
  });

  it("does not mistake a cited business critical path for file metadata", () => {
    const text = [
      "**原文证据（[S3]，时间红线与流程卡点）：**",
      "> 关键路径：提交申请 → 挂靠单位审核 → 活动开展 → 财务报销。",
    ].join("\n");
    const result = auditGroundedAnswer({
      text,
      contract: contract(),
      validRefs: ["S3"],
    });

    expect(result).toEqual({
      text,
      changed: false,
      mode: "passed",
      issues: [],
    });
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

  it("removes a stale Higher Memory claim contradicted by an authoritative present View", () => {
    const state = new GroundingState("测试赛的时间、地点和状态是什么？");
    state.observeBusinessContext({
      view: {
        ref: "V1",
        viewKey: "activity_operations",
        viewLabel: "Activity Operations",
        totalCardCount: 1,
      },
      targetHints: ["Echo正式闭环人工测试赛-20260821"],
      relevantCards: [{
        dimensions: { name: "Echo正式闭环人工测试赛-20260821", status: "PLANNING" },
      }],
      coverage: {
        level: "complete",
        missingAspects: [],
        observationComplete: true,
        contentPresence: "present",
      },
      semantics: {
        observations: [{
          id: "view-present",
          layer: "business_view",
          scope: "activity_operations",
          subject: "Echo正式闭环人工测试赛-20260821",
          predicate: "contains_matching_card",
          status: "present",
          completeness: "complete",
          authority: "authoritative",
          refs: ["V1"],
          summary: "正式 View 已存在匹配 Card。",
        }],
        answerability: [],
      },
      invalidatedEvidenceRefs: ["H1"],
    });

    const result = auditGroundedAnswer({
      text: "时间是2026年9月12日，地点是东区体育馆，状态是筹备中。[V1]\n\n正式卡片尚未审批生效，仍需审批后才能落地。[H1]",
      contract: state.contract(),
      validRefs: ["V1", "H1"],
    });

    expect(result.changed).toBe(true);
    expect(result.issues).toContain("unknown_refs:H1");
    expect(result.text).toContain("时间是2026年9月12日");
    expect(result.text).not.toContain("尚未审批生效");
    expect(result.text).not.toContain("[H1]");
  });
});
