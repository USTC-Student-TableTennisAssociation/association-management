import { describe, expect, it } from "vitest";

import {
  createOpenedCapabilities,
  detailedToolNames,
} from "@/ai/capability-gates";

describe("capability gates", () => {
  it("exposes only implemented Business Context follow-up tools", () => {
    const capabilities = createOpenedCapabilities();
    capabilities.businessContext = true;

    const names = detailedToolNames(capabilities);

    expect(names).toEqual(["expandEvidence", "followObject", "readSourceDocument"]);
    expect(names).not.toContain("readSemanticView");
  });
});
