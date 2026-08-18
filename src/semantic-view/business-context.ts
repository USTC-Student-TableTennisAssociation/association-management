import { getDatabase } from "@/db";
import type { EvidenceSemantics } from "@/evidence/types";
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

export function describeBusinessContextEvidence(input: {
  view: {
    ref: string;
    viewKey: string;
    viewLabel: string;
    totalCardCount: number;
  };
  targetHints: string[];
  relevantCards: SemanticViewReadSnapshot["cards"];
  unresolvedAspects: string[];
}): EvidenceSemantics {
  const targets = input.targetHints.filter(Boolean).join("、") || "用户所指业务";
  const targetKey = input.targetHints.map(searchable).filter(Boolean).join("_") || "current_target";
  const observationId = `business_view.${input.view.viewKey}.${targetKey}`;
  const matched = input.relevantCards.length > 0;
  const refs = [
    input.view.ref,
    ...input.relevantCards.map((card) => card.ref),
  ].filter((ref, index, all) => all.indexOf(ref) === index);
  const membershipSummary = matched
    ? `${input.view.viewLabel} 的完整正式 View 中存在匹配“${targets}”的 Card。`
    : input.view.totalCardCount === 0
      ? `${input.view.viewLabel} 的完整正式 View 当前共有 0 个 Card，没有收录“${targets}”。`
      : `${input.view.viewLabel} 的完整正式 View 中没有匹配“${targets}”的 Card。`;
  return {
    observations: [{
      id: `${observationId}.target_membership`,
      layer: "business_view",
      scope: input.view.viewKey,
      subject: targets,
      predicate: "contains_matching_card",
      status: matched ? "present" : "absent",
      completeness: "complete",
      authority: "authoritative",
      refs,
      summary: membershipSummary,
    }],
    answerability: [
      {
        id: `${observationId}.target_membership`,
        layer: "business_view",
        question: `正式 Business View 是否收录“${targets}”`,
        status: "answerable",
        reason: membershipSummary,
        refs,
      },
      {
        id: `${observationId}.target_clarity`,
        layer: "business_view",
        question: `已收录的“${targets}”业务内容是否表达清楚`,
        status: !matched
          ? "not_applicable"
          : input.unresolvedAspects.length
            ? "partially_answerable"
            : "answerable",
        reason: !matched
          ? "不存在匹配的正式 Card，因此不能把问题解释为已有条目表述不清。"
          : input.unresolvedAspects.length
            ? `已读取匹配 Card，但仍有未记录维度：${input.unresolvedAspects.join("；")}`
            : "已完整读取匹配 Card 及其正式内容维度。",
        refs,
      },
    ],
  };
}

export async function buildBusinessContext(input: {
  snapshot: SemanticViewReadSnapshot;
  focus: string;
  targetHints: string[];
  activeCardId?: string;
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
  semantics: EvidenceSemantics;
  evidence: MemoryExploreResult;
}> {
  const hints = input.targetHints.map(searchable).filter(Boolean);
  const relatedCards = input.snapshot.cards.filter((card) => {
    if (input.activeCardId && card.id === input.activeCardId) return true;
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
    : [];
  const view = {
    ref: input.snapshot.ref,
    viewKey: input.snapshot.viewKey,
    viewLabel: input.snapshot.viewLabel,
    viewDescription: input.snapshot.viewDescription,
    compatible: input.snapshot.compatible,
    totalCardCount: input.snapshot.cards.length,
  };
  const semantics = describeBusinessContextEvidence({
    view,
    targetHints: input.targetHints,
    relevantCards: relatedCards,
    unresolvedAspects,
  });
  return {
    view,
    relevantCards: relatedCards,
    formalCardMissing: relatedCards.length === 0,
    unresolvedAspects,
    semantics,
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
      coverage: {
        level: relatedCards.length && unresolvedAspects.length
            ? "partial"
            : "complete",
        missingAspects: relatedCards.length ? [...unresolvedAspects] : [],
        observationComplete: true,
        contentPresence: relatedCards.length ? "present" : "absent",
      },
      semantics,
      warnings: [],
    },
  };
}
