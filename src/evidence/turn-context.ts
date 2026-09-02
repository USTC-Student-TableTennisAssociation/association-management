import type { ChatPageContext } from "@/ai/types";
import type {
  ViewCardListObservation,
  ViewStateObservation,
} from "@/agent-runtime/view-state-runtime";
import { EvidenceLedger } from "@/evidence/ledger";
import type { EvidenceSemantics } from "@/evidence/types";
import type {
  EvidenceCoverage,
  EvidenceCoverageByLayer,
  EvidenceLayer,
} from "@/memory/types";

function searchable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/\.[a-z0-9]{1,10}$/iu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function coverageCopy(coverage: EvidenceCoverage): EvidenceCoverage {
  return {
    level: coverage.level,
    missingAspects: unique(coverage.missingAspects.map((item) => item.trim()).filter(Boolean)),
    ...(coverage.observationComplete === undefined
      ? {}
      : { observationComplete: coverage.observationComplete }),
    ...(coverage.contentPresence === undefined
      ? {}
      : { contentPresence: coverage.contentPresence }),
  };
}

function aggregateCoverage(
  observations: readonly ScopedEvidenceCoverage[],
): EvidenceCoverageByLayer {
  const byLayer = new Map<EvidenceLayer, EvidenceCoverage[]>();
  for (const observation of observations) {
    const values = byLayer.get(observation.layer) ?? [];
    values.push(observation.coverage);
    byLayer.set(observation.layer, values);
  }
  return Object.fromEntries([...byLayer].map(([layer, values]) => {
    const level = values.every((coverage) => coverage.level === "complete")
      ? "complete" as const
      : values.every((coverage) => coverage.level === "insufficient")
        ? "insufficient" as const
        : "partial" as const;
    const contentPresence = values.some((coverage) => coverage.contentPresence === "present")
      ? "present" as const
      : values.every((coverage) => coverage.contentPresence === "absent")
        ? "absent" as const
        : "unknown" as const;
    return [layer, {
      level,
      missingAspects: unique(values.flatMap((coverage) => coverage.missingAspects)),
      observationComplete: values.every((coverage) =>
        coverage.observationComplete === true
      ),
      contentPresence,
    }];
  })) as EvidenceCoverageByLayer;
}

export type TurnEvidenceTargetKind =
  | "artifact"
  | "view_state"
  | "shared_brain"
  | "general";

export type ScopedEvidenceCoverage = {
  layer: EvidenceLayer;
  scope: string;
  coverage: EvidenceCoverage;
};

export type ViewStateGrounding = {
  ref: string;
  viewKey: string;
  viewLabel: string;
  totalCardCount: number;
  targetLabels: string[];
  matchedCardCount: number;
  contentPresence: "present" | "absent" | "unknown";
  observationComplete: boolean;
};

export type TurnEvidenceContract = {
  targetKind: TurnEvidenceTargetKind;
  requiresReadableTarget: boolean;
  targetLabel?: string;
  targetLocated: boolean;
  targetReadable: boolean;
  targetSearchRef?: string;
  coverageByScope: ScopedEvidenceCoverage[];
  coverageByLayer: EvidenceCoverageByLayer;
  evidenceSemantics: EvidenceSemantics;
  viewStateReads: ViewStateGrounding[];
  viewActionRequested: boolean;
  knowledgeInventoryObserved: boolean;
  memoryProvenance: {
    durableWriteCommitted: boolean;
    actorPrivateMemoryGrounded: boolean;
  };
};

type ArtifactSearchObservation = {
  queryTitle: string;
  purpose?: "locate" | "read" | "analyze";
  ref?: string;
  matchedCount?: number;
  truncated?: boolean;
  items: Array<{
    nodeId: string;
    name: string;
    matchKind?: string;
    ref?: string;
  }>;
};

/** Request-local evidence and provenance context. Paginated scopes retain their latest coverage. */
export class TurnEvidenceContext {
  private readonly activeLibraryNodeId?: string;
  private primaryArtifactQueryKey?: string;
  private primaryArtifactQuery?: string;
  private targetSearchRef?: string;
  private readonly targetNodeIds = new Set<string>();
  private targetLocated = false;
  private targetReadable = false;
  private readonly coverageByScope: ScopedEvidenceCoverage[] = [];
  private readonly ledger = new EvidenceLedger();
  private readonly viewStateReads: ViewStateGrounding[] = [];
  private knowledgeInventoryObserved = false;
  private durableMemoryWriteCommitted = false;
  private actorPrivateMemoryGrounded = false;
  private targetKind: TurnEvidenceTargetKind = "general";
  private requiresReadableTarget = false;
  private viewActionRequested = false;

