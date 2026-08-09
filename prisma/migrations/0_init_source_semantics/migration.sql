-- 当前项目不保留任何旧数据库协议或历史数据。
-- 从空数据库直接建立 source-semantics-full.v4 来源记忆结构。
CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "MemoryTemporalKind" AS ENUM (
    'point', 'range', 'recurring', 'relative', 'contextual', 'unknown'
);
CREATE TYPE "MemoryTemporalPrecision" AS ENUM (
    'day', 'month', 'year', 'academic_year', 'semester', 'unspecified'
);
CREATE TYPE "MemoryTemporalDerivation" AS ENUM (
    'source_explicit', 'contextual_inference', 'unresolved'
);

CREATE TABLE "memory_compilations" (
    "id" UUID NOT NULL,
    "schema_version" TEXT NOT NULL,
    "compiled_at" TIMESTAMP(3) NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_path" TEXT NOT NULL,
    "source_title" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "source_parser" TEXT NOT NULL,
    "source_page_count" INTEGER NOT NULL,
    "source_block_count" INTEGER NOT NULL,
    "region_tree_schema_version" TEXT NOT NULL,
    "source_node_ids" TEXT[] NOT NULL,
    "source_node_count" INTEGER NOT NULL,
    "assertion_count" INTEGER NOT NULL,
    "object_count" INTEGER NOT NULL,
    "object_mention_count" INTEGER NOT NULL,
    "model_calls" INTEGER NOT NULL,

    CONSTRAINT "memory_compilations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_source_regions" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "source_node_id" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "lineage_node_ids" TEXT[] NOT NULL,
    "source_pages" INTEGER[] NOT NULL,
    "source_block_ids" TEXT[] NOT NULL,
    "covered_block_ids" TEXT[] NOT NULL,
    "unclaimed_block_ids" TEXT[] NOT NULL,
    "initial_claim_count" INTEGER NOT NULL,
    "review_addition_count" INTEGER NOT NULL,
    "model_calls" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_source_regions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_source_blocks" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "source_block_id" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "block_type" TEXT NOT NULL,
    "source_pages" INTEGER[] NOT NULL,
    "heading_level" INTEGER,
    "heading_path" TEXT[] NOT NULL,
    "source_type" TEXT,
    "source_sub_type" TEXT,
    "bbox" JSONB,
    "asset_path" TEXT,
    "markdown" TEXT NOT NULL,

    CONSTRAINT "memory_source_blocks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_objects" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "source_region_id" UUID NOT NULL,
    "source_object_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_objects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_assertions" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "source_region_id" UUID NOT NULL,
    "source_claim_id" TEXT NOT NULL,
    "statement_template_markdown" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_assertions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_object_mentions" (
    "id" UUID NOT NULL,
    "source_region_id" UUID NOT NULL,
    "assertion_id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "source_mention_id" TEXT NOT NULL,
    "span_text" TEXT NOT NULL,
    "occurrence_index" INTEGER NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,

    CONSTRAINT "memory_object_mentions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_assertion_source_blocks" (
    "assertion_id" UUID NOT NULL,
    "block_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "memory_assertion_source_blocks_pkey" PRIMARY KEY ("assertion_id", "block_id")
);

CREATE TABLE "memory_temporal_annotations" (
    "id" UUID NOT NULL,
    "assertion_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "raw_expression" TEXT NOT NULL,
    "kind" "MemoryTemporalKind" NOT NULL,
    "normalized_text" TEXT NOT NULL,
    "start" TEXT,
    "end" TEXT,
    "precision" "MemoryTemporalPrecision" NOT NULL,
    "derivation" "MemoryTemporalDerivation" NOT NULL,
    "basis_markdown" TEXT NOT NULL,

    CONSTRAINT "memory_temporal_annotations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_compilations_source_sha256_idx" ON "memory_compilations"("source_sha256");
CREATE UNIQUE INDEX "memory_source_regions_compilation_id_source_node_id_key" ON "memory_source_regions"("compilation_id", "source_node_id");
CREATE INDEX "memory_source_regions_label_idx" ON "memory_source_regions"("label");
CREATE UNIQUE INDEX "memory_source_blocks_compilation_id_source_block_id_key" ON "memory_source_blocks"("compilation_id", "source_block_id");
CREATE UNIQUE INDEX "memory_source_blocks_compilation_id_order_key" ON "memory_source_blocks"("compilation_id", "order");
CREATE UNIQUE INDEX "memory_objects_source_region_id_source_object_id_key" ON "memory_objects"("source_region_id", "source_object_id");
CREATE INDEX "memory_objects_compilation_id_label_idx" ON "memory_objects"("compilation_id", "label");
CREATE UNIQUE INDEX "memory_assertions_source_region_id_source_claim_id_key" ON "memory_assertions"("source_region_id", "source_claim_id");
CREATE UNIQUE INDEX "memory_object_mentions_source_region_id_source_mention_id_key" ON "memory_object_mentions"("source_region_id", "source_mention_id");
CREATE INDEX "memory_object_mentions_assertion_id_idx" ON "memory_object_mentions"("assertion_id");
CREATE INDEX "memory_object_mentions_object_id_idx" ON "memory_object_mentions"("object_id");
CREATE INDEX "memory_assertion_source_blocks_block_id_idx" ON "memory_assertion_source_blocks"("block_id");
CREATE UNIQUE INDEX "memory_temporal_annotations_assertion_id_ordinal_key" ON "memory_temporal_annotations"("assertion_id", "ordinal");
CREATE INDEX "memory_temporal_annotations_kind_precision_idx" ON "memory_temporal_annotations"("kind", "precision");

ALTER TABLE "memory_source_regions"
    ADD CONSTRAINT "memory_source_regions_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_source_blocks"
    ADD CONSTRAINT "memory_source_blocks_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_objects"
    ADD CONSTRAINT "memory_objects_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_objects"
    ADD CONSTRAINT "memory_objects_source_region_id_fkey"
    FOREIGN KEY ("source_region_id") REFERENCES "memory_source_regions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_assertions"
    ADD CONSTRAINT "memory_assertions_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_assertions"
    ADD CONSTRAINT "memory_assertions_source_region_id_fkey"
    FOREIGN KEY ("source_region_id") REFERENCES "memory_source_regions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_object_mentions"
    ADD CONSTRAINT "memory_object_mentions_source_region_id_fkey"
    FOREIGN KEY ("source_region_id") REFERENCES "memory_source_regions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_object_mentions"
    ADD CONSTRAINT "memory_object_mentions_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_object_mentions"
    ADD CONSTRAINT "memory_object_mentions_object_id_fkey"
    FOREIGN KEY ("object_id") REFERENCES "memory_objects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_assertion_source_blocks"
    ADD CONSTRAINT "memory_assertion_source_blocks_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_assertion_source_blocks"
    ADD CONSTRAINT "memory_assertion_source_blocks_block_id_fkey"
    FOREIGN KEY ("block_id") REFERENCES "memory_source_blocks"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_temporal_annotations"
    ADD CONSTRAINT "memory_temporal_annotations_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
