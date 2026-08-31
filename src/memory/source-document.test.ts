import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({
  sourceDocumentFindUnique: vi.fn(),
  blockFindUnique: vi.fn(),
  blockFindFirst: vi.fn(),
  blockFindMany: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDatabase: () => ({
    librarySourceDocument: { findUnique: databaseState.sourceDocumentFindUnique },
    memorySourceBlock: {
      findUnique: databaseState.blockFindUnique,
      findFirst: databaseState.blockFindFirst,
      findMany: databaseState.blockFindMany,
    },
  }),
}));

import {
  containingSectionHeadingBlockId,
  readSourceDocumentSelection,
} from "@/memory/source-document";

const sourceDocumentId = "00000000-0000-4000-8000-000000000020";
const blocks = [
  {
    sourceBlockId: "heading-1",
    order: 0,
    blockType: "heading",
    headingLevel: 1,
    headingPath: ["第一章"],
    sourcePages: [1],
    markdown: `# 第一章\n${"甲".repeat(1_190)}`,
  },
  {
    sourceBlockId: "text-1",
    order: 1,
    blockType: "text",
    headingLevel: null,
    headingPath: ["第一章"],
    sourcePages: [1],
    markdown: "第一章正文",
  },
  {
    sourceBlockId: "heading-1-1",
    order: 2,
    blockType: "heading",
    headingLevel: 2,
    headingPath: ["第一章", "第一节"],
    sourcePages: [2],
    markdown: "## 第一节",
  },
  {
    sourceBlockId: "text-2",
    order: 3,
    blockType: "text",
    headingLevel: null,
    headingPath: ["第一章", "第一节"],
    sourcePages: [2],
    markdown: "第一节正文",
  },
  {
    sourceBlockId: "heading-2",
    order: 4,
    blockType: "heading",
    headingLevel: 1,
    headingPath: ["第二章"],
    sourcePages: [3],
    markdown: "# 第二章",
  },
  {
    sourceBlockId: "text-3",
    order: 5,
    blockType: "text",
    headingLevel: null,
    headingPath: ["第二章"],
    sourcePages: [3],
    markdown: "第二章正文",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  databaseState.sourceDocumentFindUnique.mockResolvedValue({
    id: sourceDocumentId,
    title: "测试手册",
    parser: "mineru",
    blockCount: blocks.length,
    sourceBlob: { sha256: "sha" },
    sourceBlocks: blocks.map((block) => ({ sourcePages: block.sourcePages })),
  });
  databaseState.blockFindUnique.mockImplementation(async ({ where }) =>
    blocks.find(
      (block) => block.sourceBlockId === where.sourceDocumentId_sourceBlockId.sourceBlockId,
    ) ?? null
  );
  databaseState.blockFindFirst.mockImplementation(async ({ where, orderBy }) => {
    if (where.order?.gt !== undefined) {
      return blocks.find(
        (block) =>
          block.order > where.order.gt &&
          block.headingLevel !== null &&
          block.headingLevel <= where.headingLevel.lte,
      ) ?? null;
    }
    if (where.order?.lte !== undefined) {
      return [...blocks]
        .filter((block) => block.order <= where.order.lte && block.headingLevel !== null)
        .sort((left, right) => right.order - left.order)[0] ?? null;
    }
    const ordered = [...blocks].sort((left, right) =>
      orderBy.order === "asc" ? left.order - right.order : right.order - left.order
    );
    return ordered[0] ?? null;
  });
  databaseState.blockFindMany.mockImplementation(async ({ where }) => {
    if (where.headingLevel) return blocks.filter((block) => block.headingLevel !== null);
    return blocks.filter(
      (block) => block.order >= where.order.gte && block.order <= where.order.lte,
    );
  });
});

describe("readSourceDocumentSelection", () => {
  it("resolves the nearest containing section heading for a source Block", async () => {
    await expect(containingSectionHeadingBlockId(sourceDocumentId, "text-2"))
      .resolves.toBe("heading-1-1");
  });

  it("returns a compact outline with stable heading Block ids", async () => {
    const result = await readSourceDocumentSelection({
      sourceDocumentId,
      selection: { mode: "outline" },
    });

    expect(result.blocks).toEqual([]);
    expect(result.outline?.map((entry) => [entry.sourceBlockId, entry.title]))
      .toEqual([
        ["heading-1", "第一章"],
        ["heading-1-1", "第一节"],
        ["heading-2", "第二章"],
      ]);
  });

  it("reads a complete section until the next same-or-higher-level heading", async () => {
    const result = await readSourceDocumentSelection({
      sourceDocumentId,
      selection: { mode: "section", headingBlockId: "heading-1" },
      maxCharacters: 10_000,
    });

    expect(result.selection).toEqual({
      mode: "section",
      label: "章节：第一章",
      startOrder: 0,
      endOrder: 3,
    });
    expect(result.blocks.map((block) => block.sourceBlockId)).toEqual([
      "heading-1",
      "text-1",
      "heading-1-1",
      "text-2",
    ]);
    expect(result.isCompleteSelection).toBe(true);
  });

  it("paginates a full read between Blocks and resumes from an exact order", async () => {
    const first = await readSourceDocumentSelection({
      sourceDocumentId,
      selection: { mode: "full" },
      maxCharacters: 2_000,
    });

    expect(first.blocks.map((block) => block.sourceBlockId)).toEqual([
      "heading-1",
      "text-1",
      "heading-1-1",
      "text-2",
      "heading-2",
      "text-3",
    ]);
    expect(first.isCompleteSelection).toBe(true);
    expect(first.isFullDocument).toBe(true);

    const constrainedBlocks = blocks.map((block, index) => ({
      ...block,
      markdown: `${index}`.repeat(1_100),
    }));
    databaseState.blockFindMany.mockImplementation(async ({ where }) =>
      constrainedBlocks.filter(
        (block) => block.order >= where.order.gte && block.order <= where.order.lte,
      )
    );
    const paged = await readSourceDocumentSelection({
      sourceDocumentId,
      selection: { mode: "full" },
      maxCharacters: 2_000,
    });
    expect(paged.blocks).toHaveLength(1);
    expect(paged.nextStartOrder).toBe(1);
    expect(paged.isFullDocument).toBe(false);

    const continued = await readSourceDocumentSelection({
      sourceDocumentId,
      selection: { mode: "full" },
      maxCharacters: 2_000,
      startOrder: paged.nextStartOrder,
    });
    expect(continued.blocks[0].sourceBlockId).toBe("text-1");
  });

  it("reloads a cited Block range for the lightweight S# UI", async () => {
    const { readSourceDocumentRange } = await import("@/memory/source-document");
    const result = await readSourceDocumentRange({
      sourceDocumentId,
      startBlockId: "text-1",
      endBlockId: "text-2",
    });

    expect(result.document.title).toBe("测试手册");
    expect(result.blocks.map((block) => block.sourceBlockId)).toEqual([
      "text-1",
      "heading-1-1",
      "text-2",
    ]);
  });
});
