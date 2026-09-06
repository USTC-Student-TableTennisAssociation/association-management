import { describe, expect, it } from "vitest";

import { memoryAssertionCorpusRevision } from "@/memory/assertion-indexer";

describe("memoryAssertionCorpusRevision", () => {
  const first = {
    assertionId: "00000000-0000-4000-8000-000000000001",
    contentHash: "a".repeat(64),
  };
  const second = {
    assertionId: "00000000-0000-4000-8000-000000000002",
    contentHash: "b".repeat(64),
  };

  it("is deterministic across input ordering", () => {
    expect(memoryAssertionCorpusRevision([first, second]))
      .toBe(memoryAssertionCorpusRevision([second, first]));
  });

  it("changes when assertion content changes even if the count does not", () => {
    expect(memoryAssertionCorpusRevision([first]))
      .not.toBe(memoryAssertionCorpusRevision([{ ...first, contentHash: "c".repeat(64) }]));
  });
});
