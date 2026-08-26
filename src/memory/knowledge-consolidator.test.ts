import { describe, expect, it } from "vitest";

import { objectUpdatesFromAssertionGraph } from "@/memory/knowledge-consolidator";

describe("objectUpdatesFromAssertionGraph", () => {
  it("derives Object maintenance candidates from published Assertion links", () => {
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    const updates = objectUpdatesFromAssertionGraph({
      publishedAssertions: 1,
      publishedAssertionIds: ["assertion-1"],
      affectedObjectIds: [firstId, secondId],
      affectedObjects: [{
        id: firstId,
        canonicalName: "对象一",
        resolution: "existing",
      }, {
        id: secondId,
        canonicalName: "对象二",
        resolution: "existing",
      }, {
        id: firstId,
        canonicalName: "对象一",
        resolution: "existing",
      }],
    });

    expect(updates.map((update) => update.globalObjectId)).toEqual([firstId, secondId]);
    expect(updates.every((update) => update.focus.includes("直接图连接"))).toBe(true);
  });
});
