import { getDatabase } from "@/db";
import type { MemoryExploreResult } from "@/memory/explore";
import type { SemanticViewReadSnapshot } from "@/semantic-view/types";

function searchable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function cardSearchText(card: SemanticViewReadSnapshot["cards"][number]): string {
  return searchable([
    card.objectName,
    card.cardTypeLabel,
    ...card.contentDimensions.flatMap((dimension) =>
      dimension.contentMarkdown ? [dimension.name, dimension.contentMarkdown] : [dimension.name]
    ),
    ...card.slots.flatMap((slot) => [
      slot.label,
      ...slot.targets.map((target) => target.objectName),
    ]),
  ].join(" "));
}

export async function buildBusinessContext(input: {
  snapshot: SemanticViewReadSnapshot;
  focus: string;
  targetHints: string[];
}): Promise<{
  view: {
    ref: string;
    viewKey: string;
    viewLabel: string;
    viewDescription: string;
    compatible: boolean;
    totalCardCount: number;
  };
  relevantCards: SemanticViewReadSnapshot["cards"];
  formalCardMissing: boolean;
  unresolvedAspects: string[];
  evidence: MemoryExploreResult;
}> {
  const hints = input.targetHints.map(searchable).filter(Boolean);
  const relatedCards = input.snapshot.cards.filter((card) => {
    const text = cardSearchText(card);
    return hints.some((hint) => text.includes(hint) || hint.includes(searchable(card.objectName)));
  });
  const objectIds = [...new Set(relatedCards.flatMap((card) =>
    card.objectId ? [card.objectId] : []
  ))];
  const objectRows = objectIds.length
    ? await getDatabase().memoryGlobalObject.findMany({
        where: {
          id: { in: objectIds },
          ...(input.snapshot.compilationId
            ? { compilationId: input.snapshot.compilationId }
            : {}),
        },
        select: {
          id: true,
          globalObjectKey: true,
          canonicalName: true,
          higherMemory: {
            select: { id: true, contentMarkdown: true, maintainedAt: true },
          },
        },
      })
    : [];
  const objects = objectRows.map((object, index) => ({
    ref: `O${index + 1}`,
    id: object.id,
    globalObjectKey: object.globalObjectKey,
    canonicalName: object.canonicalName,
    surfaceForms: [],
    lexicalMatch: true,
    semanticMatch: false,
  }));
  const higherMemories = objectRows.flatMap((object, index) =>
    object.higherMemory
      ? [{
          ref: `H${index + 1}`,
          id: object.higherMemory.id,
          globalObjectId: object.id,
          contentMarkdown: object.higherMemory.contentMarkdown,
          maintainedAt: object.higherMemory.maintainedAt.toISOString(),
        }]
      : []
  );
  const missingDimensions = relatedCards.flatMap((card) =>
    card.contentDimensions
      .filter((dimension) => dimension.isMissing)
      .map((dimension) => `${card.objectName}：${dimension.name}未记录`)
  );
  const unresolvedAspects = relatedCards.length
    ? [
        ...missingDimensions.slice(0, 12),
        ...(objectRows.length && higherMemories.length < objectRows.length
          ? ["部分 Card 锚定 Object 尚无 Higher Memory。"]
          : []),
      ]
    : [
        `正式 ${input.snapshot.viewLabel} 中没有匹配 ${input.targetHints.join("、")} 的 Card。`,
        `当前问题“${input.focus}”需要从 Object Higher Memory / Assertion 或原文继续补足。`,
      ];
  return {
    view: {
      ref: input.snapshot.ref,
      viewKey: input.snapshot.viewKey,
      viewLabel: input.snapshot.viewLabel,
      viewDescription: input.snapshot.viewDescription,
      compatible: input.snapshot.compatible,
      totalCardCount: input.snapshot.cards.length,
    },
    relevantCards: relatedCards,
    formalCardMissing: relatedCards.length === 0,
    unresolvedAspects,
    evidence: {
      kind: "business-context",
      mode: "object-assertion",
      ...(input.snapshot.compilationId
        ? { compilationId: input.snapshot.compilationId }
        : {}),
      query: input.focus,
      objects,
      ...(higherMemories.length ? { higherMemories } : {}),
      assertions: [],
      connections: [],
      counts: { objects: objects.length, assertions: 0, connections: 0 },
      truncated: { objects: false, assertions: false },
      warnings: [],
    },
  };
}
