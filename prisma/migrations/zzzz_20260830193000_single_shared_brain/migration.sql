-- Sydaris 首次公开发布前不保留旧 MemoryCompilation 数据。
-- Library 原件和处理记录保留；Shared Brain 的派生认知在新模型下重新发布。
UPDATE "auth_users" SET "actor_object_id" = NULL;
DELETE FROM "view_card_related_objects";
DELETE FROM "memory_assertion_embeddings";
DELETE FROM "memory_assertion_embedding_indexes";
DELETE FROM "memory_assertion_chat_evidence_links";
DELETE FROM "memory_assertion_source_blocks";
DELETE FROM "memory_assertion_fragment_references";
DELETE FROM "memory_assertion_object_links";
DELETE FROM "memory_assertion_object_coverage";
DELETE FROM "memory_global_object_surface_memberships";
DELETE FROM "memory_chat_object_mentions";
DELETE FROM "memory_object_higher_memories";
DELETE FROM "memory_object_change_proposals";
DELETE FROM "memory_assertions";
DELETE FROM "memory_source_object_fragments";
DELETE FROM "memory_source_blocks";
DELETE FROM "memory_source_regions";
DELETE FROM "memory_chat_assertion_captures";
DELETE FROM "memory_chat_assertion_receipts";
DELETE FROM "memory_chat_evidence";
DELETE FROM "memory_global_objects";
DELETE FROM "memory_compilations";

-- 旧发布物已被清空，Library 的运行记录和跨文件草稿也不能继续声称它们已发布。
UPDATE "library_source_processing_runs"
SET
  "published_at" = NULL,
  "published_assertion_count" = 0,
  "published_object_count" = 0;
UPDATE "library_compilation_state"
SET "global_objects" = '[]'::jsonb;

DROP INDEX IF EXISTS "memory_source_regions_compilation_id_source_node_id_key";
ALTER TABLE "memory_source_regions"
  DROP CONSTRAINT "memory_source_regions_compilation_id_fkey",
  DROP COLUMN "compilation_id",
  ADD COLUMN "publication_run_id" UUID NOT NULL,
  ALTER COLUMN "source_title" SET NOT NULL,
  ALTER COLUMN "source_sha256" SET NOT NULL;
CREATE UNIQUE INDEX "memory_source_regions_publication_run_id_source_node_id_key"
  ON "memory_source_regions"("publication_run_id", "source_node_id");
CREATE INDEX "memory_source_regions_publication_run_id_idx"
  ON "memory_source_regions"("publication_run_id");
ALTER TABLE "memory_source_regions"
  ADD CONSTRAINT "memory_source_regions_publication_run_id_fkey"
  FOREIGN KEY ("publication_run_id") REFERENCES "library_source_processing_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "memory_source_blocks_compilation_id_source_block_id_key";
DROP INDEX IF EXISTS "memory_source_blocks_compilation_id_order_key";
ALTER TABLE "memory_source_blocks"
  DROP CONSTRAINT "memory_source_blocks_compilation_id_fkey",
  DROP COLUMN "compilation_id",
  ADD COLUMN "publication_run_id" UUID NOT NULL;
CREATE UNIQUE INDEX "memory_source_blocks_publication_run_id_source_block_id_key"
  ON "memory_source_blocks"("publication_run_id", "source_block_id");
CREATE UNIQUE INDEX "memory_source_blocks_publication_run_id_order_key"
  ON "memory_source_blocks"("publication_run_id", "order");
CREATE INDEX "memory_source_blocks_publication_run_id_idx"
  ON "memory_source_blocks"("publication_run_id");
ALTER TABLE "memory_source_blocks"
  ADD CONSTRAINT "memory_source_blocks_publication_run_id_fkey"
  FOREIGN KEY ("publication_run_id") REFERENCES "library_source_processing_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "memory_source_object_fragments_compilation_id_idx";
ALTER TABLE "memory_source_object_fragments"
  DROP CONSTRAINT "memory_source_object_fragments_compilation_id_fkey",
  DROP COLUMN "compilation_id";

ALTER TABLE "memory_assertions"
  DROP CONSTRAINT "memory_assertions_compilation_id_fkey",
  DROP COLUMN "compilation_id";

DROP INDEX IF EXISTS "memory_chat_assertion_captures_compilation_id_submitted_at_idx";
ALTER TABLE "memory_chat_assertion_captures"
  DROP CONSTRAINT "memory_chat_assertion_captures_compilation_id_fkey",
  DROP COLUMN "compilation_id";

DROP INDEX IF EXISTS "memory_chat_assertion_receipts_compilation_id_submitted_at_idx";
ALTER TABLE "memory_chat_assertion_receipts"
  DROP CONSTRAINT "memory_chat_assertion_receipts_compilation_id_fkey",
  DROP COLUMN "compilation_id";

DROP INDEX IF EXISTS "memory_chat_evidence_compilation_id_submitted_at_idx";
ALTER TABLE "memory_chat_evidence"
  DROP CONSTRAINT "memory_chat_evidence_compilation_id_fkey",
  DROP COLUMN "compilation_id";

DROP INDEX IF EXISTS "memory_global_objects_compilation_id_global_object_key_key";
DROP INDEX IF EXISTS "memory_global_objects_compilation_id_idx";
ALTER TABLE "memory_global_objects"
  DROP CONSTRAINT "memory_global_objects_compilation_id_fkey",
  DROP COLUMN "compilation_id";
CREATE UNIQUE INDEX "memory_global_objects_global_object_key_key"
  ON "memory_global_objects"("global_object_key");

DROP INDEX IF EXISTS "memory_object_higher_memories_compilation_id_maintained_at_idx";
ALTER TABLE "memory_object_higher_memories"
  DROP CONSTRAINT "memory_object_higher_memories_compilation_id_fkey",
  DROP COLUMN "compilation_id";
CREATE INDEX "memory_object_higher_memories_maintained_at_idx"
  ON "memory_object_higher_memories"("maintained_at");

ALTER TABLE "memory_assertion_embedding_indexes"
  DROP CONSTRAINT "memory_assertion_embedding_indexes_compilation_id_fkey",
  DROP CONSTRAINT "memory_assertion_embedding_indexes_pkey",
  DROP COLUMN "compilation_id",
  ADD COLUMN "id" TEXT NOT NULL DEFAULT 'shared',
  ADD CONSTRAINT "memory_assertion_embedding_indexes_pkey" PRIMARY KEY ("id");

DROP INDEX IF EXISTS "memory_object_change_proposals_compilation_id_status_created_at_idx";
ALTER TABLE "memory_object_change_proposals"
  DROP CONSTRAINT "memory_object_change_proposals_compilation_id_fkey",
  DROP COLUMN "compilation_id";
CREATE INDEX "memory_object_change_proposals_status_created_at_idx"
  ON "memory_object_change_proposals"("status", "created_at");

DROP TABLE "memory_compilations";
