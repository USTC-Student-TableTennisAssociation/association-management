import { describe, expect, it } from "vitest";

import { normalizeOpenAIBaseURL } from "@/ai/provider";

describe("normalizeOpenAIBaseURL", () => {
  it("collapses duplicate path separators without changing the protocol", () => {
    expect(normalizeOpenAIBaseURL("https://api.example.test//v1/"))
      .toBe("https://api.example.test/v1");
  });

  it("removes trailing separators from nested base paths", () => {
    expect(normalizeOpenAIBaseURL("https://api.example.test/gateway///v1//"))
      .toBe("https://api.example.test/gateway/v1");
  });
});
