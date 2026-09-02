import type {
  CardTypeDefinition,
  ViewCardState,
  ViewReadSnapshot,
} from "@/contracts";
import { getDatabase } from "@/db";
import type { EvidenceSemantics } from "@/evidence/types";
import type { MemoryExploreResult } from "@/memory/explore";
import {
  parseCognitiveMemory,
  parseOperationalMemoryIndex,
  renderCognitiveMemory,
} from "@/memory/higher-memory-document";
import type { ViewInformationReference } from "@/agent-runtime/view-types";

function searchable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function cardSearchText(card: ViewCardState, relatedObjectNames: readonly string[] = []): string {
  return searchable([
    card.cardTypeKey,
    JSON.stringify(card.dimensions),
    ...relatedObjectNames,
  ].join(" "));
}

function cardReference(
  references: readonly ViewInformationReference[],
  cardId: string,
): ViewInformationReference | undefined {
  return references.find((reference) =>
    reference.target.kind === "card" && reference.target.cardId === cardId
  );
}

function viewDescriptor(input: {
  snapshot: ViewReadSnapshot & {
    references: readonly ViewInformationReference[];
  };
  viewLabel: string;
  viewDescription: string;
  aiSemanticInstructions?: string;
}) {
  const viewReference = input.snapshot.references.find((reference) =>
    reference.target.kind === "view"
  );
  if (!viewReference) throw new Error(`View ${input.snapshot.viewKey} 缺少读取引用`);
  return {
    ref: viewReference.ref,
    viewKey: input.snapshot.viewKey,
    viewLabel: input.viewLabel,
    viewDescription: input.viewDescription,
    semanticInstructions: input.aiSemanticInstructions ?? null,
    pluginVersion: input.snapshot.pluginVersion,
    schemaVersion: input.snapshot.schemaVersion,
    stateVersion: input.snapshot.stateVersion,
    observedAt: input.snapshot.observedAt,
    totalCardCount: input.snapshot.cards.length,
  };
}

