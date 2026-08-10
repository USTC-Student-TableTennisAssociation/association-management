-- 用不可变 source-local ObjectFragment IR 取代旧 provisional Object/Mention。
DROP TABLE "memory_object_mentions";
DROP TABLE "memory_objects";

ALTER TABLE "memory_compilations"
    DROP COLUMN "object_count",
    DROP COLUMN "object_mention_count",
    ADD COLUMN "object_fragment_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "surface_form_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "fragment_reference_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "memory_compilations"
    ALTER COLUMN "object_fragment_count" DROP DEFAULT,
    ALTER COLUMN "surface_form_count" DROP DEFAULT,
    ALTER COLUMN "fragment_reference_count" DROP DEFAULT;

ALTER TABLE "memory_assertions"
    ADD COLUMN "context_dependent" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "memory_assertions"
    ALTER COLUMN "context_dependent" DROP DEFAULT;

CREATE TABLE "memory_source_object_fragments" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "source_region_id" UUID NOT NULL,
    "source_fragment_id" TEXT NOT NULL,
    "surface_forms" TEXT[] NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_source_object_fragments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_assertion_fragment_references" (
    "assertion_id" UUID NOT NULL,
    "object_fragment_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "memory_assertion_fragment_references_pkey"
        PRIMARY KEY ("assertion_id", "ordinal"),
    CONSTRAINT "memory_assertion_fragment_references_ordinal_check"
        CHECK ("ordinal" >= 0)
);

CREATE UNIQUE INDEX "memory_source_object_fragments_source_region_id_source_fragment_id_key"
    ON "memory_source_object_fragments"("source_region_id", "source_fragment_id");
CREATE INDEX "memory_source_object_fragments_compilation_id_idx"
    ON "memory_source_object_fragments"("compilation_id");
CREATE INDEX "memory_assertion_fragment_references_object_fragment_id_idx"
    ON "memory_assertion_fragment_references"("object_fragment_id");

ALTER TABLE "memory_source_object_fragments"
    ADD CONSTRAINT "memory_source_object_fragments_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_source_object_fragments"
    ADD CONSTRAINT "memory_source_object_fragments_source_region_id_fkey"
    FOREIGN KEY ("source_region_id") REFERENCES "memory_source_regions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_assertion_fragment_references"
    ADD CONSTRAINT "memory_assertion_fragment_references_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_assertion_fragment_references"
    ADD CONSTRAINT "memory_assertion_fragment_references_object_fragment_id_fkey"
    FOREIGN KEY ("object_fragment_id") REFERENCES "memory_source_object_fragments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
