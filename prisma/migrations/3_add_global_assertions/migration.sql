-- 保存 Global Resolver 完成后物化的 Global Assertion 与新增 literal reference atoms。
ALTER TABLE "memory_assertions"
    ADD COLUMN "global_statement_template_markdown" TEXT NOT NULL DEFAULT '';
ALTER TABLE "memory_assertions"
    ALTER COLUMN "global_statement_template_markdown" DROP DEFAULT;

CREATE TABLE "memory_global_assertion_literal_references" (
    "atom_id" TEXT NOT NULL,
    "assertion_id" UUID NOT NULL,
    "literal_ordinal" INTEGER NOT NULL,
    "global_ordinal" INTEGER NOT NULL,
    "source_start" INTEGER NOT NULL,
    "source_end" INTEGER NOT NULL,
    "source_text" TEXT NOT NULL,
    "global_object_id" UUID NOT NULL,

    CONSTRAINT "memory_global_assertion_literal_references_pkey"
        PRIMARY KEY ("atom_id"),
    CONSTRAINT "memory_global_assertion_literal_references_literal_ordinal_check"
        CHECK ("literal_ordinal" >= 0),
    CONSTRAINT "memory_global_assertion_literal_references_global_ordinal_check"
        CHECK ("global_ordinal" >= 0),
    CONSTRAINT "memory_global_assertion_literal_references_source_span_check"
        CHECK ("source_start" >= 0 AND "source_end" > "source_start")
);

CREATE UNIQUE INDEX "memory_global_assertion_literal_references_assertion_literal_key"
    ON "memory_global_assertion_literal_references"("assertion_id", "literal_ordinal");
CREATE INDEX "memory_global_assertion_literal_references_assertion_global_idx"
    ON "memory_global_assertion_literal_references"("assertion_id", "global_ordinal");
CREATE INDEX "memory_global_assertion_literal_references_global_object_idx"
    ON "memory_global_assertion_literal_references"("global_object_id");

ALTER TABLE "memory_global_assertion_literal_references"
    ADD CONSTRAINT "memory_global_assertion_literal_references_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_global_assertion_literal_references"
    ADD CONSTRAINT "memory_global_assertion_literal_references_global_object_id_fkey"
    FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
