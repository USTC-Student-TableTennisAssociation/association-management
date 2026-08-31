import {
  emptySeedMap,
  type MemoryQuery,
  type MemoryRetriever,
  type MemoryRetrievalResult,
} from "@/memory/types";
import { locateObjectAssertions } from "@/memory/database-locate";

class DisabledMemoryRetriever implements MemoryRetriever {
  readonly mode = "disabled" as const;

  async retrieve(input: MemoryQuery): Promise<MemoryRetrievalResult> {
    return { query: input.query, mode: "disabled", seedMap: emptySeedMap(input.facets) };
  }
}

class FixtureMemoryRetriever implements MemoryRetriever {
  readonly mode = "fixture" as const;

  async retrieve(input: MemoryQuery): Promise<MemoryRetrievalResult> {
    const facets = input.facets ?? [
      { id: "facet-0", text: input.query, source: "query" as const },
    ];
    const matched = input.query.toLocaleLowerCase("zh-CN").includes("测试记忆");
    return {
      query: input.query,
      mode: "fixture",
      seedMap: matched
          ? {
            facets,
            objects: [
              {
                ref: "O1",
                id: "00000000-0000-4000-8000-000000000001",
                globalObjectKey: "fixture-global-object",
                canonicalName: "测试记忆",
                surfaceForms: ["测试记忆"],
                matchedBy: [
                  {
                    facetId: facets[0].id,
                    channel: "object-lexical",
                    method: "contains",
                    rank: 1,
                    score: 1,
                  },
                ],
                matchedFacets: [facets[0].id],
                supportingAssertions: ["A1"],
                lexicalMatch: true,
                semanticMatch: true,
              },
            ],
            assertions: [
              {
                ref: "A1",
                kind: "grounded",
                dereferenceRequired: false,
                sourceNodeId: "fixture-region",
                sourceClaimId: "fixture-claim",
                renderedStatement:
                  "测试记忆说明：这是一条用于验证检索、引用和流式传输链路的临时内容，不代表真实事实。",
                contextDependent: false,
                matchedBy: [
                  {
                    facetId: facets[0].id,
                    channel: "assertion-lexical",
                    method: "contains",
                    rank: 1,
                    score: 1,
                  },
                ],
                matchedFacets: [facets[0].id],
                sources: [
                  {
                    kind: "document",
                    sourceDocumentId: "fixture-document",
                    sourceTitle: "聊天框架测试 fixture",
                    sourceSha256: "fixture",
                    sourceNodeId: "fixture-region",
                    sourceRegionLabel: "fixture",
                    sourceBlockId: "fixture-block-1",
                    ordinal: 0,
                    pages: [],
                  },
                ],
              },
            ],
            connections: [
              {
                assertionRef: "A1",
                objectRef: "O1",
              },
            ],
          }
        : emptySeedMap(facets),
    };
  }
}

class ObjectAssertionMemoryRetriever implements MemoryRetriever {
  readonly mode = "object-assertion" as const;

  retrieve(input: MemoryQuery): Promise<MemoryRetrievalResult> {
    return locateObjectAssertions(input);
  }
}

export function getMemoryRetriever(): MemoryRetriever {
  switch (process.env.MEMORY_RETRIEVER_MODE) {
    case "disabled":
      return new DisabledMemoryRetriever();
    case "fixture":
      return new FixtureMemoryRetriever();
    default:
      return new ObjectAssertionMemoryRetriever();
  }
}
