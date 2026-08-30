import { zodSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sourceState = vi.hoisted(() => ({
  read: vi.fn(),
  containingSection: vi.fn(),
}));

vi.mock("@/memory/source-document", () => ({
  containingSectionHeadingBlockId: sourceState.containingSection,
  readSourceDocumentSelection: sourceState.read,
  sourceDocumentLimits: {
    defaultCharacters: 48_000,
    minCharacters: 2_000,
    maxCharacters: 120_000,
    maxContextBlocks: 200,
  },
}));

import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import {
  createSourceDocumentToolset,
  sourceReadInputSchema,
  UnknownSourceAssertionError,
} from "@/memory/source-document-toolset";
import type { SourceDocumentReadResult } from "@/memory/source-document-types";
import type { MemoryRetrievalResult } from "@/memory/types";

const executionOptions = {
  toolCallId: "tool-call-1",
  messages: [],
  abortSignal: undefined,
  context: {},
};

function retrieval(): MemoryRetrievalResult {
  return {
    query: "test",
    mode: "object-assertion",
    seedMap: {
      facets: [],
      objects: [],
      assertions: [{
        ref: "A1",
        id: "00000000-0000-4000-8000-000000000011",
        kind: "grounded",
        dereferenceRequired: false,
        sourceNodeId: "region-1",
        sourceClaimId: "claim-1",
        renderedStatement: "一条需要上下文的命题",
        contextDependent: true,
        matchedBy: [],
        matchedFacets: [],
        sources: [{
          sourceDocumentId: "00000000-0000-4000-8000-000000000020",
          sourceTitle: "测试原文",
          sourceSha256: "sha",
          sourceNodeId: "region-1",
          sourceRegionLabel: "测试章节",
          sourceBlockId: "block-2",
          ordinal: 0,
          pages: [1],
        }],
      }],
      connections: [],
    },
  };
}

function readResult(overrides: Record<string, unknown> = {}) {
  return {
    document: {
      id: "00000000-0000-4000-8000-000000000020",
      title: "测试原文",
      sha256: "sha",
      parser: "mineru",
      pageCount: 2,
      blockCount: 4,
    },
    selection: {
      mode: "full",
      label: "完整原文",
      startOrder: 0,
      endOrder: 3,
    },
    blocks: [{
      sourceBlockId: "block-1",
      order: 0,
      blockType: "text",
      headingLevel: null,
      headingPath: [],
      pages: [1],
      markdown: "第一段原文",
    }],
    requestedMaxCharacters: 2_000,
    returnedCharacters: 5,
    isFullDocument: false,
    isCompleteSelection: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sourceState.read.mockResolvedValue(readResult());
  sourceState.containingSection.mockResolvedValue("heading-2");
});

describe("createSourceDocumentToolset", () => {
  it("exposes a DeepSeek-compatible top-level object schema", async () => {
    const jsonSchema = await zodSchema(sourceReadInputSchema).jsonSchema;

    expect(jsonSchema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        mode: expect.any(Object),
      }),
      required: expect.arrayContaining(["mode"]),
    });
  });

  it("defaults omitted around-window sides while keeping other mode requirements", () => {
    const around = sourceReadInputSchema.safeParse({
      mode: "around",
      assertionRef: "A1",
    });
    expect(around.success).toBe(true);
    if (around.success) {
      expect(around.data).toMatchObject({ beforeBlocks: 0, afterBlocks: 0 });
    }
    expect(sourceReadInputSchema.safeParse({
      mode: "around",
      assertionRef: "A1",
      beforeBlocks: 1,
      afterBlocks: 2,
    }).success).toBe(true);
    expect(sourceReadInputSchema.safeParse({
      mode: "section",
      assertionRef: "A1",
    }).success).toBe(true);
    expect(sourceReadInputSchema.safeParse({
      mode: "continue",
    }).success).toBe(false);
    expect(sourceReadInputSchema.safeParse({
      mode: "continue",
      continuationCursor: "source-1",
    }).success).toBe(true);
  });

  it("anchors a full-document read to a real A# and registers only real S# citations", async () => {
    const toolset = createSourceDocumentToolset({
      evidence: new MemoryEvidenceAccumulator(retrieval()),
      resultTokenBudget: 10_000,
    });

    const result = await toolset.tool.execute!(
      { mode: "full", assertionRef: "A1", beforeBlocks: 0, afterBlocks: 0, maxCharacters: 10_000 },
      executionOptions,
    );

    expect(sourceState.read).toHaveBeenCalledWith({
      publicationRunId: "00000000-0000-4000-8000-000000000020",
      selection: { mode: "full" },
      maxCharacters: 10_000,
    });
    expect(result).toEqual(expect.objectContaining({ ref: "S1" }));
    const cited = toolset.citedReferences("使用原文 [S1]，忽略伪造引用 [S9]。");
    expect(cited).toEqual({
      references: [expect.objectContaining({
        ref: "S1",
        startBlockId: "block-1",
        endBlockId: "block-1",
        blockCount: 1,
        pages: [1],
      })],
    });
    expect(JSON.stringify(cited)).not.toContain("第一段原文");
  });

  it("uses the Assertion source block as the default around anchor", async () => {
    const toolset = createSourceDocumentToolset({
      evidence: new MemoryEvidenceAccumulator(retrieval()),
      resultTokenBudget: 10_000,
    });

    await toolset.tool.execute!(
      {
        mode: "around",
        assertionRef: "A1",
        beforeBlocks: 12,
        afterBlocks: 20,
      },
      executionOptions,
    );

    expect(sourceState.read).toHaveBeenCalledWith(expect.objectContaining({
      selection: {
        mode: "around",
        sourceBlockId: "block-2",
        beforeBlocks: 12,
        afterBlocks: 20,
      },
    }));
  });

  it("resolves the Assertion containing section when headingBlockId is omitted", async () => {
    const toolset = createSourceDocumentToolset({
      evidence: new MemoryEvidenceAccumulator(retrieval()),
      resultTokenBudget: 10_000,
    });

    await toolset.tool.execute!(
      { mode: "section", assertionRef: "A1", beforeBlocks: 0, afterBlocks: 0 },
      executionOptions,
    );

    expect(sourceState.containingSection).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      "block-2",
    );
    expect(sourceState.read).toHaveBeenCalledWith(expect.objectContaining({
      selection: { mode: "section", headingBlockId: "heading-2" },
    }));
  });

  it("returns the complete source outline without hidden relevance filtering", async () => {
    sourceState.read.mockResolvedValue(readResult({
      selection: { mode: "outline", label: "原文目录" },
      blocks: [],
      outline: [
        { sourceBlockId: "h1", order: 0, headingLevel: 1, headingPath: [], title: "无关前章", pages: [1] },
        { sourceBlockId: "h2", order: 1, headingLevel: 1, headingPath: [], title: "测试章节", pages: [1] },
        { sourceBlockId: "h3", order: 2, headingLevel: 2, headingPath: ["测试章节"], title: "相关小节", pages: [1] },
        { sourceBlockId: "h4", order: 3, headingLevel: 1, headingPath: [], title: "相邻后章", pages: [2] },
        { sourceBlockId: "h5", order: 4, headingLevel: 1, headingPath: [], title: "很远的无关章节", pages: [2] },
      ],
    }));
    const toolset = createSourceDocumentToolset({
      evidence: new MemoryEvidenceAccumulator(retrieval()),
      resultTokenBudget: 10_000,
    });

    const result = await toolset.tool.execute!(
      { mode: "outline", assertionRef: "A1", beforeBlocks: 0, afterBlocks: 0 },
      executionOptions,
    ) as SourceDocumentReadResult;

    expect(result.selection.label).toBe("原文目录");
    expect(result.outline?.map((entry) => entry.sourceBlockId)).toEqual([
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
    ]);
  });

  it("does not silently narrow an aggregated Shared Brain outline", async () => {
    const scoped = retrieval();
    const assertion = scoped.seedMap.assertions[0];
    if (!assertion || assertion.sources[0]?.kind === "chat") throw new Error("fixture missing");
    assertion.sources[0].sourceTitle = "USTC_TTA_乒协生存手册.pdf";
    assertion.sources[0].sourceRegionLabel = "3.1 大型品牌赛事";
    assertion.sources[0].sourceBlockId = "library:manual:table-1";
    sourceState.read.mockResolvedValue(readResult({
      document: {
        id: "00000000-0000-4000-8000-000000000020",
        title: "Sydaris Shared Brain",
        sha256: "sha",
        parser: "sydaris-library-publisher",
        pageCount: 2,
        blockCount: 4,
      },
      selection: { mode: "outline", label: "原文目录" },
      blocks: [],
      outline: [
        { sourceBlockId: "library:other:h1", order: 0, headingLevel: 2, headingPath: [], title: "3.1 大型品牌赛事", pages: [1] },
        { sourceBlockId: "library:manual:h1", order: 1, headingLevel: 2, headingPath: [], title: "3.1 大型品牌赛事", pages: [1] },
        { sourceBlockId: "library:manual:h2", order: 2, headingLevel: 2, headingPath: [], title: "3.2 常规活动", pages: [1] },
        { sourceBlockId: "library:other:h2", order: 3, headingLevel: 2, headingPath: [], title: "无关章节", pages: [2] },
      ],
    }));
    const toolset = createSourceDocumentToolset({
      evidence: new MemoryEvidenceAccumulator(scoped),
      resultTokenBudget: 10_000,
    });

    const result = await toolset.tool.execute!(
      { mode: "outline", assertionRef: "A1", beforeBlocks: 0, afterBlocks: 0 },
      executionOptions,
    ) as SourceDocumentReadResult;

    expect(result.outline?.map((entry) => entry.sourceBlockId)).toEqual([
      "library:other:h1",
      "library:manual:h1",
      "library:manual:h2",
      "library:other:h2",
    ]);
  });

  it("keeps continuation cursors request-local and resumes the same selection", async () => {
    sourceState.read
      .mockResolvedValueOnce(readResult({
        isCompleteSelection: false,
        nextStartOrder: 2,
      }))
      .mockResolvedValueOnce(readResult({
        blocks: [{
          sourceBlockId: "block-3",
          order: 2,
          blockType: "text",
          headingLevel: null,
          headingPath: [],
          pages: [2],
          markdown: "续读原文",
        }],
        isCompleteSelection: true,
      }));
    const toolset = createSourceDocumentToolset({
      evidence: new MemoryEvidenceAccumulator(retrieval()),
      resultTokenBudget: 10_000,
    });

    const first = await toolset.tool.execute!(
      { mode: "full", assertionRef: "A1", beforeBlocks: 0, afterBlocks: 0, maxCharacters: 2_000 },
      executionOptions,
    );
    expect(first).toEqual(expect.objectContaining({
      ref: "S1",
      continuationCursor: "source-1",
    }));

    const second = await toolset.tool.execute!(
      { mode: "continue", continuationCursor: "source-1", beforeBlocks: 0, afterBlocks: 0 },
      executionOptions,
    );
    expect(sourceState.read).toHaveBeenLastCalledWith({
      publicationRunId: "00000000-0000-4000-8000-000000000020",
      selection: { mode: "full" },
      maxCharacters: 2_000,
      startOrder: 2,
    });
    expect(second).toEqual(expect.objectContaining({ ref: "S2" }));
  });

  it("rejects an A# that has not appeared in this request", async () => {
    const toolset = createSourceDocumentToolset({
      evidence: new MemoryEvidenceAccumulator(retrieval()),
      resultTokenBudget: 10_000,
    });

    await expect(toolset.tool.execute!(
      { mode: "full", assertionRef: "A9", beforeBlocks: 0, afterBlocks: 0 },
      executionOptions,
    )).rejects.toBeInstanceOf(UnknownSourceAssertionError);
    expect(sourceState.read).not.toHaveBeenCalled();
  });
});
