CREATE TYPE "LibraryCompilationJobStatus" AS ENUM ('queued', 'running', 'paused', 'awaiting_review', 'completed', 'failed');
CREATE TYPE "LibraryProcessingStage" AS ENUM ('queued', 'preparing', 'parsing', 'analyzing', 'resolving', 'staging', 'review_required', 'ready', 'failed');
CREATE TYPE "LibrarySemanticStatus" AS ENUM ('meaningful', 'ambiguous', 'no_signal', 'unsupported', 'failed');

CREATE TABLE "library_compilation_jobs" (
  "id" UUID NOT NULL,
  "status" "LibraryCompilationJobStatus" NOT NULL DEFAULT 'queued',
  "active_phase" "LibraryProcessingProfile",
  "pause_requested" BOOLEAN NOT NULL DEFAULT false,
  "total_content" INTEGER NOT NULL DEFAULT 0,
  "completed_content" INTEGER NOT NULL DEFAULT 0,
  "failed_content" INTEGER NOT NULL DEFAULT 0,
  "review_content" INTEGER NOT NULL DEFAULT 0,
  "deep_total" INTEGER NOT NULL DEFAULT 0,
  "deep_completed" INTEGER NOT NULL DEFAULT 0,
  "coarse_total" INTEGER NOT NULL DEFAULT 0,
  "coarse_completed" INTEGER NOT NULL DEFAULT 0,
  "catalog_total" INTEGER NOT NULL DEFAULT 0,
  "catalog_completed" INTEGER NOT NULL DEFAULT 0,
  "configuration" JSONB NOT NULL DEFAULT '{}',
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "heartbeat_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "library_compilation_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "library_compilation_jobs_status_created_at_idx" ON "library_compilation_jobs"("status", "created_at");

ALTER TABLE "library_source_processing_runs"
  ADD COLUMN "source_blob_id" UUID,
  ADD COLUMN "job_id" UUID,
  ADD COLUMN "stage" "LibraryProcessingStage" NOT NULL DEFAULT 'queued',
  ADD COLUMN "phase_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "progress_current" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "progress_total" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "status_message" TEXT;

CREATE INDEX "library_source_processing_runs_job_id_phase_order_status_idx"
  ON "library_source_processing_runs"("job_id", "phase_order", "status");
CREATE UNIQUE INDEX "library_source_processing_runs_job_id_source_blob_id_key"
  ON "library_source_processing_runs"("job_id", "source_blob_id");

ALTER TABLE "library_source_processing_runs" ADD CONSTRAINT "library_source_processing_runs_source_blob_id_fkey"
  FOREIGN KEY ("source_blob_id") REFERENCES "library_source_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "library_source_processing_runs" ADD CONSTRAINT "library_source_processing_runs_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "library_compilation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "library_catalog_assessments" (
  "id" UUID NOT NULL,
  "processing_run_id" UUID NOT NULL,
  "source_blob_id" UUID NOT NULL,
  "representative_node_id" UUID NOT NULL,
  "semantic_status" "LibrarySemanticStatus" NOT NULL,
  "summary" TEXT NOT NULL,
  "preview_excerpt" TEXT,
  "recommended_profile" "LibraryProcessingProfile" NOT NULL,
  "confidence" DOUBLE PRECISION,
  "reference_candidates" JSONB NOT NULL DEFAULT '[]',
  "assertion_candidates" JSONB NOT NULL DEFAULT '[]',
  "object_candidates" JSONB NOT NULL DEFAULT '[]',
  "needs_review" BOOLEAN NOT NULL DEFAULT false,
  "review_reason" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "library_catalog_assessments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "library_catalog_assessments_processing_run_id_key" ON "library_catalog_assessments"("processing_run_id");
CREATE INDEX "library_catalog_assessments_semantic_status_needs_review_idx" ON "library_catalog_assessments"("semantic_status", "needs_review");
CREATE INDEX "library_catalog_assessments_source_blob_id_idx" ON "library_catalog_assessments"("source_blob_id");

ALTER TABLE "library_catalog_assessments" ADD CONSTRAINT "library_catalog_assessments_processing_run_id_fkey"
  FOREIGN KEY ("processing_run_id") REFERENCES "library_source_processing_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "library_catalog_assessments" ADD CONSTRAINT "library_catalog_assessments_source_blob_id_fkey"
  FOREIGN KEY ("source_blob_id") REFERENCES "library_source_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "library_catalog_assessments" ADD CONSTRAINT "library_catalog_assessments_representative_node_id_fkey"
  FOREIGN KEY ("representative_node_id") REFERENCES "library_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