  constructor(pageContext?: ChatPageContext) {
    this.activeLibraryNodeId = pageContext?.activePresentation === "library"
      ? pageContext.activeNodeId
      : undefined;
  }

  observeCoverage(input: {
    layer: EvidenceLayer;
    scope: string;
    coverage?: EvidenceCoverage;
  }): void {
    if (!input.coverage) return;
    this.coverageByScope.push({
      layer: input.layer,
      scope: input.scope,
      coverage: coverageCopy(input.coverage),
    });
  }

  observeSemantics(semantics: EvidenceSemantics | undefined): void {
    this.ledger.record(semantics);
  }

  observeKnowledgeInventory(): void {
    this.knowledgeInventoryObserved = true;
  }

  observeSharedBrainTarget(): void {
    if (this.targetKind === "general") this.targetKind = "shared_brain";
  }

  observeViewActionRequest(): void {
    this.viewActionRequested = true;
  }

  observeDurableMemoryWrite(): void {
    this.durableMemoryWriteCommitted = true;
  }

  observeActorPrivateMemory(): void {
    this.actorPrivateMemoryGrounded = true;
  }

  observeArtifactSearch(result: ArtifactSearchObservation): void {
    if (this.targetKind === "general" || result.purpose === "analyze") {
      this.targetKind = "artifact";
    }
    if (result.purpose === "read" || result.purpose === "analyze") {
      this.requiresReadableTarget = true;
      if (this.activeLibraryNodeId) {
        this.targetNodeIds.add(this.activeLibraryNodeId);
        this.targetLocated = true;
      }
    }
    const queryKey = searchable(result.queryTitle);
    if (!this.primaryArtifactQueryKey) {
      this.primaryArtifactQueryKey = queryKey;
      this.primaryArtifactQuery = result.queryTitle.trim();
      this.targetSearchRef = result.ref;
    }
    this.observeCoverage({
      layer: "library",
      scope: `title:${result.queryTitle}`,
      coverage: {
        level: result.truncated ? "partial" : "complete",
        missingAspects: result.truncated ? ["资料库标题查询仍有未返回结果。"] : [],
        observationComplete: !result.truncated,
        contentPresence: (result.matchedCount ?? result.items.length) > 0
          ? "present"
          : result.truncated
            ? "unknown"
            : "absent",
      },
    });
    const alignedWithPrimary = Boolean(
      queryKey && this.primaryArtifactQueryKey &&
      (queryKey.includes(this.primaryArtifactQueryKey) ||
        this.primaryArtifactQueryKey.includes(queryKey)),
    );
    if (!alignedWithPrimary) return;
    for (const item of result.items) {
      if (item.matchKind !== "exact_title") continue;
      this.targetNodeIds.add(item.nodeId);
      this.targetLocated = true;
    }
  }

  observeArtifactKnowledge(input: {
    nodeId: string;
    assertionCount: number;
    coverage?: EvidenceCoverage;
  }): void {
    this.observeCoverage({
      layer: "library",
      scope: `artifact:${input.nodeId}:published_knowledge`,
      coverage: input.coverage,
    });
    if (!this.targetNodeIds.has(input.nodeId)) return;
    this.targetLocated = true;
    if (input.assertionCount > 0) this.targetReadable = true;
  }

  observeLibraryPreview(input: {
    items: Array<{ id?: string; nodeId?: string; available?: boolean }>;
  }): void {
    for (const item of input.items) {
      const nodeId = item.nodeId ?? item.id;
      if (nodeId && item.available === true && this.targetNodeIds.has(nodeId)) {
        this.targetLocated = true;
        this.targetReadable = true;
        this.observeCoverage({
          layer: "library",
          scope: `artifact:${nodeId}:preview`,
          coverage: {
            level: "complete",
            missingAspects: [],
            observationComplete: true,
            contentPresence: "present",
          },
        });
      }
    }
  }

  observeSourceDocument(input: {
    document: { title: string };
    blocks: unknown[];
  }): void {
    if (!input.blocks.length) return;
    const titleKey = searchable(input.document.title);
    const targetKey = this.primaryArtifactQueryKey;
    const aligned = targetKey
      ? titleKey.includes(targetKey) || targetKey.includes(titleKey)
      : false;
    if (!aligned) return;
    this.targetLocated = true;
    this.targetReadable = true;
    this.observeCoverage({
      layer: "source_document",
      scope: `document:${input.document.title}`,
      coverage: {
        level: "complete",
        missingAspects: [],
        observationComplete: true,
        contentPresence: "present",
      },
    });
  }

