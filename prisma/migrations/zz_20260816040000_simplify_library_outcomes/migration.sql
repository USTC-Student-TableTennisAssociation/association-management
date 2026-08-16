UPDATE "library_source_processing_runs" AS run
SET
  "status" = 'failed',
  "stage" = 'failed',
  "status_message" = '处理失败',
  "error_message" = COALESCE(run."error_message", assessment."review_reason", assessment."summary")
FROM "library_catalog_assessments" AS assessment
WHERE
  assessment."processing_run_id" = run."id"
  AND run."stage" = 'review_required'
  AND assessment."semantic_status" IN ('unsupported', 'failed');

UPDATE "library_source_processing_runs" AS run
SET
  "status" = 'ready',
  "stage" = 'ready',
  "status_message" = '编译成功',
  "error_message" = NULL
FROM "library_catalog_assessments" AS assessment
WHERE
  assessment."processing_run_id" = run."id"
  AND run."stage" = 'review_required'
  AND assessment."semantic_status" NOT IN ('unsupported', 'failed');

UPDATE "library_compilation_jobs" AS job
SET "status" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "library_source_processing_runs" AS run
    WHERE run."job_id" = job."id" AND run."status" = 'failed'
  ) THEN 'failed'::"LibraryCompilationJobStatus"
  ELSE 'completed'::"LibraryCompilationJobStatus"
END
WHERE job."status" = 'awaiting_review';

UPDATE "library_compilation_jobs" AS job
SET
  "completed_content" = counts.completed_count,
  "failed_content" = counts.failed_count,
  "deep_completed" = counts.deep_count,
  "coarse_completed" = counts.coarse_count,
  "catalog_completed" = counts.catalog_count
FROM (
  SELECT
    job_inner."id" AS job_id,
    COUNT(run."id") FILTER (WHERE run."status" = 'ready')::INTEGER AS completed_count,
    COUNT(run."id") FILTER (WHERE run."status" = 'failed')::INTEGER AS failed_count,
    COUNT(run."id") FILTER (
      WHERE run."profile" = 'deep' AND run."status" IN ('ready', 'failed')
    )::INTEGER AS deep_count,
    COUNT(run."id") FILTER (
      WHERE run."profile" = 'coarse' AND run."status" IN ('ready', 'failed')
    )::INTEGER AS coarse_count,
    COUNT(run."id") FILTER (
      WHERE run."profile" = 'catalog' AND run."status" IN ('ready', 'failed')
    )::INTEGER AS catalog_count
  FROM "library_compilation_jobs" AS job_inner
  LEFT JOIN "library_source_processing_runs" AS run ON run."job_id" = job_inner."id"
  GROUP BY job_inner."id"
) AS counts
WHERE counts.job_id = job."id";

ALTER TABLE "library_compilation_jobs" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "LibraryCompilationJobStatus_new" AS ENUM (
  'queued', 'running', 'paused', 'completed', 'failed'
);
ALTER TABLE "library_compilation_jobs"
ALTER COLUMN "status" TYPE "LibraryCompilationJobStatus_new"
USING ("status"::text::"LibraryCompilationJobStatus_new");
DROP TYPE "LibraryCompilationJobStatus";
ALTER TYPE "LibraryCompilationJobStatus_new" RENAME TO "LibraryCompilationJobStatus";
ALTER TABLE "library_compilation_jobs" ALTER COLUMN "status" SET DEFAULT 'queued';

ALTER TABLE "library_source_processing_runs" ALTER COLUMN "stage" DROP DEFAULT;
CREATE TYPE "LibraryProcessingStage_new" AS ENUM (
  'queued', 'preparing', 'parsing', 'analyzing', 'resolving', 'staging', 'ready', 'failed'
);
ALTER TABLE "library_source_processing_runs"
ALTER COLUMN "stage" TYPE "LibraryProcessingStage_new"
USING ("stage"::text::"LibraryProcessingStage_new");
DROP TYPE "LibraryProcessingStage";
ALTER TYPE "LibraryProcessingStage_new" RENAME TO "LibraryProcessingStage";
ALTER TABLE "library_source_processing_runs" ALTER COLUMN "stage" SET DEFAULT 'queued';

ALTER TABLE "library_compilation_jobs" DROP COLUMN "review_content";
DROP INDEX IF EXISTS "library_catalog_assessments_semantic_status_needs_review_idx";
ALTER TABLE "library_catalog_assessments"
  DROP COLUMN "needs_review",
  DROP COLUMN "review_reason";
CREATE INDEX "library_catalog_assessments_semantic_status_idx"
ON "library_catalog_assessments"("semantic_status");

UPDATE "library_source_processing_runs" SET "is_current" = false;
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "source_blob_id"
      ORDER BY "completed_at" DESC NULLS LAST, "created_at" DESC
    ) AS ordinal
  FROM "library_source_processing_runs"
  WHERE
    "source_blob_id" IS NOT NULL
    AND "status" = 'ready'
    AND "stage" = 'ready'
)
UPDATE "library_source_processing_runs" AS run
SET "is_current" = true
FROM ranked
WHERE run."id" = ranked."id" AND ranked.ordinal = 1;
