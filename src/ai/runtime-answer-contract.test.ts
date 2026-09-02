import { describe, expect, it } from "vitest";

import { buildRuntimeAnswerContract } from "@/ai/runtime-answer-contract";
import type { TurnEvidenceContract } from "@/evidence/turn-context";

function evidence(
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

describe("Runtime Answer Contract", () => {
  it("derives answer boundaries from traces instead of classifying the user message", () => {
    const contract = buildRuntimeAnswerContract({
      evidence: evidence({
        coverageByScope: [{
          layer: "library",
          scope: "inventory",
          coverage: { level: "partial", missingAspects: ["仍在分页"] },
        }],
      }),
      capabilities: {
        exposedTools: ["listLibrary", "proposeLibraryPlan"],
        executions: [
          {
            toolName: "listLibrary",
            declaredEffect: "none",
            success: true,
            outcome: "read",
          },
          {
            toolName: "proposeLibraryPlan",
            declaredEffect: "proposal",
            success: true,
            outcome: "proposal",
          },
        ],
        successfulReads: ["listLibrary"],
        pendingProposals: ["proposeLibraryPlan"],
        committedWrites: [],
      },
    });

    expect(contract.incompleteScopes).toEqual(["library:inventory"]);
    expect(contract.mode).toBe("proposal_receipt");
    expect(contract.constraints.join("\n")).toContain("不能支持全称否定");
    expect(contract.constraints.join("\n")).toContain("仍待用户审批");
    expect(contract.constraints.join("\n")).toContain("没有成功写入回执");
  });

  it("flags only direct authoritative presence conflicts, not unknown coverage", () => {
    const observations = ["present", "unknown", "absent"].map((status, index) => ({
      id: `observation-${index}`,
      layer: "library" as const,
      scope: "artifact:x",
      subject: "文件 X",
      predicate: "exists",
      status: status as "present" | "unknown" | "absent",
      completeness: "complete" as const,
      authority: "authoritative" as const,
      refs: [],
      summary: status,
    }));
    const contract = buildRuntimeAnswerContract({
      evidence: evidence({
        evidenceSemantics: { observations, answerability: [] },
      }),
      capabilities: {
        exposedTools: [],
        executions: [],
        successfulReads: [],
        pendingProposals: [],
        committedWrites: [],
      },
    });

    expect(contract.conflictingScopes).toEqual([
      "library:artifact:x:文件 X:exists",
    ]);
    expect(contract.mode).toBe("claim_frame");
  });

  it("selects direct streaming or a single-layer Evidence Envelope from traces", () => {
    const emptyCapabilities = {
      exposedTools: [],
      executions: [],
      successfulReads: [],
      pendingProposals: [],
      committedWrites: [],
    };
    expect(buildRuntimeAnswerContract({
      evidence: evidence(),
      capabilities: emptyCapabilities,
    }).mode).toBe("direct");
    expect(buildRuntimeAnswerContract({
      evidence: evidence({
        coverageByScope: [{
          layer: "business_view",
          scope: "view:activity_operations",
          coverage: { level: "complete", missingAspects: [] },
        }],
      }),
      capabilities: emptyCapabilities,
    }).mode).toBe("evidence_envelope");
  });
});
