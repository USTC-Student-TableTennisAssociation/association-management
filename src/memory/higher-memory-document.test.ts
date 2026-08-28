import { describe, expect, it } from "vitest";

import {
  parseCognitiveMemory,
  parseOperationalMemoryIndex,
} from "@/memory/higher-memory-document";

describe("Higher Memory privacy minimization", () => {
  it("redacts raw phone numbers and email addresses from Object cognition", () => {
    const memory = parseCognitiveMemory({
      identityAndBoundaries: "某成员联系电话为 13800138000。",
      narrativeAndMeaning: "联系邮箱为 member@example.com。",
      structuralModel: "",
      operatingModel: "",
      currentSituation: "",
      openQuestions: [],
    });

    expect(JSON.stringify(memory)).not.toContain("13800138000");
    expect(JSON.stringify(memory)).not.toContain("member@example.com");
    expect(JSON.stringify(memory)).toContain("原始联系方式已省略");
  });

  it("redacts raw contacts from the operational navigation index", () => {
    const index = parseOperationalMemoryIndex({
      aspects: [{
        key: "contact",
        label: "联系方式",
        summary: "拨打 13800138000 联系。",
        coverage: "partial",
        assertionIds: [],
        sourceNodeIds: [],
        sourceTitles: [],
        recommendedQueries: ["member@example.com"],
        unresolvedAspects: [],
      }],
    });

    expect(JSON.stringify(index)).not.toContain("13800138000");
    expect(JSON.stringify(index)).not.toContain("member@example.com");
  });
});
