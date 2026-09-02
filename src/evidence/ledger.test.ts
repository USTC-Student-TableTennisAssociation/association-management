import { describe, expect, it } from "vitest";

import { EvidenceLedger } from "@/evidence/ledger";
import { artifactSearchEvidenceSemantics } from "@/evidence/tool-semantics";
import { describeViewStateEvidence } from "@/agent-runtime/view-context";

describe("EvidenceLedger", () => {
  it("records completed observations without creating a retrieval plan", () => {
    const ledger = new EvidenceLedger();
    ledger.record(describeViewStateEvidence({
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

  it("is append-only even when a producer reuses an observation id", () => {
    const ledger = new EvidenceLedger();
    const first = describeViewStateEvidence({
      viewRef: "V1",
      viewKey: "activity_operations",
      viewLabel: "活动运营",
      totalCardCount: 0,
      targetHints: ["活动甲"],
      relevantCards: [],
      references: [],
      unresolvedAspects: [],
    });
    ledger.record(first);
    ledger.record(first);

    expect(ledger.snapshot().observations).toHaveLength(2);
    expect(ledger.snapshot().answerability).toHaveLength(4);
  });
});
