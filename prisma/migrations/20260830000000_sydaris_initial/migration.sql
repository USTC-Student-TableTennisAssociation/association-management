-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- EnableVectorExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "MemoryAssertionKind" AS ENUM ('grounded', 'reference');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('pending', 'rejected', 'applied', 'failed');

-- CreateEnum
CREATE TYPE "InstalledViewStatus" AS ENUM ('enabled', 'incompatible');

-- CreateEnum
CREATE TYPE "ViewCommandInitiator" AS ENUM ('human', 'ai', 'system');

-- CreateEnum
CREATE TYPE "ViewReactionAttentionStatus" AS ENUM ('not_required', 'queued', 'running', 'silent', 'inform', 'needs_confirmation', 'failed');

-- CreateEnum
CREATE TYPE "ViewReactionKnowledgeStatus" AS ENUM ('not_required', 'queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "MemoryChatAssertionReceiptStatus" AS ENUM ('queued', 'running', 'published', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "ChatMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuthUserRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "AuthUserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "MemoryAmbientHigherMemoryScope" AS ENUM ('identity', 'narrative', 'working_set');

-- CreateEnum
CREATE TYPE "MemoryActorHigherMemoryScope" AS ENUM ('interaction', 'working_style', 'working_set');

-- CreateEnum
CREATE TYPE "LibraryNodeKind" AS ENUM ('file', 'folder');

-- CreateEnum
CREATE TYPE "LibraryProcessingProfile" AS ENUM ('catalog', 'coarse', 'deep');

-- CreateEnum
CREATE TYPE "LibraryProcessingStatus" AS ENUM ('idle', 'queued', 'running', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "LibraryPlanStatus" AS ENUM ('pending', 'rejected', 'applied', 'failed');

-- CreateEnum
CREATE TYPE "LibraryCompilationJobStatus" AS ENUM ('queued', 'running', 'paused', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "LibraryProcessingStage" AS ENUM ('queued', 'preparing', 'parsing', 'analyzing', 'resolving', 'staging', 'ready', 'failed');

-- CreateTable
CREATE TABLE "library_import_batches" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "original_root" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "file_count" INTEGER NOT NULL DEFAULT 0,
    "unique_blob_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "library_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_source_blobs" (
    "id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_source_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_nodes" (
    "id" UUID NOT NULL,
    "kind" "LibraryNodeKind" NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "blob_id" UUID,
    "import_batch_id" UUID,
    "original_relative_path" TEXT,
    "processing_profile" "LibraryProcessingProfile" NOT NULL DEFAULT 'catalog',
    "processing_status" "LibraryProcessingStatus" NOT NULL DEFAULT 'idle',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "library_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_compilation_jobs" (
    "id" UUID NOT NULL,
    "status" "LibraryCompilationJobStatus" NOT NULL DEFAULT 'queued',
    "active_phase" "LibraryProcessingProfile",
    "pause_requested" BOOLEAN NOT NULL DEFAULT false,
    "total_content" INTEGER NOT NULL DEFAULT 0,
    "completed_content" INTEGER NOT NULL DEFAULT 0,
    "failed_content" INTEGER NOT NULL DEFAULT 0,
    "deep_total" INTEGER NOT NULL DEFAULT 0,
    "deep_completed" INTEGER NOT NULL DEFAULT 0,
    "coarse_total" INTEGER NOT NULL DEFAULT 0,
    "coarse_completed" INTEGER NOT NULL DEFAULT 0,
    "catalog_total" INTEGER NOT NULL DEFAULT 0,
    "catalog_completed" INTEGER NOT NULL DEFAULT 0,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "active_stage" TEXT,
    "global_status" TEXT NOT NULL DEFAULT 'queued',
    "global_progress" INTEGER NOT NULL DEFAULT 0,
    "global_total" INTEGER NOT NULL DEFAULT 0,
    "global_retry_count" INTEGER NOT NULL DEFAULT 0,
    "global_status_message" TEXT,
    "global_error_message" TEXT,
    "global_checkpoint" JSONB NOT NULL DEFAULT '{}',
    "global_result" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "library_compilation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_compilation_state" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "global_objects" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "library_compilation_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_source_processing_runs" (
    "id" UUID NOT NULL,
    "library_node_id" UUID NOT NULL,
    "source_blob_id" UUID,
    "job_id" UUID,
    "profile" "LibraryProcessingProfile" NOT NULL,
    "profile_version" TEXT NOT NULL,
    "status" "LibraryProcessingStatus" NOT NULL DEFAULT 'queued',
    "stage" "LibraryProcessingStage" NOT NULL DEFAULT 'queued',
    "phase_order" INTEGER NOT NULL DEFAULT 0,
    "progress_current" INTEGER NOT NULL DEFAULT 0,
    "progress_total" INTEGER NOT NULL DEFAULT 1,
    "status_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "parser_key" TEXT,
    "artifact_location" TEXT,
    "result_summary" TEXT,
    "error_message" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "published_assertion_count" INTEGER NOT NULL DEFAULT 0,
    "published_object_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "library_source_processing_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_catalog_assessments" (
    "id" UUID NOT NULL,
    "processing_run_id" UUID NOT NULL,
    "source_blob_id" UUID NOT NULL,
    "representative_node_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "preview_excerpt" TEXT,
    "reference_candidates" JSONB NOT NULL DEFAULT '[]',
    "assertion_candidates" JSONB NOT NULL DEFAULT '[]',
    "object_candidates" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "library_catalog_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_source_documents" (
    "id" UUID NOT NULL,
    "processing_run_id" UUID,
    "source_blob_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "parser" TEXT NOT NULL,
    "block_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_source_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_plans" (
    "id" UUID NOT NULL,
    "status" "LibraryPlanStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "operations" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "applied_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,

    CONSTRAINT "library_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_source_regions" (
    "id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_node_id" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "lineage_node_ids" TEXT[],
    "source_pages" INTEGER[],
    "source_block_ids" TEXT[],
    "covered_block_ids" TEXT[],
    "unclaimed_block_ids" TEXT[],
    "initial_claim_count" INTEGER NOT NULL,
    "review_addition_count" INTEGER NOT NULL,
    "model_calls" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_source_regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_source_blocks" (
    "id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_block_id" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "block_type" TEXT NOT NULL,
    "source_pages" INTEGER[],
    "heading_level" INTEGER,
    "heading_path" TEXT[],
    "source_type" TEXT,
    "source_sub_type" TEXT,
    "bbox" JSONB,
    "asset_path" TEXT,
    "markdown" TEXT NOT NULL,

    CONSTRAINT "memory_source_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_source_object_fragments" (
    "id" UUID NOT NULL,
    "source_region_id" UUID NOT NULL,
    "source_fragment_id" TEXT NOT NULL,
    "surface_forms" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_source_object_fragments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_assertions" (
    "id" UUID NOT NULL,
    "source_region_id" UUID,
    "chat_capture_id" UUID,
    "source_claim_id" TEXT NOT NULL,
    "kind" "MemoryAssertionKind" NOT NULL DEFAULT 'grounded',
    "statement_template_markdown" TEXT NOT NULL,
    "global_statement_template_markdown" TEXT NOT NULL,
    "context_dependent" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_assertions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_chat_assertion_captures" (
    "id" UUID NOT NULL,
    "queued_by_actor_id" UUID NOT NULL,
    "queued_by_message_id" TEXT NOT NULL,
    "queue_reason" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "semantic_context" JSONB NOT NULL,
    "applied_surface_corrections" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_chat_assertion_captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_chat_assertion_receipts" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "client_message_id" TEXT NOT NULL,
    "execution" TEXT NOT NULL,
    "queue_reason" TEXT NOT NULL,
    "status" "MemoryChatAssertionReceiptStatus" NOT NULL DEFAULT 'queued',
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "conversation_id" UUID,
    "timezone" TEXT,
    "semantic_context" JSONB,
    "retrieval" JSONB,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "published_assertions" INTEGER NOT NULL DEFAULT 0,
    "published_assertion_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "affected_object_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "affected_objects" JSONB NOT NULL DEFAULT '[]',
    "outcome_summary" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_chat_assertion_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_chat_evidence" (
    "id" UUID NOT NULL,
    "conversation_id" UUID,
    "client_message_id" TEXT NOT NULL,
    "submitted_by_actor_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "raw_user_message" TEXT NOT NULL,
    "submitted_at_basis" TEXT NOT NULL DEFAULT 'server_received',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_chat_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_assertion_chat_evidence_links" (
    "assertion_id" UUID NOT NULL,
    "chat_evidence_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "evidence_quotes" TEXT[],

    CONSTRAINT "memory_assertion_chat_evidence_links_pkey" PRIMARY KEY ("assertion_id","chat_evidence_id")
);

-- CreateTable
CREATE TABLE "memory_actors" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_actors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_actor_higher_memories" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "scope" "MemoryActorHigherMemoryScope" NOT NULL,
    "content_markdown" TEXT NOT NULL,
    "maintained_at" TIMESTAMPTZ(3) NOT NULL,
    "trigger_message_id" TEXT NOT NULL,
    "maintenance_reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_actor_higher_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT '新对话',
    "archived_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_users" (
    "id" UUID NOT NULL,
    "login_name" TEXT NOT NULL,
    "normalized_login_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "AuthUserRole" NOT NULL DEFAULT 'MEMBER',
    "status" "AuthUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "actor_id" UUID NOT NULL,
    "actor_object_id" UUID,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "client_message_id" TEXT NOT NULL,
    "role" "ChatMessageRole" NOT NULL,
    "parts" JSONB NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_assertion_fragment_references" (
    "assertion_id" UUID NOT NULL,
    "object_fragment_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "memory_assertion_fragment_references_pkey" PRIMARY KEY ("assertion_id","ordinal")
);

-- CreateTable
CREATE TABLE "memory_assertion_source_blocks" (
    "assertion_id" UUID NOT NULL,
    "block_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "memory_assertion_source_blocks_pkey" PRIMARY KEY ("assertion_id","block_id")
);

-- CreateTable
CREATE TABLE "memory_global_objects" (
    "id" UUID NOT NULL,
    "global_object_key" TEXT NOT NULL,
    "canonical_name" TEXT NOT NULL,

    CONSTRAINT "memory_global_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_chat_object_mentions" (
    "global_object_id" UUID NOT NULL,
    "chat_evidence_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "surface_form" TEXT NOT NULL,
    "normalized_surface_form" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_chat_object_mentions_pkey" PRIMARY KEY ("global_object_id","chat_evidence_id","ordinal")
);

-- CreateTable
CREATE TABLE "memory_object_higher_memories" (
    "id" UUID NOT NULL,
    "global_object_id" UUID NOT NULL,
    "cognitive_memory" JSONB NOT NULL,
    "operational_index" JSONB NOT NULL DEFAULT '{"aspects":[]}',
    "maintained_at" TIMESTAMPTZ(3) NOT NULL,
    "trigger_message_id" TEXT NOT NULL,
    "maintenance_reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_object_higher_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_ambient_higher_memories" (
    "id" UUID NOT NULL,
    "scope" "MemoryAmbientHigherMemoryScope" NOT NULL,
    "content_markdown" TEXT NOT NULL,
    "maintained_at" TIMESTAMPTZ(3) NOT NULL,
    "trigger_message_id" TEXT NOT NULL,
    "maintenance_reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_ambient_higher_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "view_higher_memories" (
    "id" UUID NOT NULL,
    "view_key" TEXT NOT NULL,
    "content_markdown" TEXT NOT NULL,
    "maintained_at" TIMESTAMPTZ(3) NOT NULL,
    "maintenance_reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "view_higher_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_assertion_object_links" (
    "assertion_id" UUID NOT NULL,
    "global_object_id" UUID NOT NULL,

    CONSTRAINT "memory_assertion_object_links_pkey" PRIMARY KEY ("assertion_id","global_object_id")
);

-- CreateTable
CREATE TABLE "memory_assertion_object_occurrences" (
    "atom_id" TEXT NOT NULL,
    "assertion_id" UUID NOT NULL,
    "global_object_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "source_start" INTEGER NOT NULL,
    "source_end" INTEGER NOT NULL,
    "source_text" TEXT NOT NULL,

    CONSTRAINT "memory_assertion_object_occurrences_pkey" PRIMARY KEY ("atom_id")
);

-- CreateTable
CREATE TABLE "memory_assertion_object_coverage" (
    "assertion_id" UUID NOT NULL,
    "global_object_id" UUID NOT NULL,

    CONSTRAINT "memory_assertion_object_coverage_pkey" PRIMARY KEY ("assertion_id","global_object_id")
);

-- CreateTable
CREATE TABLE "memory_global_object_surface_memberships" (
    "object_fragment_id" UUID NOT NULL,
    "surface_form_ordinal" INTEGER NOT NULL,
    "global_object_id" UUID NOT NULL,

    CONSTRAINT "memory_global_object_surface_memberships_pkey" PRIMARY KEY ("object_fragment_id","surface_form_ordinal")
);

-- CreateTable
CREATE TABLE "memory_assertion_embedding_indexes" (
    "id" TEXT NOT NULL DEFAULT 'shared',
    "model_key" TEXT NOT NULL,
    "model_revision" TEXT NOT NULL,
    "dimension" INTEGER NOT NULL,
    "indexed_assertion_count" INTEGER NOT NULL,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_assertion_embedding_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_assertion_embeddings" (
    "assertion_id" UUID NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_assertion_embeddings_pkey" PRIMARY KEY ("assertion_id")
);

-- CreateTable
CREATE TABLE "installed_views" (
    "view_key" TEXT NOT NULL,
    "module_id" TEXT NOT NULL,
    "module_version" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "state_version" BIGINT NOT NULL DEFAULT 0,
    "status" "InstalledViewStatus" NOT NULL DEFAULT 'enabled',
    "settings_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "installed_views_pkey" PRIMARY KEY ("view_key")
);

-- CreateTable
CREATE TABLE "view_cards" (
    "id" UUID NOT NULL,
    "view_key" TEXT NOT NULL,
    "card_type_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "view_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "view_dimension_values" (
    "card_id" UUID NOT NULL,
    "dimension_key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "view_dimension_values_pkey" PRIMARY KEY ("card_id","dimension_key")
);

-- CreateTable
CREATE TABLE "view_slot_bindings" (
    "source_card_id" UUID NOT NULL,
    "slot_key" TEXT NOT NULL,
    "target_card_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "view_slot_bindings_pkey" PRIMARY KEY ("source_card_id","slot_key","target_card_id")
);

-- CreateTable
CREATE TABLE "view_card_related_objects" (
    "card_id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "view_card_related_objects_pkey" PRIMARY KEY ("card_id","object_id")
);

-- CreateTable
CREATE TABLE "view_command_proposals" (
    "id" UUID NOT NULL,
    "view_key" TEXT NOT NULL,
    "command_key" TEXT NOT NULL,
    "command_version" TEXT NOT NULL,
    "input_json" JSONB NOT NULL,
    "expected_state_version" BIGINT NOT NULL,
    "proposed_by_actor_id" UUID,
    "skill_id" TEXT,
    "execution_id" UUID,
    "status" "ProposalStatus" NOT NULL DEFAULT 'pending',
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "applied_at" TIMESTAMPTZ(3),

    CONSTRAINT "view_command_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "view_command_executions" (
    "id" UUID NOT NULL,
    "view_key" TEXT NOT NULL,
    "command_key" TEXT NOT NULL,
    "command_version" TEXT NOT NULL,
    "input_json" JSONB NOT NULL,
    "actor_id" UUID,
    "initiator" "ViewCommandInitiator" NOT NULL,
    "skill_id" TEXT,
    "state_version_before" BIGINT NOT NULL,
    "state_version_after" BIGINT NOT NULL,
    "result_summary_json" JSONB,
    "change_set_json" JSONB NOT NULL DEFAULT '[]',
    "events_json" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "view_command_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "view_change_reactions" (
    "id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "view_key" TEXT NOT NULL,
    "actor_id" UUID,
    "state_version" BIGINT NOT NULL,
    "targets_json" JSONB NOT NULL,
    "prior_objects_json" JSONB NOT NULL DEFAULT '[]',
    "attention_policy" TEXT NOT NULL,
    "attention_status" "ViewReactionAttentionStatus" NOT NULL,
    "knowledge_policy" TEXT NOT NULL,
    "knowledge_status" "ViewReactionKnowledgeStatus" NOT NULL,
    "guidance_json" JSONB NOT NULL DEFAULT '[]',
    "message" TEXT,
    "reason" TEXT,
    "attention_error_message" TEXT,
    "knowledge_error_message" TEXT,
    "settle_until" TIMESTAMPTZ(3) NOT NULL,
    "attention_started_at" TIMESTAMPTZ(3),
    "attention_completed_at" TIMESTAMPTZ(3),
    "knowledge_started_at" TIMESTAMPTZ(3),
    "knowledge_completed_at" TIMESTAMPTZ(3),
    "seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "view_change_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_object_change_proposals" (
    "id" UUID NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "applied_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,

    CONSTRAINT "memory_object_change_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "library_source_blobs_sha256_key" ON "library_source_blobs"("sha256");

-- CreateIndex
CREATE INDEX "library_nodes_parent_id_kind_name_idx" ON "library_nodes"("parent_id", "kind", "name");

-- CreateIndex
CREATE INDEX "library_nodes_blob_id_idx" ON "library_nodes"("blob_id");

-- CreateIndex
CREATE INDEX "library_nodes_processing_profile_processing_status_idx" ON "library_nodes"("processing_profile", "processing_status");

-- CreateIndex
CREATE UNIQUE INDEX "library_nodes_parent_id_normalized_name_key" ON "library_nodes"("parent_id", "normalized_name");

-- CreateIndex
CREATE INDEX "library_compilation_jobs_status_created_at_idx" ON "library_compilation_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "library_source_processing_runs_library_node_id_created_at_idx" ON "library_source_processing_runs"("library_node_id", "created_at");

-- CreateIndex
CREATE INDEX "library_source_processing_runs_status_created_at_idx" ON "library_source_processing_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "library_source_processing_runs_job_id_phase_order_status_idx" ON "library_source_processing_runs"("job_id", "phase_order", "status");

-- CreateIndex
CREATE INDEX "library_source_processing_runs_source_blob_id_is_current_idx" ON "library_source_processing_runs"("source_blob_id", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "library_source_processing_runs_job_id_source_blob_id_key" ON "library_source_processing_runs"("job_id", "source_blob_id");

-- CreateIndex
CREATE UNIQUE INDEX "library_catalog_assessments_processing_run_id_key" ON "library_catalog_assessments"("processing_run_id");

-- CreateIndex
CREATE INDEX "library_catalog_assessments_source_blob_id_idx" ON "library_catalog_assessments"("source_blob_id");

-- CreateIndex
CREATE UNIQUE INDEX "library_source_documents_processing_run_id_key" ON "library_source_documents"("processing_run_id");

-- CreateIndex
CREATE INDEX "library_source_documents_source_blob_id_idx" ON "library_source_documents"("source_blob_id");

-- CreateIndex
CREATE INDEX "library_plans_status_created_at_idx" ON "library_plans"("status", "created_at");

-- CreateIndex
CREATE INDEX "memory_source_regions_source_document_id_idx" ON "memory_source_regions"("source_document_id");

-- CreateIndex
CREATE INDEX "memory_source_regions_label_idx" ON "memory_source_regions"("label");

-- CreateIndex
CREATE UNIQUE INDEX "memory_source_regions_source_document_id_source_node_id_key" ON "memory_source_regions"("source_document_id", "source_node_id");

-- CreateIndex
CREATE INDEX "memory_source_blocks_source_document_id_idx" ON "memory_source_blocks"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_source_blocks_source_document_id_source_block_id_key" ON "memory_source_blocks"("source_document_id", "source_block_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_source_blocks_source_document_id_order_key" ON "memory_source_blocks"("source_document_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "memory_source_object_fragments_source_region_id_source_frag_key" ON "memory_source_object_fragments"("source_region_id", "source_fragment_id");

-- CreateIndex
CREATE INDEX "memory_assertions_chat_capture_id_idx" ON "memory_assertions"("chat_capture_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_assertions_source_region_id_source_claim_id_key" ON "memory_assertions"("source_region_id", "source_claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_assertions_chat_capture_id_source_claim_id_key" ON "memory_assertions"("chat_capture_id", "source_claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_chat_assertion_captures_queued_by_actor_id_queued_by_key" ON "memory_chat_assertion_captures"("queued_by_actor_id", "queued_by_message_id");

-- CreateIndex
CREATE INDEX "chat_assertion_receipts_recovery_idx" ON "memory_chat_assertion_receipts"("actor_id", "execution", "status", "started_at");

-- CreateIndex
CREATE INDEX "memory_chat_assertion_receipts_actor_id_updated_at_idx" ON "memory_chat_assertion_receipts"("actor_id", "updated_at");

-- CreateIndex
CREATE INDEX "memory_chat_assertion_receipts_conversation_id_submitted_at_idx" ON "memory_chat_assertion_receipts"("conversation_id", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_chat_assertion_receipts_actor_id_client_message_id_key" ON "memory_chat_assertion_receipts"("actor_id", "client_message_id");

-- CreateIndex
CREATE INDEX "memory_chat_evidence_conversation_id_submitted_at_idx" ON "memory_chat_evidence"("conversation_id", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_chat_evidence_submitted_by_actor_id_client_message_i_key" ON "memory_chat_evidence"("submitted_by_actor_id", "client_message_id");

-- CreateIndex
CREATE INDEX "memory_assertion_chat_evidence_links_chat_evidence_id_idx" ON "memory_assertion_chat_evidence_links"("chat_evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_assertion_chat_evidence_links_assertion_id_ordinal_key" ON "memory_assertion_chat_evidence_links"("assertion_id", "ordinal");

-- CreateIndex
CREATE INDEX "memory_actor_higher_memories_actor_id_maintained_at_idx" ON "memory_actor_higher_memories"("actor_id", "maintained_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_actor_higher_memories_actor_id_scope_key" ON "memory_actor_higher_memories"("actor_id", "scope");

-- CreateIndex
CREATE INDEX "chat_conversations_actor_id_archived_at_last_message_at_idx" ON "chat_conversations"("actor_id", "archived_at", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_users_normalized_login_name_key" ON "auth_users"("normalized_login_name");

-- CreateIndex
CREATE UNIQUE INDEX "auth_users_actor_id_key" ON "auth_users"("actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_users_actor_object_id_key" ON "auth_users"("actor_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_expires_at_idx" ON "auth_sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "chat_messages_conversation_id_position_created_at_idx" ON "chat_messages"("conversation_id", "position", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_conversation_id_client_message_id_key" ON "chat_messages"("conversation_id", "client_message_id");

-- CreateIndex
CREATE INDEX "memory_assertion_fragment_references_object_fragment_id_idx" ON "memory_assertion_fragment_references"("object_fragment_id");

-- CreateIndex
CREATE INDEX "memory_assertion_source_blocks_block_id_idx" ON "memory_assertion_source_blocks"("block_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_global_objects_global_object_key_key" ON "memory_global_objects"("global_object_key");

-- CreateIndex
CREATE INDEX "memory_chat_object_mentions_global_object_id_idx" ON "memory_chat_object_mentions"("global_object_id");

-- CreateIndex
CREATE INDEX "memory_chat_object_mentions_chat_evidence_id_idx" ON "memory_chat_object_mentions"("chat_evidence_id");

-- CreateIndex
CREATE INDEX "memory_chat_object_mentions_normalized_surface_form_idx" ON "memory_chat_object_mentions"("normalized_surface_form");

-- CreateIndex
CREATE UNIQUE INDEX "memory_chat_object_mentions_chat_evidence_id_ordinal_key" ON "memory_chat_object_mentions"("chat_evidence_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "memory_chat_object_mentions_global_object_id_chat_evidence__key" ON "memory_chat_object_mentions"("global_object_id", "chat_evidence_id", "surface_form");

-- CreateIndex
CREATE UNIQUE INDEX "memory_object_higher_memories_global_object_id_key" ON "memory_object_higher_memories"("global_object_id");

-- CreateIndex
CREATE INDEX "memory_object_higher_memories_maintained_at_idx" ON "memory_object_higher_memories"("maintained_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_ambient_higher_memories_scope_key" ON "memory_ambient_higher_memories"("scope");

-- CreateIndex
CREATE INDEX "memory_ambient_higher_memories_maintained_at_idx" ON "memory_ambient_higher_memories"("maintained_at");

-- CreateIndex
CREATE UNIQUE INDEX "view_higher_memories_view_key_key" ON "view_higher_memories"("view_key");

-- CreateIndex
CREATE INDEX "view_higher_memories_maintained_at_idx" ON "view_higher_memories"("maintained_at");

-- CreateIndex
CREATE INDEX "memory_assertion_object_links_global_object_id_idx" ON "memory_assertion_object_links"("global_object_id");

-- CreateIndex
CREATE INDEX "memory_assertion_object_occurrences_global_object_id_idx" ON "memory_assertion_object_occurrences"("global_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_assertion_object_occurrences_assertion_id_ordinal_key" ON "memory_assertion_object_occurrences"("assertion_id", "ordinal");

-- CreateIndex
CREATE INDEX "memory_assertion_object_coverage_global_object_id_idx" ON "memory_assertion_object_coverage"("global_object_id");

-- CreateIndex
CREATE INDEX "memory_global_object_surface_memberships_global_object_id_idx" ON "memory_global_object_surface_memberships"("global_object_id");

-- CreateIndex
CREATE INDEX "view_cards_view_key_card_type_key_idx" ON "view_cards"("view_key", "card_type_key");

-- CreateIndex
CREATE INDEX "view_slot_bindings_target_card_id_idx" ON "view_slot_bindings"("target_card_id");

-- CreateIndex
CREATE INDEX "view_slot_bindings_source_card_id_slot_key_position_idx" ON "view_slot_bindings"("source_card_id", "slot_key", "position");

-- CreateIndex
CREATE INDEX "view_card_related_objects_object_id_idx" ON "view_card_related_objects"("object_id");

-- CreateIndex
CREATE UNIQUE INDEX "view_command_proposals_execution_id_key" ON "view_command_proposals"("execution_id");

-- CreateIndex
CREATE INDEX "view_command_proposals_view_key_status_created_at_idx" ON "view_command_proposals"("view_key", "status", "created_at");

-- CreateIndex
CREATE INDEX "view_command_executions_view_key_created_at_idx" ON "view_command_executions"("view_key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "view_change_reactions_execution_id_key" ON "view_change_reactions"("execution_id");

-- CreateIndex
CREATE INDEX "view_change_reactions_actor_id_view_key_created_at_idx" ON "view_change_reactions"("actor_id", "view_key", "created_at");

-- CreateIndex
CREATE INDEX "view_change_reactions_attention_status_settle_until_idx" ON "view_change_reactions"("attention_status", "settle_until");

-- CreateIndex
CREATE INDEX "view_change_reactions_knowledge_status_settle_until_idx" ON "view_change_reactions"("knowledge_status", "settle_until");

-- CreateIndex
CREATE INDEX "memory_object_change_proposals_status_created_at_idx" ON "memory_object_change_proposals"("status", "created_at");

-- AddForeignKey
ALTER TABLE "library_nodes" ADD CONSTRAINT "library_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "library_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_nodes" ADD CONSTRAINT "library_nodes_blob_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "library_source_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_nodes" ADD CONSTRAINT "library_nodes_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "library_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_source_processing_runs" ADD CONSTRAINT "library_source_processing_runs_library_node_id_fkey" FOREIGN KEY ("library_node_id") REFERENCES "library_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_source_processing_runs" ADD CONSTRAINT "library_source_processing_runs_source_blob_id_fkey" FOREIGN KEY ("source_blob_id") REFERENCES "library_source_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_source_processing_runs" ADD CONSTRAINT "library_source_processing_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "library_compilation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_catalog_assessments" ADD CONSTRAINT "library_catalog_assessments_processing_run_id_fkey" FOREIGN KEY ("processing_run_id") REFERENCES "library_source_processing_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_catalog_assessments" ADD CONSTRAINT "library_catalog_assessments_source_blob_id_fkey" FOREIGN KEY ("source_blob_id") REFERENCES "library_source_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_catalog_assessments" ADD CONSTRAINT "library_catalog_assessments_representative_node_id_fkey" FOREIGN KEY ("representative_node_id") REFERENCES "library_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_source_documents" ADD CONSTRAINT "library_source_documents_processing_run_id_fkey" FOREIGN KEY ("processing_run_id") REFERENCES "library_source_processing_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_source_documents" ADD CONSTRAINT "library_source_documents_source_blob_id_fkey" FOREIGN KEY ("source_blob_id") REFERENCES "library_source_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_source_regions" ADD CONSTRAINT "memory_source_regions_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "library_source_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_source_blocks" ADD CONSTRAINT "memory_source_blocks_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "library_source_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_source_object_fragments" ADD CONSTRAINT "memory_source_object_fragments_source_region_id_fkey" FOREIGN KEY ("source_region_id") REFERENCES "memory_source_regions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertions" ADD CONSTRAINT "memory_assertions_source_region_id_fkey" FOREIGN KEY ("source_region_id") REFERENCES "memory_source_regions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertions" ADD CONSTRAINT "memory_assertions_chat_capture_id_fkey" FOREIGN KEY ("chat_capture_id") REFERENCES "memory_chat_assertion_captures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_chat_assertion_captures" ADD CONSTRAINT "memory_chat_assertion_captures_queued_by_actor_id_fkey" FOREIGN KEY ("queued_by_actor_id") REFERENCES "memory_actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_chat_assertion_receipts" ADD CONSTRAINT "memory_chat_assertion_receipts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "memory_actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_chat_assertion_receipts" ADD CONSTRAINT "memory_chat_assertion_receipts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_chat_evidence" ADD CONSTRAINT "memory_chat_evidence_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_chat_evidence" ADD CONSTRAINT "memory_chat_evidence_submitted_by_actor_id_fkey" FOREIGN KEY ("submitted_by_actor_id") REFERENCES "memory_actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_chat_evidence_links" ADD CONSTRAINT "memory_assertion_chat_evidence_links_assertion_id_fkey" FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_chat_evidence_links" ADD CONSTRAINT "memory_assertion_chat_evidence_links_chat_evidence_id_fkey" FOREIGN KEY ("chat_evidence_id") REFERENCES "memory_chat_evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_actor_higher_memories" ADD CONSTRAINT "memory_actor_higher_memories_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "memory_actors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "memory_actors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_users" ADD CONSTRAINT "auth_users_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "memory_actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_users" ADD CONSTRAINT "auth_users_actor_object_id_fkey" FOREIGN KEY ("actor_object_id") REFERENCES "memory_global_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_fragment_references" ADD CONSTRAINT "memory_assertion_fragment_references_assertion_id_fkey" FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_fragment_references" ADD CONSTRAINT "memory_assertion_fragment_references_object_fragment_id_fkey" FOREIGN KEY ("object_fragment_id") REFERENCES "memory_source_object_fragments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_source_blocks" ADD CONSTRAINT "memory_assertion_source_blocks_assertion_id_fkey" FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_source_blocks" ADD CONSTRAINT "memory_assertion_source_blocks_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "memory_source_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_chat_object_mentions" ADD CONSTRAINT "memory_chat_object_mentions_global_object_id_fkey" FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_chat_object_mentions" ADD CONSTRAINT "memory_chat_object_mentions_chat_evidence_id_fkey" FOREIGN KEY ("chat_evidence_id") REFERENCES "memory_chat_evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_object_higher_memories" ADD CONSTRAINT "memory_object_higher_memories_global_object_id_fkey" FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_higher_memories" ADD CONSTRAINT "view_higher_memories_view_key_fkey" FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_object_links" ADD CONSTRAINT "memory_assertion_object_links_assertion_id_fkey" FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_object_links" ADD CONSTRAINT "memory_assertion_object_links_global_object_id_fkey" FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_object_occurrences" ADD CONSTRAINT "memory_assertion_object_occurrences_assertion_id_global_ob_fkey" FOREIGN KEY ("assertion_id", "global_object_id") REFERENCES "memory_assertion_object_links"("assertion_id", "global_object_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_object_coverage" ADD CONSTRAINT "memory_assertion_object_coverage_assertion_id_fkey" FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_object_coverage" ADD CONSTRAINT "memory_assertion_object_coverage_global_object_id_fkey" FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_global_object_surface_memberships" ADD CONSTRAINT "memory_global_object_surface_memberships_object_fragment_i_fkey" FOREIGN KEY ("object_fragment_id") REFERENCES "memory_source_object_fragments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_global_object_surface_memberships" ADD CONSTRAINT "memory_global_object_surface_memberships_global_object_id_fkey" FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_assertion_embeddings" ADD CONSTRAINT "memory_assertion_embeddings_assertion_id_fkey" FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_cards" ADD CONSTRAINT "view_cards_view_key_fkey" FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_dimension_values" ADD CONSTRAINT "view_dimension_values_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "view_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_slot_bindings" ADD CONSTRAINT "view_slot_bindings_source_card_id_fkey" FOREIGN KEY ("source_card_id") REFERENCES "view_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_slot_bindings" ADD CONSTRAINT "view_slot_bindings_target_card_id_fkey" FOREIGN KEY ("target_card_id") REFERENCES "view_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_card_related_objects" ADD CONSTRAINT "view_card_related_objects_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "view_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_card_related_objects" ADD CONSTRAINT "view_card_related_objects_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "memory_global_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_command_proposals" ADD CONSTRAINT "view_command_proposals_view_key_fkey" FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_command_proposals" ADD CONSTRAINT "view_command_proposals_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "view_command_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_command_executions" ADD CONSTRAINT "view_command_executions_view_key_fkey" FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_change_reactions" ADD CONSTRAINT "view_change_reactions_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "view_command_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_change_reactions" ADD CONSTRAINT "view_change_reactions_view_key_fkey" FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Runtime invariants not expressible in the Prisma schema

-- AddCheckConstraint
ALTER TABLE "memory_assertions"
ADD CONSTRAINT "memory_assertions_exactly_one_source_check"
CHECK (num_nonnulls("source_region_id", "chat_capture_id") = 1);

-- AddCheckConstraint
ALTER TABLE "memory_assertions"
ADD CONSTRAINT "memory_assertions_chat_must_be_grounded_check"
CHECK ("chat_capture_id" IS NULL OR "kind" = 'grounded');

-- AddCheckConstraint
ALTER TABLE "memory_assertion_fragment_references"
ADD CONSTRAINT "memory_assertion_fragment_references_ordinal_check"
CHECK ("ordinal" >= 0);

-- AddCheckConstraint
ALTER TABLE "memory_global_object_surface_memberships"
ADD CONSTRAINT "memory_global_object_surface_memberships_ordinal_check"
CHECK ("surface_form_ordinal" >= 0);

-- AddCheckConstraint
ALTER TABLE "memory_assertion_embedding_indexes"
ADD CONSTRAINT "memory_assertion_embedding_indexes_dimension_check"
CHECK ("dimension" = 1024);

-- AddCheckConstraint
ALTER TABLE "memory_assertion_embedding_indexes"
ADD CONSTRAINT "memory_assertion_embedding_indexes_count_check"
CHECK ("indexed_assertion_count" >= 0);

-- AddCheckConstraint
ALTER TABLE "library_nodes"
ADD CONSTRAINT "library_nodes_kind_blob_check"
CHECK (
  ("kind" = 'file' AND "blob_id" IS NOT NULL) OR
  ("kind" = 'folder' AND "blob_id" IS NULL)
);

-- AddCheckConstraint
ALTER TABLE "memory_assertion_object_occurrences"
ADD CONSTRAINT "memory_assertion_object_occurrences_source_span_check"
CHECK ("ordinal" >= 0 AND "source_start" >= 0 AND "source_end" > "source_start");

-- CreatePartialUniqueIndex
CREATE UNIQUE INDEX "library_source_processing_runs_one_current_per_blob"
ON "library_source_processing_runs"("source_blob_id")
WHERE "is_current" = true AND "source_blob_id" IS NOT NULL;

-- EnforceViewLocalSlot
CREATE OR REPLACE FUNCTION "enforce_view_local_slot"()
RETURNS TRIGGER AS $$
DECLARE
  source_view TEXT;
  target_view TEXT;
BEGIN
  SELECT "view_key" INTO source_view FROM "view_cards" WHERE "id" = NEW."source_card_id";
  SELECT "view_key" INTO target_view FROM "view_cards" WHERE "id" = NEW."target_card_id";
  IF source_view IS NULL OR target_view IS NULL OR source_view <> target_view THEN
    RAISE EXCEPTION 'ViewSlotBinding must remain inside one View';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "view_slot_bindings_same_view"
BEFORE INSERT OR UPDATE ON "view_slot_bindings"
FOR EACH ROW EXECUTE FUNCTION "enforce_view_local_slot"();
