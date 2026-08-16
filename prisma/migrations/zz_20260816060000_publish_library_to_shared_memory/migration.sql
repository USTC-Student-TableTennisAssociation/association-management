ALTER TABLE "library_source_processing_runs"
  ADD COLUMN "published_at" TIMESTAMPTZ(3),
  ADD COLUMN "published_assertion_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "published_object_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "memory_source_regions"
  ADD COLUMN "source_path" TEXT,
  ADD COLUMN "source_title" TEXT,
  ADD COLUMN "source_sha256" TEXT,
  ADD COLUMN "source_parser" TEXT;

CREATE INDEX "memory_source_regions_source_sha256_idx"
  ON "memory_source_regions"("source_sha256");
