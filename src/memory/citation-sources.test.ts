import { describe, expect, it } from "vitest";

import {
  attachCitedSourceExcerpts,
  citedAssertionRefs,
} from "@/memory/citation-sources";
import type { MemoryRetrievalResult } from "@/memory/types";

function retrieval(): MemoryRetrievalResult {
  return {
    query: "test",
    mode: "object-assertion",
    seedMap: {
      facets: [],
      objects: [],
      connections: [],
      assertions: ["A1", "A2"].map((ref, index) => ({
        ref,
        id: `assertion-${index + 1}`,
        kind: "grounded" as const,
        dereferenceRequired: false,
        sourceNodeId: `region-${index + 1}`,
        sourceClaimId: `claim-${index + 1}`,
        renderedStatement: `Assertion ${index + 1}`,
        contextDependent: false,
        matchedBy: [],
        matchedFacets: [],
        sources: [{
          kind: "document",
          sourceDocumentId: "document-1",
          sourceTitle: "Source",
          sourceSha256: "sha",
          sourceNodeId: `region-${index + 1}`,
          sourceRegionLabel: "Region",
          sourceBlockId: `block-${index + 1}`,
          ordinal: 0,
          pages: [index + 1],
          excerpt: "stale text must not leak",
        }],
      })),
    },
  };
}

describe("attachCitedSourceExcerpts", () => {
  it("attaches source text only to cited Assertions and strips all stale excerpts", () => {
    const result = attachCitedSourceExcerpts(retrieval(), ["A1"], [{
      assertionId: "assertion-1",
      sourceKey: "document\u0000region-1\u0000block-1",
      excerpt: "hydrated after answer",
    }]);

    expect(result.seedMap.assertions[0].sources[0].excerpt).toBe("hydrated after answer");
    expect(result.seedMap.assertions[1].sources[0].excerpt).toBeUndefined();
  });

  it("recognizes refs added by Explore and ignores unknown or duplicate refs", () => {
    expect(
      citedAssertionRefs(
        "初始事实 [A1]，新发现 [A2]，再次 [A2]，伪造 [A9]。",
        retrieval().seedMap,
      ),
    ).toEqual(["A1", "A2"]);
  });
});