  observeViewState(input: ViewStateObservation): void {
    if (!this.requiresReadableTarget) this.targetKind = "view_state";
    const membership = input.semantics.observations.find((observation) =>
      observation.layer === "business_view" &&
      observation.predicate === "contains_matching_card"
    );
    const scope = membership?.scope ??
      `view:${input.view.viewKey}:target:${input.targetLabels.join("+")}`;
    this.observeCoverage({
      layer: "business_view",
      scope,
      coverage: input.coverage,
    });
    this.observeSemantics(input.semantics);
    this.viewStateReads.push({
      ref: input.view.ref,
      viewKey: input.view.viewKey,
      viewLabel: input.view.viewLabel,
      totalCardCount: input.view.totalCardCount,
      targetLabels: unique(input.targetLabels.map((label) => label.trim()).filter(Boolean)),
      matchedCardCount: input.relevantCards.length,
      contentPresence: membership?.status ?? input.coverage.contentPresence ?? "unknown",
      observationComplete: membership?.completeness === "complete" ||
        input.coverage.observationComplete === true,
    });
    if (this.targetKind !== "view_state" || !input.relevantCards.length) return;
    this.targetLocated = true;
    if (input.relevantCards.some((card) =>
      Object.values(card.dimensions).some((value) =>
        value !== undefined && value !== null && value !== ""
      )
    )) {
      this.targetReadable = true;
    }
  }

  observeViewCardList(input: ViewCardListObservation): void {
    if (!this.requiresReadableTarget) this.targetKind = "view_state";
    const listing = input.semantics.observations.find((observation) =>
      observation.layer === "business_view" && observation.predicate === "lists_cards"
    );
    const scope = listing?.scope ?? `view:${input.view.viewKey}:cards:all`;
    const priorCoverageIndex = this.coverageByScope.findIndex((entry) =>
      entry.layer === "business_view" && entry.scope === scope
    );
    const nextCoverage = {
      layer: "business_view" as const,
      scope,
      coverage: coverageCopy(input.coverage),
    };
    if (priorCoverageIndex >= 0) {
      this.coverageByScope[priorCoverageIndex] = nextCoverage;
    } else {
      this.coverageByScope.push(nextCoverage);
    }
    this.observeSemantics(input.semantics);
    const grounding: ViewStateGrounding = {
      ref: input.view.ref,
      viewKey: input.view.viewKey,
      viewLabel: input.view.viewLabel,
      totalCardCount: input.view.totalCardCount,
      targetLabels: ["整个 View"],
      matchedCardCount: input.matchedCardCount,
      contentPresence: listing?.status ?? input.coverage.contentPresence ?? "unknown",
      observationComplete: listing?.completeness === "complete" ||
        input.coverage.observationComplete === true,
    };
    const priorGroundingIndex = this.viewStateReads.findIndex((read) =>
      read.viewKey === input.view.viewKey && read.targetLabels.length === 1 &&
      read.targetLabels[0] === "整个 View"
    );
    if (priorGroundingIndex >= 0) {
      this.viewStateReads[priorGroundingIndex] = grounding;
    } else {
      this.viewStateReads.push(grounding);
    }
    if (this.targetKind !== "view_state") return;
    this.targetLocated = true;
    if (input.returnedCards.length) this.targetReadable = true;
  }

  contract(): TurnEvidenceContract {
    return {
      targetKind: this.targetKind,
      requiresReadableTarget: this.requiresReadableTarget,
      ...(this.primaryArtifactQuery ? { targetLabel: this.primaryArtifactQuery } : {}),
      targetLocated: this.targetLocated,
      targetReadable: this.targetReadable,
      ...(this.targetSearchRef ? { targetSearchRef: this.targetSearchRef } : {}),
      coverageByScope: this.coverageByScope.map((entry) => ({
        layer: entry.layer,
        scope: entry.scope,
        coverage: coverageCopy(entry.coverage),
      })),
      coverageByLayer: aggregateCoverage(this.coverageByScope),
      evidenceSemantics: this.ledger.snapshot(),
      viewStateReads: this.viewStateReads.map((read) => ({
        ...read,
        targetLabels: [...read.targetLabels],
      })),
      viewActionRequested: this.viewActionRequested,
      knowledgeInventoryObserved: this.knowledgeInventoryObserved,
      memoryProvenance: {
        durableWriteCommitted: this.durableMemoryWriteCommitted,
        actorPrivateMemoryGrounded: this.actorPrivateMemoryGrounded,
      },
    };
  }

}
