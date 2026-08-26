-- Development-stage destructive Higher Memory redesign.
--
-- Shared Brain Objects, Assertions, Evidence, source documents and Business View
-- state remain intact. All generated Higher Memory is discarded because the old
-- single-markdown contract mixed narrative, structure, current state and
-- retrieval coverage without durable provenance.

DELETE FROM "memory_object_higher_memories";
DELETE FROM "memory_ambient_higher_memories";
DELETE FROM "view_higher_memories";

ALTER TYPE "MemoryAmbientHigherMemoryScope" RENAME VALUE 'workspace' TO 'identity';
ALTER TYPE "MemoryAmbientHigherMemoryScope" RENAME VALUE 'recent' TO 'working_set';
ALTER TYPE "MemoryAmbientHigherMemoryScope" ADD VALUE 'narrative' AFTER 'identity';

ALTER TABLE "memory_object_higher_memories"
  DROP COLUMN "content_markdown",
  ADD COLUMN "cognitive_memory" JSONB NOT NULL,
  ADD COLUMN "operational_index" JSONB NOT NULL DEFAULT '{"aspects":[]}'::jsonb;
