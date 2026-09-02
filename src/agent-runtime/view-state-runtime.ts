import type { ChatPageContext } from "@/ai/types";
import type { ViewReadSnapshot } from "@/contracts";
import type { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import type { MemoryExploreResult } from "@/memory/explore";
import type { EvidenceSemantics } from "@/evidence/types";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import {
  buildViewCardListContext,
  buildViewStateContext,
} from "@/agent-runtime/view-context";
import { loadViewHigherMemory } from "@/agent-runtime/view-higher-memory";
import type { ViewInformationReference } from "@/agent-runtime/view-types";

export type ViewStateTarget = {
  kind: "name" | "object_ref" | "card_ref";
  value: string;
};

export type ViewCardListRequest = {
  viewKey: string;
  cardTypeKeys?: string[];
  query?: string;
  offset: number;
  limit: number;
};

export type ViewStateReadRequest = {
  viewKey: string;
  question: string;
  targets: ViewStateTarget[];
};

export type ViewStateObservation = {
  view: {
    ref: string;
    viewKey: string;
    viewLabel: string;
    totalCardCount: number;
  };
  targetLabels: string[];
  relevantCards: Array<{
    ref?: string;
    dimensions: Readonly<Record<string, unknown>>;
  }>;
  coverage: NonNullable<MemoryExploreResult["coverage"]>;
  semantics: EvidenceSemantics;
};

export type ViewCardListObservation = {
  view: ViewStateObservation["view"];
  matchedCardCount: number;
  returnedCards: ViewStateObservation["relevantCards"];
  coverage: NonNullable<MemoryExploreResult["coverage"]>;
  semantics: EvidenceSemantics;
};

type SnapshotWithReferences = ViewReadSnapshot & {
  references: readonly ViewInformationReference[];
};

export function createViewStateRuntime(input: {
  registry: ExtensionRegistry;
  evidence: MemoryEvidenceAccumulator;
  userQuery: string;
  pageContext?: ChatPageContext;
  readSnapshot: (viewKey: string) => Promise<SnapshotWithReferences>;
  resolveCardReference: (ref: string) => {
    ref: string;
    label: string;
    viewKey: string;
    cardId: string;
  } | undefined;
  presentCards: (
    cards: readonly ViewReadSnapshot["cards"][number][],
    objectRefById?: ReadonlyMap<string, string>,
  ) => Array<{
    ref?: string;
    cardTypeKey: string;
    dimensions: Readonly<Record<string, unknown>>;
    slots: Record<string, string[]>;
    relatedObjectRefs: string[];
  }>;
  onObserved: (observation: ViewStateObservation) => void;
  onListObserved: (observation: ViewCardListObservation) => void;
}) {
  const listedRangesByScope = new Map<string, Array<[number, number]>>();
  return {
    async list(request: ViewCardListRequest) {
      const viewModule = input.registry.getView(request.viewKey);
      if (!viewModule) throw new Error(`View ${request.viewKey} 未注册或未启用`);
      const snapshot = await input.readSnapshot(request.viewKey);
      const rawListContext = await buildViewCardListContext({
        snapshot,
        viewLabel: viewModule.manifest.label,
        viewDescription: viewModule.manifest.description,
        aiSemanticInstructions: viewModule.manifest.aiSemanticInstructions,
        cardTypes: viewModule.schema.cardTypes,
        cardTypeKeys: request.cardTypeKeys,
        query: request.query,
        offset: request.offset,
        limit: request.limit,
      });
      const listingObservation = rawListContext.semantics.observations.find((observation) =>
        observation.predicate === "lists_cards"
      );
      const listingScope = listingObservation?.scope ??
        `view:${request.viewKey}:cards:${request.cardTypeKeys?.join(",") ?? "all"}`;
      const ranges = [
        ...(listedRangesByScope.get(listingScope) ?? []),
        [rawListContext.offset, rawListContext.offset + rawListContext.cards.length] as [number, number],
      ].sort((left, right) => left[0] - right[0]);
      const mergedRanges: Array<[number, number]> = [];
      for (const range of ranges) {
        const previous = mergedRanges.at(-1);
        if (!previous || range[0] > previous[1]) {
          mergedRanges.push([...range]);
        } else {
          previous[1] = Math.max(previous[1], range[1]);
        }
      }
      listedRangesByScope.set(listingScope, mergedRanges);
      const listingComplete = rawListContext.matchedCount === 0 ||
        (mergedRanges[0]?.[0] === 0 && mergedRanges[0][1] >= rawListContext.matchedCount);
      const coverage = {
        level: listingComplete ? "complete" as const : "partial" as const,
        missingAspects: listingComplete ? [] : ["仍有 Card 分页范围尚未返回。"],
        observationComplete: listingComplete,
        contentPresence: rawListContext.matchedCount ? "present" as const : "absent" as const,
      };
      const semantics: EvidenceSemantics = {
        observations: rawListContext.semantics.observations.map((observation) =>
          observation.predicate === "lists_cards"
            ? {
                ...observation,
                completeness: listingComplete ? "complete" as const : "partial" as const,
                summary: listingComplete
                  ? `${rawListContext.view.viewLabel} 中符合条件的 ${rawListContext.matchedCount} 张正式 Card 已全部返回。`
                  : `${rawListContext.view.viewLabel} 中符合条件的 Card 仍有分页范围尚未返回。`,
              }
            : observation
        ),
        answerability: rawListContext.semantics.answerability.map((answerability) => ({
          ...answerability,
          status: listingComplete ? "answerable" as const : "partially_answerable" as const,
          reason: listingComplete
            ? "符合条件的 Card 已全部返回。"
            : "筛选总量已确定，但仍有分页范围尚未返回。",
        })),
      };
      const listContext = {
        ...rawListContext,
        semantics,
        evidence: {
          ...rawListContext.evidence,
          coverage,
          semantics,
        },
      };
      input.onListObserved({
        view: listContext.view,
        matchedCardCount: listContext.matchedCount,
        returnedCards: listContext.cards,
        coverage: listContext.evidence.coverage!,
        semantics: listContext.semantics,
      });
      const discovered = input.evidence.merge(listContext.evidence);
      const objectRefById = new Map(
        discovered.objects.map((object) => [object.id, object.ref] as const),
      );
      return {
        output: {
          view: {
            ref: listContext.view.ref,
            key: listContext.view.viewKey,
            label: listContext.view.viewLabel,
            observedAt: listContext.view.observedAt,
            totalCardCount: listContext.view.totalCardCount,
          },
          selection: {
            matchedCount: listContext.matchedCount,
            returnedCount: listContext.cards.length,
            countsByCardType: listContext.countsByCardType,
            offset: listContext.offset,
            limit: listContext.limit,
            truncated: listContext.truncated,
            ...(listContext.nextOffset === undefined
              ? {}
              : { nextOffset: listContext.nextOffset }),
          },
          cards: input.presentCards(listContext.cards, objectRefById),
          ...(discovered.objects.length ? { relatedObjects: discovered.objects } : {}),
        },
        discovered,
      };
    },
    async read(request: ViewStateReadRequest) {
      const viewModule = input.registry.getView(request.viewKey);
      if (!viewModule) throw new Error(`View ${request.viewKey} 未注册或未启用`);

      const objectTargets = request.targets
        .filter((target) => target.kind === "object_ref")
        .map((target) => {
          const object = input.evidence.objectForModelReference(target.value);
          if (!object) {
            throw new Error(
              `Object 引用 ${target.value} 尚未出现在本轮知识或 View 状态中；请先检索并使用真实 O#`,
            );
          }
          return object;
        });
      const nameTargets = request.targets
        .filter((target) => target.kind === "name")
        .map((target) => target.value.trim())
        .filter(Boolean);
      const cardTargets = request.targets
        .filter((target) => target.kind === "card_ref")
        .map((target) => {
          const card = input.resolveCardReference(target.value);
          if (!card) {
            throw new Error(
              `Card 引用 ${target.value} 尚未由本轮 listViewCards 或 readViewState 返回；请使用真实 V#`,
            );
          }
          if (card.viewKey !== request.viewKey) {
            throw new Error(
              `Card 引用 ${target.value} 属于 View ${card.viewKey}，不能用于读取 ${request.viewKey}`,
            );
          }
          return card;
        });
      const refersToCurrentPage = /(这个|这份|这里|当前|该节点|该对象|此处|本页)/u
        .test(input.userQuery);
      const searchTargetLabels = [...new Set([
        ...nameTargets,
        ...objectTargets.map((object) => object.canonicalName),
        ...(refersToCurrentPage && input.pageContext?.activeObjectName
          ? [input.pageContext.activeObjectName]
          : []),
      ])];
      const targetLabels = [...new Set([
        ...searchTargetLabels,
        ...cardTargets.map((card) => card.label),
      ])];
      if (!targetLabels.length && !objectTargets.length && !cardTargets.length) {
        throw new Error("readViewState 必须包含至少一个具体业务实体目标");
      }

      const [snapshot, viewHigherMemory] = await Promise.all([
        input.readSnapshot(request.viewKey),
        loadViewHigherMemory(request.viewKey),
      ]);
      const stateContext = await buildViewStateContext({
        snapshot,
        viewLabel: viewModule.manifest.label,
        viewDescription: viewModule.manifest.description,
        aiSemanticInstructions: viewModule.manifest.aiSemanticInstructions,
        cardTypes: viewModule.schema.cardTypes,
        focus: request.question,
        targetHints: searchTargetLabels,
        targetObjectIds: objectTargets.map((object) => object.id),
        targetCardIds: cardTargets.map((card) => card.cardId),
        activeCardId: refersToCurrentPage
          ? input.pageContext?.activeCardId
          : undefined,
      });
      input.onObserved({
        view: stateContext.view,
        targetLabels,
        relevantCards: stateContext.relevantCards,
        coverage: stateContext.evidence.coverage!,
        semantics: stateContext.semantics,
      });
      const discovered = input.evidence.merge(stateContext.evidence);
      const objectRefById = new Map(
        discovered.objects.map((object) => [object.id, object.ref] as const),
      );
      const matchingCards = input.presentCards(
        stateContext.relevantCards,
        objectRefById,
      );

      return {
        output: {
          view: {
            ref: stateContext.view.ref,
            key: stateContext.view.viewKey,
            label: stateContext.view.viewLabel,
            observedAt: stateContext.view.observedAt,
            cardCount: stateContext.view.totalCardCount,
          },
          targets: targetLabels,
          matchingCards,
          ...(viewHigherMemory ? { viewHigherMemory } : {}),
          ...(discovered.objects.length
            ? { relatedObjects: discovered.objects }
            : {}),
          ...(discovered.higherMemories?.length
            ? { objectHigherMemories: discovered.higherMemories }
            : {}),
          ...(stateContext.unresolvedAspects.length
            ? { missingDetails: stateContext.unresolvedAspects }
            : {}),
        },
        discovered,
      };
    },
  };
}
