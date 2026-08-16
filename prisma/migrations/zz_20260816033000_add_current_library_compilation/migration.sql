ALTER TABLE "library_source_processing_runs"
ADD COLUMN "is_current" BOOLEAN NOT NULL DEFAULT false;

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

CREATE UNIQUE INDEX "library_source_processing_runs_one_current_per_blob"
ON "library_source_processing_runs"("source_blob_id")
WHERE "is_current" = true AND "source_blob_id" IS NOT NULL;

CREATE INDEX "library_source_processing_runs_source_blob_id_is_current_idx"
ON "library_source_processing_runs"("source_blob_id", "is_current");

CREATE TABLE "library_compilation_state" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "global_objects" JSONB NOT NULL DEFAULT '[]',
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "library_compilation_state_pkey" PRIMARY KEY ("id")
);

INSERT INTO "library_compilation_state" ("id", "global_objects")
VALUES ('default', '[]'::jsonb)
ON CONFLICT ("id") DO NOTHING;
