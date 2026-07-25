-- EnableExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "MemoryNodeKind" AS ENUM ('search_card', 'activity_pattern', 'activity_trait', 'workflow', 'work_step', 'rule', 'principle', 'practice');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('draft', 'published', 'retired');

-- CreateEnum
CREATE TYPE "MemorySearchTermKind" AS ENUM ('official_name', 'alias', 'historical_name', 'abbreviation', 'misspelling', 'keyword');

-- CreateEnum
CREATE TYPE "MemoryActivityRecurrenceKind" AS ENUM ('annual', 'semester', 'irregular', 'on_demand', 'unknown');

-- CreateEnum
CREATE TYPE "MemoryActivityTraitDimension" AS ENUM ('scale', 'format', 'audience', 'funding', 'venue', 'recurrence', 'other');

-- CreateEnum
CREATE TYPE "MemoryRelationType" AS ENUM ('routes_to', 'has_trait', 'uses', 'contains', 'next', 'requires', 'exception_to', 'applies_to', 'informs', 'constrains', 'supports', 'deviates_from', 'reveals_risk', 'challenges');

-- CreateEnum
CREATE TYPE "MemorySourceRole" AS ENUM ('basis', 'example', 'counterexample', 'context');

-- CreateEnum
CREATE TYPE "MemoryEmbeddingPurpose" AS ENUM ('routing', 'semantic_retrieval');

-- DropForeignKey
ALTER TABLE "guideline_links" DROP CONSTRAINT "guideline_links_from_guideline_id_fkey";

-- DropForeignKey
ALTER TABLE "guideline_links" DROP CONSTRAINT "guideline_links_to_guideline_id_fkey";

-- DropTable
DROP TABLE "guidelines";

-- DropTable
DROP TABLE "guideline_links";

-- DropEnum
DROP TYPE "GuidelineKind";

-- DropEnum
DROP TYPE "GuidelineStatus";

-- DropEnum
DROP TYPE "GuidelineRelationType";

