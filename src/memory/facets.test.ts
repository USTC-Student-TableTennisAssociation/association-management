import { describe, expect, it } from "vitest";

import { isUsefulFacet } from "@/memory/facets";

describe("query facet validation", () => {
  it("rejects empty placeholders and punctuation-only output", () => {
    for (const value of ["...", "…", "无", "none", "---", "？"]) {
      expect(isUsefulFacet(value)).toBe(false);
    }
  });

  it("accepts searchable names, dates, and concepts", () => {
    for (const value of ["继往开来", "2024 活动时间", "组队机制改变的影响"]) {
      expect(isUsefulFacet(value)).toBe(true);
    }
  });
});
