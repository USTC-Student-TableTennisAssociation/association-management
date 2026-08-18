import { describe, expect, it } from "vitest";

import { EvidenceLedger } from "@/evidence/ledger";
import { artifactSearchEvidenceSemantics } from "@/evidence/tool-semantics";
import { describeViewContextEvidence } from "@/agent-runtime/view-context";

describe("EvidenceLedger", () => {
  it("records completed observations without creating a retrieval plan", () => {
    const ledger = new EvidenceLedger();
    ledger.record(describeViewContextEvidence({
      viewRef: "V1",
      viewKey: "activity_operations",
      viewLabel: "Activity Operations",
      totalCardCount: 0,
      targetHints: ["校内场地申请"],
      relevantCards: [],
      references: [],
      unresolvedAspects: [],
    }));

    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      observations: [expect.objectContaining({
        predicate: "contains_matching_card",
        status: "absent",
        completeness: "complete",
      })],
      answerability: expect.arrayContaining([
        expect.objectContaining({ status: "answerable" }),
        expect.objectContaining({ status: "not_applicable" }),
      ]),
    }));
  });

  it("states that a title lookup cannot answer questions about file content", () => {
    const semantics = artifactSearchEvidenceSemantics({
      queryTitle: "操作手册",
      matchedCount: 1,
      truncated: false,
      ref: "F1",
      items: [{ ref: "F2" }],
    });

    expect(semantics.answerability).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "library.title_search.操作手册.existence",
        status: "answerable",
      }),
      expect.objectContaining({
        id: "library.title_search.操作手册.content",
        status: "not_answerable",
      }),
    ]));
  });
});
