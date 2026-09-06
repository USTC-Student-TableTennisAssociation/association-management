-- The same per-turn operational receipt now records Higher Memory execution,
-- so the next conversation can distinguish absent state from failed/skipped work.
ALTER TABLE "memory_chat_assertion_receipts"
ADD COLUMN "shared_higher_memory_status" TEXT,
ADD COLUMN "shared_higher_memory_targets" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "shared_higher_memory_maintained" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "shared_higher_memory_error" TEXT,
ADD COLUMN "actor_higher_memory_status" TEXT,
ADD COLUMN "actor_higher_memory_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "actor_higher_memory_maintained" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "actor_higher_memory_error" TEXT;

ALTER TABLE "memory_chat_assertion_receipts"
ADD CONSTRAINT "memory_chat_assertion_receipts_shared_hm_count_check"
CHECK ("shared_higher_memory_maintained" >= 0),
ADD CONSTRAINT "memory_chat_assertion_receipts_actor_hm_count_check"
CHECK ("actor_higher_memory_maintained" >= 0);
