import { z } from "zod";

import { operationalMemoryIndexSchema } from "@/memory/higher-memory-document";
import type { MemorySearchBundle } from "@/memory/types";

const facetSchema = z.object({
  id: z.string(),
  text: z.string(),
  source: z.enum(["query", "ai"]),
});

const matchSchema = z.object({
  facetId: z.string(),
  channel: z.enum(["object-lexical", "assertion-lexical", "assertion-vector"]),
  method: z.enum(["exact", "normalized-exact", "alias", "contains", "fuzzy", "vector"]),
  rank: z.number().int(),
  score: z.number(),
  distance: z.number().optional(),
});

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("document"),
    sourceDocumentId: z.string(),
    sourceTitle: z.string(),
    sourceSha256: z.string(),
    sourceNodeId: z.string(),
    sourceRegionLabel: z.string(),
    sourceBlockId: z.string(),
    ordinal: z.number().int(),
    pages: z.array(z.number()),
    excerpt: z.string().optional(),
  }),
  z.object({
    kind: z.literal("chat"),
    evidenceId: z.string(),
    actorId: z.string(),
    actorDisplayName: z.string(),
    submittedAt: z.string(),
    timezone: z.string(),
    ordinal: z.number().int(),
    excerpt: z.string().optional(),
  }),
]);

const seedMapSchema = z.object({
  facets: z.array(facetSchema),
  sourceTime: z.object({
    sourceTitle: z.string(),
    sourceSha256: z.string(),
    text: z.string().nullable(),
    supportingBlocks: z.array(z.object({
      sourceBlockId: z.string(),
      pages: z.array(z.number()),
    })),
  }).optional(),
  objects: z.array(z.object({
    ref: z.string(),
    id: z.string(),
    globalObjectKey: z.string(),
    canonicalName: z.string(),
    surfaceForms: z.array(z.string()),
    matchedBy: z.array(matchSchema),
    matchedFacets: z.array(z.string()),
    supportingAssertions: z.array(z.string()),
    lexicalMatch: z.boolean(),
    semanticMatch: z.boolean(),
  })),
  higherMemories: z.array(z.object({
    ref: z.string(),
    id: z.string(),
    globalObjectId: z.string(),
    contentMarkdown: z.string(),
    operationalIndex: operationalMemoryIndexSchema,
    maintainedAt: z.string(),
  })).optional(),
  assertions: z.array(z.object({
    ref: z.string(),
    id: z.string().optional(),
    kind: z.enum(["grounded", "reference"]),
    dereferenceRequired: z.boolean(),
    sourceNodeId: z.string().optional(),
    sourceClaimId: z.string(),
    renderedStatement: z.string(),
    contextDependent: z.boolean(),
    matchedBy: z.array(matchSchema),
    matchedFacets: z.array(z.string()),
    sources: z.array(sourceSchema),
  })),
  connections: z.array(z.object({
    assertionRef: z.string(),
    objectRef: z.string(),
  })),
});

const traceHitSchema = z.object({
  facetId: z.string(),
  targetRef: z.string(),
  label: z.string(),
  method: z.enum(["exact", "normalized-exact", "alias", "contains", "fuzzy", "vector"]),
  rank: z.number().int(),
  score: z.number(),
  distance: z.number().optional(),
  selected: z.boolean(),
});

const channelTraceSchema = z.object({
  facetId: z.string(),
  facetText: z.string(),
  hits: z.array(traceHitSchema),
});

const traceSchema = z.object({
  version: z.literal("structured-seed-map.v1"),
  query: z.string(),
  snapshot: z.object({
    indexedAt: z.string().nullable(),
    embeddingModel: z.string().nullable(),
    embeddingRevision: z.string().nullable(),
    embeddingDimension: z.number().int().nullable(),
    embeddingAssertionCount: z.number().int(),
    globalObjectCount: z.number().int(),
    objectFragmentCount: z.number().int(),
    surfaceFormCount: z.number().int(),
    fragmentReferenceCount: z.number().int(),
    assertionCount: z.number().int(),
  }),
  facets: z.array(facetSchema),
  objectLexical: z.array(channelTraceSchema),
  assertionLexical: z.array(channelTraceSchema),
  assertionVector: z.array(channelTraceSchema),
  semanticDerivedObjects: z.array(z.object({
    objectRef: z.string(),
    canonicalName: z.string(),
    supportingAssertions: z.array(z.string()),
    matchedFacets: z.array(z.string()),
  })),
  finalSeedMap: z.object({
    objectRefs: z.array(z.string()),
    assertionRefs: z.array(z.string()),
    connections: z.number().int(),
  }),
  answerUsedAssertionRefs: z.array(z.string()),
  budget: z.object({
    facetLimit: z.number().int(),
    objectHitsPerFacet: z.number().int(),
    assertionLexicalHitsPerFacet: z.number().int(),
    assertionVectorHitsPerFacet: z.number().int(),
    assertionSeeds: z.number().int(),
  }),
  durationMs: z.number().int(),
  warnings: z.array(z.string()),
});

const evidenceCoverageSchema = z.object({
  level: z.enum(["complete", "partial", "insufficient"]),
  missingAspects: z.array(z.string()),
  observationComplete: z.boolean().optional(),
  contentPresence: z.enum(["present", "absent", "unknown"]).optional(),
});

/** Runtime schema for the cognition data part persisted in chat UI messages. */
export const memorySearchBundleSchema: z.ZodType<MemorySearchBundle> = z.object({
  mode: z.enum(["disabled", "fixture", "object-assertion"]),
  seedMap: seedMapSchema,
  answerUsedAssertionRefs: z.array(z.string()).optional(),
  answerUsedHigherMemoryRefs: z.array(z.string()).optional(),
  coverage: evidenceCoverageSchema.optional(),
  coverageByLayer: z.object({
    business_view: evidenceCoverageSchema.optional(),
    library: evidenceCoverageSchema.optional(),
    shared_brain: evidenceCoverageSchema.optional(),
    source_document: evidenceCoverageSchema.optional(),
  }).optional(),
  trace: traceSchema.optional(),
});
