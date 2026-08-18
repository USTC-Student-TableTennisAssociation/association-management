import { describe, expect, it } from "vitest";

import { citedRefs } from "@/ai/citation-refs";

describe("citedRefs", () => {
  it("accepts ASCII and full-width brackets and deduplicates refs", () => {
    expect(citedRefs("依据 [A1]、【A2】和重复的【A1】。", "A"))
      .toEqual(["A1", "A2"]);
  });

  it("does not mix citation namespaces", () => {
    expect(citedRefs("[V1]【A2】[S3]", "V")).toEqual(["V1"]);
  });
});
