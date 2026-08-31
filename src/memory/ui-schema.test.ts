import { describe, expect, it } from "vitest";

import { memorySearchBundleSchema } from "@/memory/ui-schema";

describe("memorySearchBundleSchema", () => {
  it("keeps source-time provenance in persisted chat data", () => {
    const sourceTime = {
      sourceTitle: "协会章程",
      sourceSha256: "sha256",
      text: "2026-08-30",
      supportingBlocks: [{ sourceBlockId: "block-1", pages: [1] }],
    };

    const parsed = memorySearchBundleSchema.parse({
      mode: "object-assertion",
      seedMap: {
        facets: [],
        sourceTime,
        objects: [],
        assertions: [],
        connections: [],
      },
    });

    expect(parsed.seedMap.sourceTime).toEqual(sourceTime);
  });
});