export async function buildViewCardListContext(input: {
  snapshot: ViewReadSnapshot & {
    references: readonly ViewInformationReference[];
  };
  viewLabel: string;
  viewDescription: string;
  aiSemanticInstructions?: string;
  cardTypes: readonly CardTypeDefinition[];
  cardTypeKeys?: readonly string[];
  query?: string;
  offset: number;
  limit: number;
}) {
  const knownCardTypeKeys = new Set(input.cardTypes.map((cardType) => cardType.key));
  const requestedCardTypeKeys = [...new Set(input.cardTypeKeys ?? [])];
  const unknownCardTypeKeys = requestedCardTypeKeys.filter((key) => !knownCardTypeKeys.has(key));
  if (unknownCardTypeKeys.length) {
    throw new Error(
      `View ${input.snapshot.viewKey} 不包含 Card 类型：${unknownCardTypeKeys.join("、")}`,
    );
  }
  const selectedCardTypeKeys = new Set(requestedCardTypeKeys);
  const allObjectIds = [...new Set(input.snapshot.cards.flatMap((card) => card.relatedObjectIds))];
  const allObjectRows = allObjectIds.length
    ? await getDatabase().memoryGlobalObject.findMany({
        where: { id: { in: allObjectIds } },
        select: {
          id: true,
          globalObjectKey: true,
          canonicalName: true,
        },
      })
    : [];
  const allObjectById = new Map(allObjectRows.map((object) => [object.id, object]));
  const normalizedQuery = searchable(input.query?.trim() ?? "");
  const matchingCards = input.snapshot.cards.filter((card) => {
    if (selectedCardTypeKeys.size && !selectedCardTypeKeys.has(card.cardTypeKey)) return false;
    if (!normalizedQuery) return true;
    const relatedNames = card.relatedObjectIds.flatMap((id) => {
      const object = allObjectById.get(id);
      return object ? [object.canonicalName, object.globalObjectKey] : [];
    });
    return cardSearchText(card, relatedNames).includes(normalizedQuery);
  });
  const cards = matchingCards.slice(input.offset, input.offset + input.limit);
  const truncated = input.offset + cards.length < matchingCards.length;
  const listingComplete = input.offset === 0 && !truncated;
  const cardObjectIds = new Set(cards.flatMap((card) => card.relatedObjectIds));
  const objectRows = allObjectRows.filter((object) => cardObjectIds.has(object.id));
  const view = viewDescriptor(input);
  const refs = [...new Set([
    view.ref,
    ...cards.flatMap((card) => {
      const reference = cardReference(input.snapshot.references, card.id);
      return reference ? [reference.ref] : [];
    }),
  ])];
  const filters = [
    requestedCardTypeKeys.length ? `types=${requestedCardTypeKeys.join(",")}` : "",
    normalizedQuery ? `query=${normalizedQuery}` : "",
  ].filter(Boolean).join(";") || "all";
  const scope = `view:${view.viewKey}:cards:${filters}`;
  const completeness = listingComplete ? "complete" as const : "partial" as const;
  const presence = matchingCards.length ? "present" as const : "absent" as const;
  const summary = matchingCards.length
    ? `${view.viewLabel} 中共有 ${matchingCards.length} 张符合条件的正式 Card，本页返回 ${cards.length} 张。`
    : `${view.viewLabel} 的完整正式 View 中没有符合条件的 Card。`;
  const semantics: EvidenceSemantics = {
    observations: [{
      id: `view_cards.${view.viewKey}.${searchable(filters) || "all"}`,
      layer: "business_view",
      scope,
      subject: requestedCardTypeKeys.length || normalizedQuery
        ? `符合筛选条件的 ${view.viewLabel} Card`
        : `${view.viewLabel} 的全部 Card`,
      predicate: "lists_cards",
      status: presence,
      completeness,
      authority: "authoritative",
      refs,
      summary: listingComplete ? summary : `${summary} 当前调用未覆盖完整结果范围。`,
    }],
    answerability: [{
      id: `view_cards.${view.viewKey}.${searchable(filters) || "all"}.answerability`,
      layer: "business_view",
      question: `当前 ${view.viewLabel} 中有哪些正式 Card`,
      status: listingComplete ? "answerable" : "partially_answerable",
      reason: listingComplete ? summary : "筛选总量已确定，但当前调用只返回其中一页。",
      refs,
    }],
  };
  const evidence: MemoryExploreResult = {
    kind: "business-context",
    mode: "object-assertion",
    query: input.query?.trim() || `浏览 ${view.viewLabel} 当前 Card`,
    objects: objectRows.map((object, index) => ({
      ref: `O${index + 1}`,
      id: object.id,
      globalObjectKey: object.globalObjectKey,
      canonicalName: object.canonicalName,
      surfaceForms: [],
      lexicalMatch: Boolean(normalizedQuery),
      semanticMatch: false,
    })),
    higherMemories: [],
    assertions: [],
    connections: [],
    counts: { objects: objectRows.length, assertions: 0, connections: 0 },
    truncated: { objects: false, assertions: false },
    coverage: {
      level: listingComplete ? "complete" : "partial",
      missingAspects: listingComplete ? [] : ["当前调用尚未覆盖完整 Card 结果范围。"],
      observationComplete: listingComplete,
      contentPresence: presence,
    },
    semantics,
    warnings: [],
  };
  const countsByCardType = [...matchingCards.reduce((counts, card) => {
    counts.set(card.cardTypeKey, (counts.get(card.cardTypeKey) ?? 0) + 1);
    return counts;
  }, new Map<string, number>())].map(([cardTypeKey, count]) => ({ cardTypeKey, count }));
  return {
    view,
    cards,
    matchedCount: matchingCards.length,
    countsByCardType,
    offset: input.offset,
    limit: input.limit,
    truncated,
    ...(truncated ? { nextOffset: input.offset + cards.length } : {}),
    semantics,
    evidence,
  };
}

