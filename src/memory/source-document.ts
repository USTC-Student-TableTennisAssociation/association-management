import { getDatabase } from "@/db";
import type {
  SourceDocumentBlock,
  SourceDocumentMetadata,
  SourceDocumentOutlineEntry,
  SourceDocumentReadResult,
} from "@/memory/source-document-types";

export const sourceDocumentLimits = {
  defaultCharacters: 48_000,
  minCharacters: 2_000,
  maxCharacters: 120_000,
  maxContextBlocks: 200,
} as const;

type ContentSelection =
  | {
      mode: "around";
      sourceBlockId: string;
      beforeBlocks: number;
      afterBlocks: number;
    }
  | { mode: "section"; headingBlockId: string }
  | { mode: "range"; startBlockId: string; endBlockId: string }
  | { mode: "full" };

export type SourceDocumentSelection = { mode: "outline" } | ContentSelection;

export class SourceDocumentReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceDocumentReadError";
  }
}

function headingTitle(markdown: string, headingPath: string[]): string {
  const firstLine = markdown
    .split(/\r?\n/, 1)[0]
    ?.replace(/^\s{0,3}#{1,6}\s+/, "")
    .trim();
  return firstLine || headingPath.at(-1) || "未命名章节";
}

function documentMetadata(row: {
  id: string;
  sourceTitle: string;
  sourceSha256: string;
  sourceParser: string;
  sourcePageCount: number;
  sourceBlockCount: number;
}): SourceDocumentMetadata {
  return {
    id: row.id,
    title: row.sourceTitle,
    sha256: row.sourceSha256,
    parser: row.sourceParser,
    pageCount: row.sourcePageCount,
    blockCount: row.sourceBlockCount,
  };
}

function sourceBlock(row: {
  sourceBlockId: string;
  order: number;
  blockType: string;
  headingLevel: number | null;
  headingPath: string[];
  sourcePages: number[];
  markdown: string;
}): SourceDocumentBlock {
  return {
    sourceBlockId: row.sourceBlockId,
    order: row.order,
    blockType: row.blockType,
    headingLevel: row.headingLevel,
    headingPath: [...row.headingPath],
    pages: [...row.sourcePages],
    markdown: row.markdown,
  };
}

async function blockAt(
  compilationId: string,
  sourceBlockId: string,
) {
  const block = await getDatabase().memorySourceBlock.findUnique({
    where: {
      compilationId_sourceBlockId: { compilationId, sourceBlockId },
    },
    select: {
      sourceBlockId: true,
      order: true,
      headingLevel: true,
      headingPath: true,
      markdown: true,
    },
  });
  if (!block) {
    throw new SourceDocumentReadError(
      `SourceBlock ${sourceBlockId} 不属于当前原文文档`,
    );
  }
  return block;
}

export async function containingSectionHeadingBlockId(
  compilationId: string,
  sourceBlockId: string,
): Promise<string> {
  const anchor = await blockAt(compilationId, sourceBlockId);
  if (anchor.headingLevel !== null) return anchor.sourceBlockId;
  const heading = await getDatabase().memorySourceBlock.findFirst({
    where: {
      compilationId,
      order: { lte: anchor.order },
      headingLevel: { not: null },
    },
    orderBy: { order: "desc" },
    select: { sourceBlockId: true },
  });
  if (!heading) {
    throw new SourceDocumentReadError(
      `SourceBlock ${sourceBlockId} 之前没有可用的章节标题`,
    );
  }
  return heading.sourceBlockId;
}

async function selectionBounds(
  compilationId: string,
  selection: ContentSelection,
): Promise<{ startOrder: number; endOrder: number; label: string }> {
  if (selection.mode === "around") {
    const anchor = await blockAt(compilationId, selection.sourceBlockId);
    return {
      startOrder: Math.max(0, anchor.order - selection.beforeBlocks),
      endOrder: anchor.order + selection.afterBlocks,
      label: `围绕 ${selection.sourceBlockId} 的原文上下文`,
    };
  }

  if (selection.mode === "range") {
    const [start, end] = await Promise.all([
      blockAt(compilationId, selection.startBlockId),
      blockAt(compilationId, selection.endBlockId),
    ]);
    if (start.order > end.order) {
      throw new SourceDocumentReadError("原文范围的起始 Block 必须早于结束 Block");
    }
    return {
      startOrder: start.order,
      endOrder: end.order,
      label: `原文范围 ${start.sourceBlockId} → ${end.sourceBlockId}`,
    };
  }

  const finalBlock = await getDatabase().memorySourceBlock.findFirst({
    where: { compilationId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  if (!finalBlock) throw new SourceDocumentReadError("当前原文文档没有 SourceBlock");

  if (selection.mode === "full") {
    const firstBlock = await getDatabase().memorySourceBlock.findFirst({
      where: { compilationId },
      orderBy: { order: "asc" },
      select: { order: true },
    });
    if (!firstBlock) throw new SourceDocumentReadError("当前原文文档没有 SourceBlock");
    return {
      startOrder: firstBlock.order,
      endOrder: finalBlock.order,
      label: "完整原文",
    };
  }

  const heading = await blockAt(compilationId, selection.headingBlockId);
  if (heading.headingLevel === null) {
    throw new SourceDocumentReadError(
      `SourceBlock ${selection.headingBlockId} 不是章节标题，请先读取 outline`,
    );
  }
  const nextHeading = await getDatabase().memorySourceBlock.findFirst({
    where: {
      compilationId,
      order: { gt: heading.order },
      headingLevel: { not: null, lte: heading.headingLevel },
    },
    orderBy: { order: "asc" },
    select: { order: true },
  });
  return {
    startOrder: heading.order,
    endOrder: nextHeading ? nextHeading.order - 1 : finalBlock.order,
    label: `章节：${headingTitle(heading.markdown, heading.headingPath)}`,
  };
}

export async function readSourceDocumentSelection(input: {
  compilationId: string;
  selection: SourceDocumentSelection;
  maxCharacters?: number;
  startOrder?: number;
}): Promise<SourceDocumentReadResult & { nextStartOrder?: number }> {
  const compilation = await getDatabase().memoryCompilation.findUnique({
    where: { id: input.compilationId },
    select: {
      id: true,
      sourceTitle: true,
      sourceSha256: true,
      sourceParser: true,
      sourcePageCount: true,
      sourceBlockCount: true,
    },
  });
  if (!compilation) throw new SourceDocumentReadError("当前记忆快照没有可读取的原文文档");

  const document = documentMetadata(compilation);
  const requestedMaxCharacters = Math.max(
    sourceDocumentLimits.minCharacters,
    Math.min(
      input.maxCharacters ?? sourceDocumentLimits.defaultCharacters,
      sourceDocumentLimits.maxCharacters,
    ),
  );

  if (input.selection.mode === "outline") {
    const headings = await getDatabase().memorySourceBlock.findMany({
      where: { compilationId: input.compilationId, headingLevel: { not: null } },
      orderBy: { order: "asc" },
      select: {
        sourceBlockId: true,
        order: true,
        headingLevel: true,
        headingPath: true,
        sourcePages: true,
        markdown: true,
      },
    });
    const outline: SourceDocumentOutlineEntry[] = headings.map((heading) => ({
      sourceBlockId: heading.sourceBlockId,
      order: heading.order,
      headingLevel: heading.headingLevel!,
      headingPath: [...heading.headingPath],
      title: headingTitle(heading.markdown, heading.headingPath),
      pages: [...heading.sourcePages],
    }));
    return {
      document,
      selection: { mode: "outline", label: "原文目录" },
      outline,
      blocks: [],
      requestedMaxCharacters,
      returnedCharacters: 0,
      isFullDocument: false,
      isCompleteSelection: true,
    };
  }

  const bounds = await selectionBounds(input.compilationId, input.selection);
  const effectiveStart = Math.max(bounds.startOrder, input.startOrder ?? bounds.startOrder);
  if (effectiveStart > bounds.endOrder) {
    throw new SourceDocumentReadError("续读位置已经超出本次原文选择范围");
  }
  const rows = await getDatabase().memorySourceBlock.findMany({
    where: {
      compilationId: input.compilationId,
      order: { gte: effectiveStart, lte: bounds.endOrder },
    },
    orderBy: { order: "asc" },
    select: {
      sourceBlockId: true,
      order: true,
      blockType: true,
      headingLevel: true,
      headingPath: true,
      sourcePages: true,
      markdown: true,
    },
  });

  const selected: typeof rows = [];
  let returnedCharacters = 0;
  for (const row of rows) {
    if (selected.length && returnedCharacters + row.markdown.length > requestedMaxCharacters) {
      break;
    }
    selected.push(row);
    returnedCharacters += row.markdown.length;
  }
  const next = rows[selected.length];
  const blocks = selected.map(sourceBlock);
  const startedAtSelectionBeginning = effectiveStart === bounds.startOrder;
  return {
    document,
    selection: {
      mode: input.selection.mode,
      label: bounds.label,
      startOrder: bounds.startOrder,
      endOrder: bounds.endOrder,
    },
    blocks,
    requestedMaxCharacters,
    returnedCharacters,
    isFullDocument:
      input.selection.mode === "full" && startedAtSelectionBeginning && !next,
    isCompleteSelection: !next,
    ...(next ? { nextStartOrder: next.order } : {}),
  };
}


export async function readSourceDocumentRange(input: {
  compilationId: string;
  startBlockId: string;
  endBlockId: string;
}): Promise<{ document: SourceDocumentMetadata; blocks: SourceDocumentBlock[] }> {
  const result = await readSourceDocumentSelection({
    compilationId: input.compilationId,
    selection: {
      mode: "range",
      startBlockId: input.startBlockId,
      endBlockId: input.endBlockId,
    },
    maxCharacters: sourceDocumentLimits.maxCharacters,
  });
  if (!result.isCompleteSelection) {
    throw new SourceDocumentReadError("该原文引用范围过大，无法一次打开");
  }
  return { document: result.document, blocks: result.blocks };
}
