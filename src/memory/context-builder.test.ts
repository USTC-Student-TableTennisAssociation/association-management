import { describe, expect, it } from "vitest";

import { buildEvidenceContext } from "@/memory/context-builder";

describe("buildEvidenceContext", () => {
  it("renders assertions, objects, connections, time, and source provenance", () => {
    const context = buildEvidenceContext({
      query: "test",
      mode: "fixture",
      seedMap: {
        facets: [{ id: "facet-0", text: "test", source: "query" }],
        objects: [
          {
            ref: "O1",
            id: "00000000-0000-4000-8000-000000000001",
            globalObjectKey: "global-1",
            canonicalName: "测试对象",
            surfaceForms: ["测试对象", "测试别名"],
            matchedBy: [],
            matchedFacets: ["facet-0"],
            supportingAssertions: ["A1"],
            lexicalMatch: true,
            semanticMatch: true,
          },
        ],
        assertions: [
          {
            ref: "A1",
            sourceNodeId: "region-1",
            sourceClaimId: "claim-1",
            renderedStatement: "测试对象在 2025 年举办活动。",
            contextDependent: true,
            matchedBy: [],
            matchedFacets: ["facet-0"],
            temporalAnnotations: [
              {
                rawExpression: "2025 年",
                kind: "point",
                normalizedText: "2025年",
                start: "2025",
                precision: "year",
                derivation: "source_explicit",
                basis: "原文明确写出",
              },
            ],
            sources: [
              {
                sourceTitle: "测试来源",
                sourceSha256: "sha",
                sourceNodeId: "region-1",
                sourceRegionLabel: "测试区域",
                sourceBlockId: "block-1",
                ordinal: 0,
                pages: [1],
                excerpt: "来源原文",
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
      },
    });

    expect(context).toContain("[A1] 测试对象在 2025 年举办活动");
    expect(context).toContain("[O1] Global Object：测试对象");
    expect(context).toContain("Surface forms：测试对象、测试别名");
    expect(context).toContain("canonical identity 和 surface forms 只用于识别");
    expect(context).toContain("上下文依赖：是，不得脱离当前来源语境扩张解读");
    expect(context).toContain("2025 年 → 2025年");
    expect(context).toContain("测试来源，block=block-1");
    expect(context).toContain("A1 ↔ O1");
    expect(context).toContain("只能引用下列真实存在的 Assertion ref");
    expect(context).toContain("不包含 SourceBlock 原文");
    expect(context).not.toContain("来源原文");
  });
});
