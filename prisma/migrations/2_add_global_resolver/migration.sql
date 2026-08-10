-- 只保存完整 cold-start package 的最终 Global Object 与 atom 归属。
CREATE TABLE "memory_global_objects" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "global_object_key" TEXT NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "identity_summary_markdown" TEXT NOT NULL,

    CONSTRAINT "memory_global_objects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_global_object_surface_memberships" (
    "object_fragment_id" UUID NOT NULL,
    "surface_form_ordinal" INTEGER NOT NULL,
    "global_object_id" UUID NOT NULL,

    CONSTRAINT "memory_global_object_surface_memberships_pkey"
        PRIMARY KEY ("object_fragment_id", "surface_form_ordinal"),
    CONSTRAINT "memory_global_object_surface_memberships_ordinal_check"
        CHECK ("surface_form_ordinal" >= 0)
);

CREATE TABLE "memory_global_assertion_reference_resolutions" (
    "assertion_id" UUID NOT NULL,
    "reference_ordinal" INTEGER NOT NULL,
    "global_object_id" UUID NOT NULL,

    CONSTRAINT "memory_global_assertion_reference_resolutions_pkey"
        PRIMARY KEY ("assertion_id", "reference_ordinal"),
    CONSTRAINT "memory_global_assertion_reference_resolutions_ordinal_check"
        CHECK ("reference_ordinal" >= 0)
);

CREATE UNIQUE INDEX "memory_global_objects_compilation_id_global_object_key_key"
    ON "memory_global_objects"("compilation_id", "global_object_key");
CREATE INDEX "memory_global_objects_compilation_id_idx"
    ON "memory_global_objects"("compilation_id");
CREATE INDEX "memory_global_object_surface_memberships_global_object_id_idx"
    ON "memory_global_object_surface_memberships"("global_object_id");
CREATE INDEX "memory_global_assertion_reference_resolutions_global_object_idx"
    ON "memory_global_assertion_reference_resolutions"("global_object_id");

ALTER TABLE "memory_global_objects"
    ADD CONSTRAINT "memory_global_objects_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_global_object_surface_memberships"
    ADD CONSTRAINT "memory_global_object_surface_memberships_object_fragment_i_fkey"
    FOREIGN KEY ("object_fragment_id") REFERENCES "memory_source_object_fragments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_global_object_surface_memberships"
    ADD CONSTRAINT "memory_global_object_surface_memberships_global_object_id_fkey"
    FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "memory_global_assertion_reference_resolutions"
    ADD CONSTRAINT "memory_global_assertion_reference_resolutions_assertion_id_fkey"
    FOREIGN KEY ("assertion_id", "reference_ordinal")
    REFERENCES "memory_assertion_fragment_references"("assertion_id", "ordinal")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_global_assertion_reference_resolutions"
    ADD CONSTRAINT "memory_global_assertion_reference_resolutions_global_objec_fkey"
    FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
