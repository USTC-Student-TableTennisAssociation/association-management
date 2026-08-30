import type { OperationalMemoryIndex } from "@/memory/higher-memory-document";

export type MemoryFacet = {
  id: string;
  text: string;
  source: "query" | "ai";
};

export type MemoryRetrievalChannel =
  | "object-lexical"
  | "assertion-lexical"
  | "assertion-vector";

export type MemoryMatchMethod =
  | "exact"
  | "normalized-exact"
  | "alias"
  | "contains"
  | "fuzzy"
  | "vector";

export type MemorySeedMatch = {
  facetId: string;
  channel: MemoryRetrievalChannel;
  method: MemoryMatchMethod;
  rank: number;
  score: number;
  distance?: number;
};

export type MemoryAssertionKind = "grounded" | "reference";

/** Optional temporal provenance supplied by a source-aware retriever. */
export type MemorySourceTime = {
  sourceTitle: string;
  sourceSha256: string;
  text: string | null;
  supportingBlocks: Array<{
    sourceBlockId: string;
    pages: number[];
  }>;
};

export type MemoryDocumentSourceReference = {
  kind: "document";
  /** Internal document-version anchor used to reopen the exact source document. */
  sourceDocumentId: string;
  sourceTitle: string;
  sourceSha256: string;
  sourceNodeId: string;
  sourceRegionLabel: string;
  sourceBlockId: string;
  ordinal: number;
  pages: number[];
  excerpt?: string;
};

export type MemoryChatSourceReference = {
  kind: "chat";
  evidenceId: string;
  actorId: string;
  actorDisplayName: string;
  submittedAt: string;
  timezone: string;
  ordinal: number;
  excerpt?: string;
};

export type MemorySourceReference =
  | MemoryDocumentSourceReference
  | MemoryChatSourceReference;

export type MemoryObjectSeed = {
  ref: string;
  id: string;
  globalObjectKey: string;
  canonicalName: string;
  surfaceForms: string[];
  matchedBy: MemorySeedMatch[];
  matchedFacets: string[];
  supportingAssertions: string[];
  lexicalMatch: boolean;
  semanticMatch: boolean;
};

export type MemoryAssertionSeed = {
  ref: string;
  /** Database identity is present for the real Object–Assertion retriever. */
  id?: string;
  kind: MemoryAssertionKind;
  dereferenceRequired: boolean;
  sourceNodeId?: string;
  sourceClaimId: string;
  renderedStatement: string;
  contextDependent: boolean;
  matchedBy: MemorySeedMatch[];
  matchedFacets: string[];
  sources: MemorySourceReference[];
};

export type MemoryObjectAssertionConnection = {
  assertionRef: string;
  objectRef: string;
};

export type MemoryHigherMemorySeed = {
  ref: string;
  id: string;
  globalObjectId: string;
  /** Rendered Cognitive Memory for use inside one retrieval request. */
  contentMarkdown: string;
  /** Navigation hints only; never proof of query-level completeness. */
  operationalIndex: OperationalMemoryIndex;
  maintainedAt: string;
};

export type StructuredSeedMap = {
  facets: MemoryFacet[];
  sourceTime?: MemorySourceTime;
  objects: MemoryObjectSeed[];
  /** Only present for the small set of conversation-maintained important Objects. */
  higherMemories?: MemoryHigherMemorySeed[];
  assertions: MemoryAssertionSeed[];
  connections: MemoryObjectAssertionConnection[];
};

export type MemoryTraceHit = {
  facetId: string;
  targetRef: string;
  label: string;
  method: MemoryMatchMethod;
  rank: number;
  score: number;
  distance?: number;
  selected: boolean;
};

export type MemoryChannelTrace = {
  facetId: string;
  facetText: string;
  hits: MemoryTraceHit[];
};

export type MemorySemanticObjectTrace = {
  objectRef: string;
  canonicalName: string;
  supportingAssertions: string[];
  matchedFacets: string[];
};

export type MemorySearchTrace = {
  version: "structured-seed-map.v1";
  query: string;
  snapshot: {
    indexedAt: string | null;
    embeddingModel: string | null;
    embeddingRevision: string | null;
    embeddingDimension: number | null;
    embeddingAssertionCount: number;
    globalObjectCount: number;
    objectFragmentCount: number;
    surfaceFormCount: number;
    fragmentReferenceCount: number;
    assertionCount: number;
  };
  facets: MemoryFacet[];
  objectLexical: MemoryChannelTrace[];
  assertionLexical: MemoryChannelTrace[];
  assertionVector: MemoryChannelTrace[];
  semanticDerivedObjects: MemorySemanticObjectTrace[];
  finalSeedMap: {
    objectRefs: string[];
    assertionRefs: string[];
    connections: number;
  };
  answerUsedAssertionRefs: string[];
  budget: {
    facetLimit: number;
    objectHitsPerFacet: number;
    assertionLexicalHitsPerFacet: number;
    assertionVectorHitsPerFacet: number;
    assertionSeeds: number;
  };
  durationMs: number;
  warnings: string[];
};

export type MemoryQuery = {
  query: string;
  /** Assertion retrieval facets. */
  facets?: MemoryFacet[];
  /** Entity-only facets; target names must not pollute Assertion ranking. */
  objectFacets?: MemoryFacet[];
  facetWarnings?: string[];
  signal?: AbortSignal;
};

export type MemoryRetrievalResult = {
  query: string;
  mode: "disabled" | "fixture" | "object-assertion";
  seedMap: StructuredSeedMap;
  trace?: MemorySearchTrace;
};

export type EvidenceCoverage = {
  level: "complete" | "partial" | "insufficient";
  missingAspects: string[];
  /** Whether the selected source itself was read without pagination/lookup gaps. */
  observationComplete?: boolean;
  /** Presence is independent from observation completeness: a complete View may be empty. */
  contentPresence?: "present" | "absent" | "unknown";
};

export type EvidenceCoverageByLayer = Partial<Record<EvidenceLayer, EvidenceCoverage>>;

export type MemorySearchBundle = {
  mode: MemoryRetrievalResult["mode"];
  seedMap: StructuredSeedMap;
  /** Final answer citations. Kept outside the optional Locate trace. */
  answerUsedAssertionRefs?: string[];
  answerUsedHigherMemoryRefs?: string[];
  /** Server-observed retrieval coverage for this answer turn. */
  coverage?: EvidenceCoverage;
  /** Layer-scoped coverage; unlike `coverage`, later tools do not erase other layers. */
  coverageByLayer?: EvidenceCoverageByLayer;
  trace?: MemorySearchTrace;
};

export interface MemoryRetriever {
  readonly mode: MemoryRetrievalResult["mode"];
  retrieve(input: MemoryQuery): Promise<MemoryRetrievalResult>;
}

export function emptySeedMap(facets: MemoryFacet[] = []): StructuredSeedMap {
  return { facets, objects: [], assertions: [], connections: [] };
}
import type { EvidenceLayer } from "@/evidence/types";

export type { EvidenceLayer } from "@/evidence/types";
