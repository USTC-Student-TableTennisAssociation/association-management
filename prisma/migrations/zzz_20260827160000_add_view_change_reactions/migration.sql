CREATE TYPE "ViewReactionAttentionStatus" AS ENUM (
  'not_required',
  'queued',
  'running',
  'silent',
  'inform',
  'needs_confirmation',
  'failed'
);

CREATE TYPE "ViewReactionKnowledgeStatus" AS ENUM (
  'not_required',
  'queued',
  'running',
  'completed',
  'failed'
);

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

CREATE UNIQUE INDEX "view_change_reactions_execution_id_key"
  ON "view_change_reactions"("execution_id");
CREATE INDEX "view_change_reactions_actor_id_view_key_created_at_idx"
  ON "view_change_reactions"("actor_id", "view_key", "created_at");
CREATE INDEX "view_change_reactions_attention_status_settle_until_idx"
  ON "view_change_reactions"("attention_status", "settle_until");
CREATE INDEX "view_change_reactions_knowledge_status_settle_until_idx"
  ON "view_change_reactions"("knowledge_status", "settle_until");

ALTER TABLE "view_change_reactions"
  ADD CONSTRAINT "view_change_reactions_execution_id_fkey"
  FOREIGN KEY ("execution_id") REFERENCES "view_command_executions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "view_change_reactions"
  ADD CONSTRAINT "view_change_reactions_view_key_fkey"
  FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key")
  ON DELETE RESTRICT ON UPDATE CASCADE;
