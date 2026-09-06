import { describe, expect, it } from "vitest";

import { allCitedRefs, citedRefs } from "@/ai/citation-refs";

describe("citedRefs", () => {
  it("accepts ASCII and full-width brackets and deduplicates refs", () => {
    expect(citedRefs("依据 [A1]、【A2】和重复的【A1】。", "A"))
      .toEqual(["A1", "A2"]);
  });

  it("does not mix citation namespaces", () => {
    expect(citedRefs("[V1]【A2】[S3]", "V")).toEqual(["V1"]);
  });

  it("accepts parenthesized and grouped model citations", () => {
    const text = "依据 (S1/S2)、（S3、S4，S5）以及重复的 [S1]。";
    expect(citedRefs(text, "S")).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(allCitedRefs("结论（A1、S2）；状态 (V3 / H4)。"))
      .toEqual(["A1", "S2", "V3", "H4"]);
  });

  it("does not treat bare reference-like text as a citation", () => {
    expect(allCitedRefs("型号 S1 和文件 A2-final 都不是引用。"))
      .toEqual([]);
  });
});