export function describeViewStateEvidence(input: {
  viewKey: string;
  viewLabel: string;
  viewRef: string;
  totalCardCount: number;
  targetHints: readonly string[];
  relevantCards: readonly ViewCardState[];
  references: readonly ViewInformationReference[];
  unresolvedAspects: readonly string[];
}): EvidenceSemantics {
  const targets = input.targetHints.filter(Boolean).join("、") || "用户所指业务";
  const targetKey = input.targetHints.map(searchable).filter(Boolean).join("_") || "current_target";
  const matched = input.relevantCards.length > 0;
  const refs = [...new Set([
    input.viewRef,
    ...input.relevantCards.flatMap((card) => {
      const reference = cardReference(input.references, card.id);
      return reference ? [reference.ref] : [];
    }),
  ])];
  const membershipSummary = matched
    ? `${input.viewLabel} 的完整正式 View 中存在匹配“${targets}”的 Card。`
    : input.totalCardCount === 0
      ? `${input.viewLabel} 的完整正式 View 当前共有 0 个 Card，没有收录“${targets}”。`
      : `${input.viewLabel} 的完整正式 View 中没有匹配“${targets}”的 Card。`;
  const observationId = `view_state.${input.viewKey}.${targetKey}`;
  const scope = `view:${input.viewKey}:target:${targetKey}`;
  return {
    observations: [{
      id: `${observationId}.target_membership`,
      layer: "business_view",
      scope,
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
            ? `已读取匹配 Card，但仍有未记录内容：${input.unresolvedAspects.join("；")}`
            : "已完整读取匹配 Card 及其 Typed Dimensions。",
        refs,
      },
    ],
  };
}

