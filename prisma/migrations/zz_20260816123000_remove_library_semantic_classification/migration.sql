UPDATE "library_source_processing_runs"
SET "checkpoint" = jsonb_set(
  "checkpoint",
  '{assessment}',
  ("checkpoint" -> 'assessment') - 'semanticStatus' - 'recommendedProfile' - 'reason',
  false
)
WHERE jsonb_typeof("checkpoint" -> 'assessment') = 'object';

ALTER TABLE "library_catalog_assessments"
  DROP COLUMN "semantic_status",
  DROP COLUMN "recommended_profile";

DROP TYPE "LibrarySemanticStatus";
