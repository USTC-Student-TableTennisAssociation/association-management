import { describe, expect, it } from "vitest";

import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import type { MemoryExploreResult } from "@/memory/explore";
import type { MemoryRetrievalResult } from "@/memory/types";

function initial(): MemoryRetrievalResult {
  return {
    query: "继往开来是什么活动？",
    mode: "object-assertion",
    seedMap: {
      facets: [{ id: "facet-0", text: "继往开来", source: "query" }],
      objects: [{
        ref: "O1",
        id: "object-1",
        globalObjectKey: "activity",
        canonicalName: "继往开来",
        surfaceForms: ["继往开来"],
        matchedBy: [],
        matchedFacets: ["facet-0"],
        supportingAssertions: ["A1"],
        lexicalMatch: true,
        semanticMatch: true,
      }],
      higherMemories: [{
        ref: "H1",
        id: "memory-1",
        globalObjectId: "object-1",
        contentMarkdown: "这是对继往开来的高层认知。",
        operationalIndex: { aspects: [] },
        maintainedAt: "2026-08-14T00:00:00.000Z",
      }],
      assertions: [{
        ref: "A1",
        kind: "grounded",
        dereferenceRequired: false,
        sourceNodeId: "region-1",
        sourceClaimId: "claim-1",
        renderedStatement: "继往开来是换届活动。",
        contextDependent: false,
        matchedBy: [],
        matchedFacets: ["facet-0"],
        sources: [{
          sourceDocumentId: "run-1",
          sourceTitle: "手册",
          sourceSha256: "sha",
          sourceNodeId: "region-1",
          sourceRegionLabel: "活动",
          sourceBlockId: "block-1",
          ordinal: 0,
          pages: [1],
        }],
      }],
      connections: [{ assertionRef: "A1", objectRef: "O1" }],
    },
    trace: {
      version: "structured-seed-map.v1",
      query: "继往开来是什么活动？",
      snapshot: {
        indexedAt: null,
        embeddingModel: null,
        embeddingRevision: null,
        embeddingDimension: null,
        embeddingAssertionCount: 0,
        globalObjectCount: 2,
        objectFragmentCount: 2,
        surfaceFormCount: 2,
        fragmentReferenceCount: 2,
        assertionCount: 2,
      },
      facets: [],
      objectLexical: [],
      assertionLexical: [],
      assertionVector: [],
      semanticDerivedObjects: [],
      finalSeedMap: { objectRefs: ["O1"], assertionRefs: ["A1"], connections: 1 },
      answerUsedAssertionRefs: [],
      budget: {
        facetLimit: 4,
        objectHitsPerFacet: 32,
        assertionLexicalHitsPerFacet: 16,
        assertionVectorHitsPerFacet: 16,
        assertionSeeds: 48,
      },
      durationMs: 1,
      warnings: [],
    },
  };
}

function explored(): MemoryExploreResult {
  return {
    kind: "follow-object",
    mode: "object-assertion",
    globalObjectId: "object-1",
    objects: [
      {
        ref: "O1",
        id: "object-1",
        globalObjectKey: "activity",
        canonicalName: "继往开来",
        surfaceForms: ["继往开来活动"],
        lexicalMatch: false,
        semanticMatch: true,
      },
      {
        ref: "O2",
        id: "object-2",
        globalObjectKey: "handover",
        canonicalName: "换届",
        surfaceForms: ["换届"],
        lexicalMatch: false,
        semanticMatch: true,
      },
    ],
    assertions: [
      {
        ref: "A1",
        kind: "grounded",
        dereferenceRequired: false,
        sourceNodeId: "region-1",
        sourceClaimId: "claim-1",
        renderedStatement: "继往开来是换届活动。",
        contextDependent: false,
        sources: [],
      },
      {
        ref: "A2",
        kind: "grounded",
        dereferenceRequired: false,
        sourceNodeId: "region-2",
        sourceClaimId: "claim-2",
        renderedStatement: "换届包含工作交接。",
        contextDependent: false,
        sources: [{
          sourceDocumentId: "run-1",
          sourceTitle: "手册",
          sourceSha256: "sha",
          sourceNodeId: "region-2",
          sourceRegionLabel: "换届",
          sourceBlockId: "block-2",
          ordinal: 0,
          pages: [2],
          excerpt: "不得进入工具输出或默认上下文",
        }],
      },
    ],
    connections: [
      { assertionRef: "A1", objectRef: "O1" },
      { assertionRef: "A2", objectRef: "O1" },
      { assertionRef: "A2", objectRef: "O2" },
    ],
    counts: { objects: 2, assertions: 2, connections: 3 },
    truncated: { objects: false, assertions: false },
    warnings: [],
  };
}

describe("MemoryEvidenceAccumulator", () => {
  it("deduplicates stable identities and remaps local refs into one request namespace", () => {
    const accumulator = new MemoryEvidenceAccumulator(initial());
    const merged = accumulator.merge(explored());
    const snapshot = accumulator.snapshot();

    expect(merged.objects.map((item) => item.ref)).toEqual(["O1", "O2"]);
    expect(merged.assertions.map((item) => item.ref)).toEqual(["A1", "A2"]);
    expect(snapshot.seedMap.objects).toHaveLength(2);
    expect(snapshot.seedMap.assertions).toHaveLength(2);
    expect(snapshot.seedMap.higherMemories).toEqual([expect.objectContaining({
      ref: "H1",
      globalObjectId: "object-1",
    })]);
    expect(snapshot.seedMap.connections).toEqual([
      { assertionRef: "A1", objectRef: "O1" },
      { assertionRef: "A2", objectRef: "O1" },
      { assertionRef: "A2", objectRef: "O2" },
    ]);
    expect(snapshot.seedMap.objects[0].supportingAssertions).toEqual(["A1", "A2"]);
    expect(accumulator.hasObject("object-2")).toBe(true);
  });

  it("strips any accidental excerpts before evidence reaches a model tool result", () => {
    const accumulator = new MemoryEvidenceAccumulator(initial());
    const merged = accumulator.merge(explored());

    expect("excerpt" in merged.assertions[1].sources[0]).toBe(false);
    expect(JSON.stringify(accumulator.snapshot())).not.toContain("不得进入");
  });

  it("resolves a unique in-turn Object by O#、canonical name or surface form", () => {
    const accumulator = new MemoryEvidenceAccumulator(initial());

    expect(accumulator.objectForModelReference("O1")).toEqual({
      id: "object-1",
      canonicalName: "继往开来",
    });
    expect(accumulator.objectForModelReference("“继往开来”")).toEqual({
      id: "object-1",
      canonicalName: "继往开来",
    });
  });

  it("does not guess when an in-turn Object name is ambiguous", () => {
    const seed = initial();
    seed.seedMap.objects.push({
      ...seed.seedMap.objects[0],
      ref: "O2",
      id: "object-2",
    });
    const accumulator = new MemoryEvidenceAccumulator(seed);

    expect(accumulator.objectForModelReference("继往开来")).toBeUndefined();
  });

  it("removes an invalidated Higher Memory from the request-local evidence namespace", () => {
    const accumulator = new MemoryEvidenceAccumulator(initial());

    expect(accumulator.invalidateHigherMemories(["object-1"])).toEqual(["H1"]);
    expect(accumulator.snapshot().seedMap.higherMemories).toBeUndefined();
    expect(accumulator.invalidateHigherMemories(["object-1"])).toEqual([]);
  });

});
