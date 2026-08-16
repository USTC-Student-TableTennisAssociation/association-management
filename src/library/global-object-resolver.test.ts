import { describe, expect, it } from "vitest";

import {
  applyGlobalDecision,
  canPromoteLibraryRun,
  failureAfterGlobalResolution,
  globalObjectResolutionDecisionSchema,
  mergeGlobalObjectDrafts,
  normalizeObjectLabel,
  onlyGlobalObjectRuns,
  withoutGlobalObjectRuns,
} from "@/library/global-object-resolver";

const RUN_A = "10000000-0000-4000-8000-000000000001";
const RUN_B = "10000000-0000-4000-8000-000000000002";
const RUN_C = "10000000-0000-4000-8000-000000000003";

describe("library global object resolver", () => {
  it("normalizes harmless spacing and separators", () => {
    expect(normalizeObjectLabel("Notion 知识库")).toBe(normalizeObjectLabel("Notion-知识库"));
  });

  it("creates a draft and attaches a later file candidate", () => {
    const first = [{
      key: `${RUN_A}:0`,
      runId: RUN_A,
      sourceName: "手册.pdf",
      label: "中国科大乒协",
      reason: "协会正式简称",
      action: "new_candidate" as const,
    }];
    const created = applyGlobalDecision([], first, {
      groups: [{
        action: "create_new",
        incomingKeys: [first[0].key],
        canonicalLabel: "中国科大乒协",
      }],
    }, []);
    expect(created).toHaveLength(1);

    const second = [{
      key: `${RUN_B}:0`,
      runId: RUN_B,
      sourceName: "策划案.docx",
      label: "乒协",
      reason: "策划案主办组织",
      action: "new_candidate" as const,
    }];
    const attached = applyGlobalDecision(created, second, {
      groups: [{
        action: "attach_draft",
        incomingKeys: [second[0].key],
        targetDraftObjectId: created[0].draftObjectId,
      }],
    }, []);
    expect(attached).toHaveLength(1);
    expect(attached[0].labels).toEqual(["中国科大乒协", "乒协"]);
    expect(attached[0].members).toHaveLength(2);
  });

  it("replaces one source contribution and removes Object drafts left without support", () => {
    const orphanObjectId = "20000000-0000-4000-8000-000000000001";
    const sharedObjectId = "20000000-0000-4000-8000-000000000002";
    const replacementObjectId = "20000000-0000-4000-8000-000000000003";
    const active = [{
      draftObjectId: orphanObjectId,
      canonicalLabel: "旧比赛",
      labels: ["旧比赛"],
      members: [{
        key: `${RUN_A}:assessment:0`,
        runId: RUN_A,
        sourceName: "旧通知.docx",
        label: "旧比赛",
        reason: "旧版 Assertion 支撑",
      }],
    }, {
      draftObjectId: sharedObjectId,
      canonicalLabel: "乒协",
      labels: ["乒协", "中国科大乒协"],
      members: [{
        key: `${RUN_A}:assessment:1`,
        runId: RUN_A,
        sourceName: "旧通知.docx",
        label: "乒协",
        reason: "旧版 Assertion 支撑",
      }, {
        key: `${RUN_B}:assessment:0`,
        runId: RUN_B,
        sourceName: "章程.docx",
        label: "中国科大乒协",
        reason: "章程 Assertion 支撑",
      }],
    }];
    const afterRemoval = withoutGlobalObjectRuns(active, new Set([RUN_A]));
    expect(afterRemoval).toHaveLength(1);
    expect(afterRemoval[0].draftObjectId).toBe(sharedObjectId);
    expect(afterRemoval[0].members.map((memberItem) => memberItem.runId)).toEqual([RUN_B]);

    const resolved = [...afterRemoval, {
      draftObjectId: replacementObjectId,
      canonicalLabel: "新比赛",
      labels: ["新比赛"],
      members: [{
        key: `${RUN_C}:assessment:0`,
        runId: RUN_C,
        sourceName: "新通知.docx",
        label: "新比赛",
        reason: "新版 Assertion 支撑",
      }],
    }];
    const replacementOnly = onlyGlobalObjectRuns(resolved, new Set([RUN_C]));
    const current = mergeGlobalObjectDrafts(afterRemoval, replacementOnly);
    expect(current.map((object) => object.canonicalLabel)).toEqual([
      "中国科大乒协",
      "新比赛",
    ]);
  });

  it("only replaces the current version after a successful run", () => {
    expect(canPromoteLibraryRun({
      sourceBlobId: "30000000-0000-4000-8000-000000000001",
      status: "ready",
      stage: "ready",
    })).toBe(true);
    expect(canPromoteLibraryRun({
      sourceBlobId: "30000000-0000-4000-8000-000000000001",
      status: "failed",
      stage: "failed",
    })).toBe(false);
  });

  it("requires a canonical label for newly created groups", () => {
    expect(globalObjectResolutionDecisionSchema.safeParse({
      groups: [{
        action: "create_new",
        incomingKeys: ["candidate-1"],
      }],
    }).success).toBe(false);
  });

  it("succeeds when every new candidate was resolved globally", () => {
    const result = failureAfterGlobalResolution({
      runId: RUN_A,
      objectCandidates: [{
        action: "new_candidate",
        label: "积分赛",
        reason: "可复用活动",
      }],
      resolvedMemberKeys: new Set([`${RUN_A}:assessment:0`]),
    });

    expect(result).toEqual({ failed: false, reasons: [] });
  });

  it("accepts a run with no Object candidates", () => {
    const result = failureAfterGlobalResolution({
      runId: RUN_A,
      objectCandidates: [],
      resolvedMemberKeys: new Set(),
    });

    expect(result).toEqual({ failed: false, reasons: [] });
  });

  it("fails incomplete Object resolution", () => {
    const unresolved = failureAfterGlobalResolution({
      runId: RUN_A,
      objectCandidates: [{
        action: "new_candidate",
        label: "档案管理制度",
        reason: "制度文档",
      }],
      resolvedMemberKeys: new Set(),
    });
    expect(unresolved.failed).toBe(true);
    expect(unresolved.reasons).toContain("1 个新 Object 候选尚未完成全局归并");
  });
});
