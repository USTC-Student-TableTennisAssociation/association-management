import { describe, expect, it } from "vitest";

import { createModelProfile } from "@/ai/model-profile";

describe("createModelProfile", () => {
  it("uses the balanced chat defaults", () => {
    const profile = createModelProfile({});

    expect(profile).toMatchObject({
      contextWindowTokens: 200_000,
      preferredInputTokens: 128_000,
      maxOutputTokens: 16_384,
      safetyTokens: 12_000,
      historyMaxTokens: 40_000,
      memoryMaxTokens: 64_000,
      maxRequestBytes: 2_000_000,
      maxRetries: 2,
      modelFirstChunkTimeoutMs: 1_800_000,
      modelChunkTimeoutMs: 1_800_000,
    });
  });

  it("rejects an impossible context budget", () => {
    expect(() =>
      createModelProfile({
        AI_CONTEXT_WINDOW_TOKENS: "16384",
        AI_MAX_OUTPUT_TOKENS: "12000",
        AI_CONTEXT_SAFETY_TOKENS: "5000",
      }),
    ).toThrow("必须大于输出预留");
  });
});