-- CreateTable
CREATE TABLE "memory_nodes" (
    "id" UUID NOT NULL,
    "kind" "MemoryNodeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "MemoryStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "memory_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_search_cards" (
    "node_id" UUID NOT NULL,
    "intent_markdown" TEXT NOT NULL,
    "disambiguation_markdown" TEXT,

    CONSTRAINT "memory_search_cards_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "memory_search_terms" (
    "id" UUID NOT NULL,
    "search_card_id" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "normalized_term" TEXT NOT NULL,
    "kind" "MemorySearchTermKind" NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_search_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_activity_patterns" (
    "node_id" UUID NOT NULL,
    "description_markdown" TEXT NOT NULL,
    "purpose_markdown" TEXT,
    "recurrence_kind" "MemoryActivityRecurrenceKind" NOT NULL,
    "typical_timing_markdown" TEXT,
    "identity_boundary_markdown" TEXT,

    CONSTRAINT "memory_activity_patterns_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "memory_activity_traits" (
    "node_id" UUID NOT NULL,
    "dimension" "MemoryActivityTraitDimension" NOT NULL,
    "code" TEXT NOT NULL,
    "definition_markdown" TEXT NOT NULL,

    CONSTRAINT "memory_activity_traits_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "memory_workflows" (
    "node_id" UUID NOT NULL,
    "goal_markdown" TEXT NOT NULL,
    "entry_meaning_markdown" TEXT NOT NULL,

    CONSTRAINT "memory_workflows_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "memory_work_steps" (
    "node_id" UUID NOT NULL,
    "objective_markdown" TEXT NOT NULL,
    "instruction_markdown" TEXT NOT NULL,
    "completion_meaning_markdown" TEXT NOT NULL,

    CONSTRAINT "memory_work_steps_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "memory_rules" (
    "node_id" UUID NOT NULL,
    "statement_markdown" TEXT NOT NULL,
    "rationale_markdown" TEXT,
    "violation_impact_markdown" TEXT,

    CONSTRAINT "memory_rules_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "memory_principles" (
    "node_id" UUID NOT NULL,
    "statement_markdown" TEXT NOT NULL,
    "rationale_markdown" TEXT NOT NULL,
    "tradeoff_markdown" TEXT,

    CONSTRAINT "memory_principles_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "memory_practices" (
    "node_id" UUID NOT NULL,
    "situation_markdown" TEXT NOT NULL,
    "behavior_markdown" TEXT NOT NULL,
    "outcome_markdown" TEXT,
    "lesson_markdown" TEXT NOT NULL,
    "uncertainty_markdown" TEXT,

    CONSTRAINT "memory_practices_pkey" PRIMARY KEY ("node_id")
);

-- CreateTable
CREATE TABLE "memory_edges" (
    "id" UUID NOT NULL,
    "from_node_id" UUID NOT NULL,
    "to_node_id" UUID NOT NULL,
    "relation_type" "MemoryRelationType" NOT NULL,
    "sequence" INTEGER,
    "note_markdown" TEXT,
    "status" "MemoryStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "memory_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_source_anchors" (
    "id" UUID NOT NULL,
    "source_asset_ref" TEXT NOT NULL,
    "page_start" INTEGER,
    "page_end" INTEGER,
    "section_path" TEXT,
    "start_offset" INTEGER,
    "end_offset" INTEGER,
    "excerpt" TEXT,
    "excerpt_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_source_anchors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_node_sources" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "source_anchor_id" UUID NOT NULL,
    "role" "MemorySourceRole" NOT NULL,
    "note_markdown" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_node_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_edge_sources" (
    "id" UUID NOT NULL,
    "edge_id" UUID NOT NULL,
    "source_anchor_id" UUID NOT NULL,
    "role" "MemorySourceRole" NOT NULL,
    "note_markdown" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_edge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_embeddings" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "purpose" "MemoryEmbeddingPurpose" NOT NULL,
    "model_key" TEXT NOT NULL,
    "model_revision" TEXT NOT NULL,
    "dimension" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_nodes_status_idx" ON "memory_nodes"("status");

-- CreateIndex
CREATE INDEX "memory_nodes_kind_status_idx" ON "memory_nodes"("kind", "status");

-- CreateIndex
CREATE INDEX "memory_search_terms_normalized_term_is_active_idx" ON "memory_search_terms"("normalized_term", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "memory_search_terms_search_card_id_normalized_term_key" ON "memory_search_terms"("search_card_id", "normalized_term");

-- CreateIndex
CREATE INDEX "memory_activity_patterns_recurrence_kind_idx" ON "memory_activity_patterns"("recurrence_kind");

-- CreateIndex
CREATE UNIQUE INDEX "memory_activity_traits_dimension_code_key" ON "memory_activity_traits"("dimension", "code");

-- CreateIndex
CREATE INDEX "memory_edges_from_node_id_relation_type_status_idx" ON "memory_edges"("from_node_id", "relation_type", "status");

-- CreateIndex
CREATE INDEX "memory_edges_to_node_id_relation_type_status_idx" ON "memory_edges"("to_node_id", "relation_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "memory_edges_from_node_id_to_node_id_relation_type_key" ON "memory_edges"("from_node_id", "to_node_id", "relation_type");

-- CreateIndex
CREATE INDEX "memory_source_anchors_source_asset_ref_idx" ON "memory_source_anchors"("source_asset_ref");

-- CreateIndex
CREATE INDEX "memory_node_sources_source_anchor_id_idx" ON "memory_node_sources"("source_anchor_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_node_sources_node_id_source_anchor_id_role_key" ON "memory_node_sources"("node_id", "source_anchor_id", "role");

-- CreateIndex
CREATE INDEX "memory_edge_sources_source_anchor_id_idx" ON "memory_edge_sources"("source_anchor_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_edge_sources_edge_id_source_anchor_id_role_key" ON "memory_edge_sources"("edge_id", "source_anchor_id", "role");

-- CreateIndex
CREATE INDEX "memory_embeddings_node_id_purpose_idx" ON "memory_embeddings"("node_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "memory_embeddings_node_id_purpose_model_key_model_revision__key" ON "memory_embeddings"("node_id", "purpose", "model_key", "model_revision", "content_hash");

-- CreateIndex
CREATE INDEX "memory_embeddings_embedding_hnsw_idx" ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);

-- AddForeignKey
ALTER TABLE "memory_search_cards" ADD CONSTRAINT "memory_search_cards_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_search_terms" ADD CONSTRAINT "memory_search_terms_search_card_id_fkey" FOREIGN KEY ("search_card_id") REFERENCES "memory_search_cards"("node_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_activity_patterns" ADD CONSTRAINT "memory_activity_patterns_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_activity_traits" ADD CONSTRAINT "memory_activity_traits_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_workflows" ADD CONSTRAINT "memory_workflows_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_work_steps" ADD CONSTRAINT "memory_work_steps_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_rules" ADD CONSTRAINT "memory_rules_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_principles" ADD CONSTRAINT "memory_principles_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_practices" ADD CONSTRAINT "memory_practices_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_from_node_id_fkey" FOREIGN KEY ("from_node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_to_node_id_fkey" FOREIGN KEY ("to_node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_node_sources" ADD CONSTRAINT "memory_node_sources_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_node_sources" ADD CONSTRAINT "memory_node_sources_source_anchor_id_fkey" FOREIGN KEY ("source_anchor_id") REFERENCES "memory_source_anchors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_edge_sources" ADD CONSTRAINT "memory_edge_sources_edge_id_fkey" FOREIGN KEY ("edge_id") REFERENCES "memory_edges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_edge_sources" ADD CONSTRAINT "memory_edge_sources_source_anchor_id_fkey" FOREIGN KEY ("source_anchor_id") REFERENCES "memory_source_anchors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