export async function buildViewStateContext(input: {
  snapshot: ViewReadSnapshot & {
    references: readonly ViewInformationReference[];
  };
  viewLabel: string;
  viewDescription: string;
  aiSemanticInstructions?: string;
  cardTypes: readonly CardTypeDefinition[];
  focus: string;
  targetHints: readonly string[];
  targetObjectIds?: readonly string[];
  targetCardIds?: readonly string[];
  activeCardId?: string;
}) {
  const hints = input.targetHints.map(searchable).filter(Boolean);
  const targetObjectIds = new Set(input.targetObjectIds ?? []);
  const targetCardIds = new Set(input.targetCardIds ?? []);
  // Resolve every Card relationship before target filtering. A Card can be
  // intentionally sparse and identify its subject only through relatedObjectIds.
  const allObjectIds = [...new Set(input.snapshot.cards.flatMap((card) => card.relatedObjectIds))];
  const allObjectRows = allObjectIds.length
    ? await getDatabase().memoryGlobalObject.findMany({
        where: { id: { in: allObjectIds } },
        select: {
          id: true,
          globalObjectKey: true,
          canonicalName: true,
          higherMemory: {
            select: {
              id: true,
              cognitiveMemory: true,
              operationalIndex: true,
              maintainedAt: true,
            },
          },
        },
      })
    : [];
  const allObjectById = new Map(allObjectRows.map((object) => [object.id, object]));
  const directlyRelevantCards = input.snapshot.cards.filter((card) => {
    if (input.activeCardId && card.id === input.activeCardId) return true;
    if (targetCardIds.size) return targetCardIds.has(card.id);
    if (targetObjectIds.size) {
      return card.relatedObjectIds.some((id) => targetObjectIds.has(id));
    }
    if (!hints.length) return true;
    const relatedNames = card.relatedObjectIds.flatMap((id) => {
      const object = allObjectById.get(id);
      return object ? [object.canonicalName, object.globalObjectKey] : [];
    });
    const text = cardSearchText(card, relatedNames);
    return hints.some((hint) => text.includes(hint));
  });
  // A matching Card is rarely useful without the immediately linked Cards it
  // owns or belongs to. Expand exactly one relationship hop so a parent Card
  // exposes its slot contents and a child Card exposes its parent, without
  // flooding the model with an entire connected View graph.
  const directlyRelevantIds = new Set(directlyRelevantCards.map((card) => card.id));
  const linkedIds = new Set(directlyRelevantIds);
  for (const card of input.snapshot.cards) {
    const targets = Object.values(card.slots).flat();
    if (directlyRelevantIds.has(card.id)) {
      targets.forEach((targetId) => linkedIds.add(targetId));
    }
    if (targets.some((targetId) => directlyRelevantIds.has(targetId))) {
      linkedIds.add(card.id);
    }
  }
  const relevantCards = input.snapshot.cards.filter((card) => linkedIds.has(card.id));
  const objectIds = [...new Set(relevantCards.flatMap((card) => card.relatedObjectIds))];
  const objectIdSet = new Set(objectIds);
  const objectRows = allObjectRows.filter((object) => objectIdSet.has(object.id));
  const requiredDimensionsByType = new Map(input.cardTypes.map((cardType) => [
    cardType.key,
    cardType.dimensions.filter((dimension) => dimension.required),
  ]));
  const missingDimensions = relevantCards.flatMap((card) =>
    (requiredDimensionsByType.get(card.cardTypeKey) ?? []).flatMap((dimension) => {
      const value = card.dimensions[dimension.key];
      return value === undefined || value === null || value === ""
        ? [`${card.cardTypeKey}/${card.id}：${dimension.label}未记录`]
        : [];
    })
  );
  const unresolvedAspects = [
    ...new Set(missingDimensions),
    ...(objectRows.length && objectRows.some((object) => !object.higherMemory)
      ? ["部分 Card 关联 Object 尚无 Higher Memory。"]
      : []),
  ].slice(0, 16);
  const references = input.snapshot.references;
  const view = viewDescriptor(input);
  const semantics = describeViewStateEvidence({
    viewKey: view.viewKey,
    viewLabel: view.viewLabel,
    viewRef: view.ref,
    totalCardCount: view.totalCardCount,
    targetHints: input.targetHints,
    relevantCards,
    references,
    unresolvedAspects,
  });
  const evidence: MemoryExploreResult = {
    kind: "business-context",
    mode: "object-assertion",
    query: input.focus,
    objects: objectRows.map((object, index) => ({
      ref: `O${index + 1}`,
      id: object.id,
      globalObjectKey: object.globalObjectKey,
      canonicalName: object.canonicalName,
      surfaceForms: [],
      lexicalMatch: true,
      semanticMatch: false,
    })),
    higherMemories: objectRows.flatMap((object, index) =>
      object.higherMemory
      ? [{
          ref: `H${index + 1}`,
          id: object.higherMemory.id,
          globalObjectId: object.id,
          contentMarkdown: renderCognitiveMemory(
            parseCognitiveMemory(object.higherMemory.cognitiveMemory),
          ),
          operationalIndex: parseOperationalMemoryIndex(object.higherMemory.operationalIndex),
          maintainedAt: object.higherMemory.maintainedAt.toISOString(),
        }]
      : []),
    assertions: [],
    connections: [],
    counts: { objects: objectRows.length, assertions: 0, connections: 0 },
    truncated: { objects: false, assertions: false },
    coverage: {
      level: relevantCards.length && unresolvedAspects.length ? "partial" : "complete",
      missingAspects: relevantCards.length ? unresolvedAspects : [],
      observationComplete: true,
      contentPresence: relevantCards.length ? "present" : "absent",
    },
    semantics,
    warnings: [],
  };
  return {
    view,
    relevantCards,
    formalCardMissing: relevantCards.length === 0,
    unresolvedAspects,
    semantics,
    evidence,
  };
}
