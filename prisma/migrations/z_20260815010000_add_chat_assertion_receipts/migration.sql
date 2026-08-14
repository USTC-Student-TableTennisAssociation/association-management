-- Chat → Assertion 的操作回执独立于组织事实、Evidence 和成功 Capture。
CREATE TYPE "MemoryChatAssertionReceiptStatus" AS ENUM (
  'queued',
  'running',
  'published',
  'skipped',
  'failed'
);

CREATE TABLE "memory_chat_assertion_receipts" (
  "id" UUID NOT NULL,
  "compilation_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "client_message_id" TEXT NOT NULL,
  "execution" TEXT NOT NULL,
  "queue_reason" TEXT NOT NULL,
  "status" "MemoryChatAssertionReceiptStatus" NOT NULL DEFAULT 'queued',
  "submitted_at" TIMESTAMPTZ(3) NOT NULL,
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "published_assertions" INTEGER NOT NULL DEFAULT 0,
  "published_assertion_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "affected_object_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "affected_objects" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "outcome_summary" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "memory_chat_assertion_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_chat_assertion_receipts_actor_id_client_message_id_key"
  ON "memory_chat_assertion_receipts"("actor_id", "client_message_id");
CREATE INDEX "memory_chat_assertion_receipts_compilation_id_submitted_at_idx"
  ON "memory_chat_assertion_receipts"("compilation_id", "submitted_at");
CREATE INDEX "memory_chat_assertion_receipts_actor_id_updated_at_idx"
  ON "memory_chat_assertion_receipts"("actor_id", "updated_at");

ALTER TABLE "memory_chat_assertion_receipts"
  ADD CONSTRAINT "memory_chat_assertion_receipts_compilation_id_fkey"
  FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_chat_assertion_receipts"
  ADD CONSTRAINT "memory_chat_assertion_receipts_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "memory_actors"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
