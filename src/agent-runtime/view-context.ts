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

export function describeViewContextEvidence(input: {
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
  const observationId = `business_view.${input.viewKey}.${targetKey}`;
  return {
    observations: [{
      id: `${observationId}.target_membership`,
      layer: "business_view",
      scope: input.viewKey,
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

export async function buildViewContext(input: {
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
  activeCardId?: string;
}) {
  const hints = input.targetHints.map(searchable).filter(Boolean);
  const targetObjectIds = new Set(input.targetObjectIds ?? []);
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
  const viewReference = references.find((reference) => reference.target.kind === "view");
  if (!viewReference) throw new Error(`View ${input.snapshot.viewKey} 缺少读取引用`);
  const view = {
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
  const semantics = describeViewContextEvidence({
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
