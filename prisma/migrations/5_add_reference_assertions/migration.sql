CREATE TYPE "MemoryAssertionKind" AS ENUM ('grounded', 'reference');

ALTER TABLE "memory_assertions"
    ADD COLUMN "kind" "MemoryAssertionKind" NOT NULL DEFAULT 'grounded';

CREATE TABLE "memory_assertion_semantic_object_links" (
    "assertion_id" UUID NOT NULL,
    "global_object_id" UUID NOT NULL,

    CONSTRAINT "memory_assertion_semantic_object_links_pkey"
        PRIMARY KEY ("assertion_id", "global_object_id")
);

CREATE INDEX "memory_assertion_semantic_object_links_global_object_id_idx"
    ON "memory_assertion_semantic_object_links"("global_object_id");

ALTER TABLE "memory_assertion_semantic_object_links"
    ADD CONSTRAINT "memory_assertion_semantic_object_links_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_assertion_semantic_object_links"
    ADD CONSTRAINT "memory_assertion_semantic_object_links_global_object_id_fkey"
    FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
