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

export type MemoryTemporalAnnotation = {
  rawExpression: string;
  kind: "point" | "range" | "recurring" | "relative" | "contextual" | "unknown";
  normalizedText: string;
  start?: string;
  end?: string;
  precision: "day" | "month" | "year" | "academic_year" | "semester" | "unspecified";
  derivation: "source_explicit" | "contextual_inference" | "unresolved";
  basis: string;
};

export type MemorySourceReference = {
  sourceTitle: string;
  sourceSha256: string;
  sourceNodeId: string;
  sourceRegionLabel: string;
  sourceBlockId: string;
  ordinal: number;
  pages: number[];
  excerpt?: string;
};

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
  sourceNodeId: string;
  sourceClaimId: string;
  renderedStatement: string;
  contextDependent: boolean;
  matchedBy: MemorySeedMatch[];
  matchedFacets: string[];
  temporalAnnotations: MemoryTemporalAnnotation[];
  sources: MemorySourceReference[];
};

export type MemoryObjectAssertionConnection = {
  assertionRef: string;
  objectRef: string;
};

export type StructuredSeedMap = {
  facets: MemoryFacet[];
  objects: MemoryObjectSeed[];
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
    id: string;
    sourceTitle: string;
    sourceSha256: string;
    compiledAt: string;
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
  facets?: MemoryFacet[];
  facetWarnings?: string[];
  signal?: AbortSignal;
};

export type MemoryRetrievalResult = {
  query: string;
  mode: "disabled" | "fixture" | "object-assertion";
  /** Compilation identity retained even when a tool result omits the full Locate trace. */
  compilationId?: string;
  seedMap: StructuredSeedMap;
  trace?: MemorySearchTrace;
};

export type MemorySearchBundle = {
  mode: MemoryRetrievalResult["mode"];
  seedMap: StructuredSeedMap;
  /** Final answer citations. Kept outside the optional Locate trace. */
  answerUsedAssertionRefs?: string[];
  trace?: MemorySearchTrace;
};

export interface MemoryRetriever {
  readonly mode: MemoryRetrievalResult["mode"];
  retrieve(input: MemoryQuery): Promise<MemoryRetrievalResult>;
}

export function emptySeedMap(facets: MemoryFacet[] = []): StructuredSeedMap {
  return { facets, objects: [], assertions: [], connections: [] };
}
