import { z } from "zod";

import { libraryProcessingProfileSchema } from "@/library/types";

export const libraryProcessingStageSchema = z.enum([
  "queued",
  "preparing",
  "parsing",
  "analyzing",
  "resolving",
  "staging",
  "ready",
  "failed",
]);

export const libraryReferenceCandidateSchema = z.object({
  statement: z.string().trim().min(1).max(1_000),
  sourceExcerpt: z.string().trim().min(1).max(4_000),
  sourceKind: z.enum(["text_excerpt", "visual_observation", "file_context"]),
  objectLabels: z.array(z.string().trim().min(1).max(200)),
});

export const libraryAssertionCandidateSchema = z.object({
  statement: z.string().trim().min(1).max(1_000),
  sourceExcerpt: z.string().trim().min(1).max(2_000),
  objectLabels: z.array(z.string().trim().min(1).max(200)).min(1),
  contextDependent: z.boolean(),
});

const libraryObjectCandidateBaseSchema = z.object({
  label: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1_000),
});

export const libraryObjectCandidateSchema = z.discriminatedUnion("action", [
  libraryObjectCandidateBaseSchema.extend({
    action: z.literal("bind_existing"),
    existingObjectId: z.string().uuid(),
  }),
  libraryObjectCandidateBaseSchema.extend({
    action: z.literal("new_candidate"),
  }),
]);

export const libraryCompilationAssessmentSchema = z.object({
  summary: z.string().trim().min(1).max(1_500),
  referenceCandidates: z.array(libraryReferenceCandidateSchema),
  assertionCandidates: z.array(libraryAssertionCandidateSchema),
  objectCandidates: z.array(libraryObjectCandidateSchema),
});

const libraryEvidenceIdSchema = z.string().regex(/^[SF]\d{4}$/u);
const libraryModelObjectLabelSchema = z.string().trim().min(1).max(200).refine(
  (value) => /[\p{L}\p{N}]/u.test(value),
  "Object 名称必须包含文字或数字",
).refine(
  (value) => !/^(?:bind_existing|new_candidate)\s*[:：]/iu.test(value),
  "Object 名称不能包含 action 前缀",
);
const libraryModelReferenceCandidateSchema = z.object({
  statement: z.string().trim().min(1).max(1_000),
  sourceId: libraryEvidenceIdSchema,
  objectLabels: z.array(libraryModelObjectLabelSchema).min(1),
});
const libraryModelAssertionCandidateSchema = z.object({
  statement: z.string().trim().min(1).max(1_000),
  sourceId: libraryEvidenceIdSchema,
  objectLabels: z.array(libraryModelObjectLabelSchema).min(1),
  contextDependent: z.boolean(),
});

/** 模型只选择证据编号和 Object 名称；最终摘录和 Object 闭环由服务端物化。 */
export const libraryCatalogCompilationOutputSchema = z.object({
  summary: z.string().trim().min(1).max(1_500),
  referenceCandidates: z.array(libraryModelReferenceCandidateSchema),
});

export const libraryCoarseCompilationOutputSchema = z.object({
  summary: z.string().trim().min(1).max(1_500),
  referenceCandidates: z.array(libraryModelReferenceCandidateSchema).min(1),
  assertionCandidates: z.array(libraryModelAssertionCandidateSchema),
});

export const libraryVisualObservationOutputSchema = z.object({
  summary: z.string().trim().min(1).max(1_500),
  visibleText: z.string().max(12_000),
  observations: z.array(z.object({
    statement: z.string().trim().min(1).max(1_000),
    evidenceRegion: z.string().trim().min(1).max(300).optional(),
  })).max(24),
  uncertainties: z.array(z.string().trim().min(1).max(500)).max(12),
});

export type LibraryVisualObservationOutput = z.infer<
  typeof libraryVisualObservationOutputSchema
>;

export type LibraryCompilationAssessment = z.infer<
  typeof libraryCompilationAssessmentSchema
>;

export type LibraryCatalogCompilationOutput = z.infer<
  typeof libraryCatalogCompilationOutputSchema
>;

export type LibraryCoarseCompilationOutput = z.infer<
  typeof libraryCoarseCompilationOutputSchema
>;

export type LibraryCompilationJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type LibraryCompilationInventory = {
  fileNodes: number;
  uniqueContent: number;
  duplicateNodes: number;
  deep: number;
  coarse: number;
  catalog: number;
};

export const libraryCompilationSelectionSchema = z.object({
  sourceBlobId: z.string().uuid(),
  profile: libraryProcessingProfileSchema,
});

export const createLibraryCompilationJobInputSchema = z.object({
  selections: z.array(libraryCompilationSelectionSchema).min(1).max(2_000),
});

export type LibraryCompilationSelection = z.infer<
  typeof libraryCompilationSelectionSchema
>;

export type LibraryCompilationCandidate = {
  sourceBlobId: string;
  representativeNodeId: string;
  nodeName: string;
  originalRelativePath?: string;
  mimeType: string;
  byteSize: string;
  duplicateNodeCount: number;
  profile: "catalog" | "coarse" | "deep";
};

export type LibraryCompilationRunView = {
  id: string;
  profile: "catalog" | "coarse" | "deep";
  status: "idle" | "queued" | "running" | "ready" | "failed";
  stage: z.infer<typeof libraryProcessingStageSchema>;
  progressCurrent: number;
  progressTotal: number;
  retryCount: number;
  statusMessage?: string;
  nodeId: string;
  nodeName: string;
  originalRelativePath?: string;
  mimeType: string;
  byteSize: string;
  resultSummary?: string;
  errorMessage?: string;
  publishedAt?: string;
  publishedAssertionCount: number;
  publishedObjectCount: number;
  modelRetries: {
    text: number;
    vision: number;
    lastError?: string;
    lastFailedAt?: string;
  };
  parallelUnits: LibraryCompilationParallelUnit[];
  assessment?: {
    summary: string;
    referenceCandidateCount: number;
    assertionCandidateCount: number;
    objectCandidateCount: number;
  };
};

export type LibraryCompilationParallelUnit = {
  id: string;
  kind: "source" | "global_object";
  statusMessage: string;
};

export type LibraryCompilationJobView = {
  id: string;
  status: LibraryCompilationJobStatus;
  recoverable: boolean;
  activePhase?: "catalog" | "coarse" | "deep";
  activeStage?: string;
  pauseRequested: boolean;
  totalContent: number;
  completedContent: number;
  failedContent: number;
  phases: {
    deep: { total: number; completed: number };
    coarse: { total: number; completed: number };
    catalog: { total: number; completed: number };
  };
  globalResolution: {
    status: string;
    progress: number;
    total: number;
    retryCount: number;
    statusMessage?: string;
    errorMessage?: string;
    objectCount: number;
  };
  createdAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  completedAt?: string;
  errorMessage?: string;
  activeRun?: LibraryCompilationRunView;
  activeRuns: LibraryCompilationRunView[];
  concurrency: {
    deepFiles: number;
    deepSources: number;
    coarseFiles: number;
    catalogFiles: number;
    textModels: number;
    visionModels: number;
    coldStartModels: number;
    globalObjects: number;
  };
  recentRuns: LibraryCompilationRunView[];
  failureRuns: LibraryCompilationRunView[];
};

export type LibraryCompilationOverview = {
  inventory: LibraryCompilationInventory;
  modelConfiguration: {
    text: { configured: boolean; modelId?: string };
    vision: { configured: boolean; modelId?: string };
  };
  candidates?: LibraryCompilationCandidate[];
  job?: LibraryCompilationJobView;
};
