import { zodSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sourceState = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("@/memory/source-document", () => ({
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
    compilationId: "00000000-0000-4000-8000-000000000020",
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

  it("keeps mode-specific required fields in server-side validation", () => {
    expect(sourceReadInputSchema.safeParse({
      mode: "around",
      assertionRef: "A1",
    }).success).toBe(false);
    expect(sourceReadInputSchema.safeParse({
      mode: "around",
      assertionRef: "A1",
      beforeBlocks: 1,
      afterBlocks: 2,
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
      { mode: "full", assertionRef: "A1", maxCharacters: 10_000 },
      executionOptions,
    );

    expect(sourceState.read).toHaveBeenCalledWith({
      compilationId: "00000000-0000-4000-8000-000000000020",
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
      { mode: "full", assertionRef: "A1", maxCharacters: 2_000 },
      executionOptions,
    );
    expect(first).toEqual(expect.objectContaining({
      ref: "S1",
      continuationCursor: "source-1",
    }));

    const second = await toolset.tool.execute!(
      { mode: "continue", continuationCursor: "source-1" },
      executionOptions,
    );
    expect(sourceState.read).toHaveBeenLastCalledWith({
      compilationId: "00000000-0000-4000-8000-000000000020",
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
      { mode: "full", assertionRef: "A9" },
      executionOptions,
    )).rejects.toBeInstanceOf(UnknownSourceAssertionError);
    expect(sourceState.read).not.toHaveBeenCalled();
  });
});
