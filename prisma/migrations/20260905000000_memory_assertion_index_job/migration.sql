-- Assertion embeddings are derived data, but their recovery state must survive
-- process restarts and temporary embedding-service outages.
CREATE TYPE "MemoryAssertionIndexJobStatus" AS ENUM ('queued', 'running', 'ready');

CREATE TABLE "memory_assertion_index_jobs" (
    "id" TEXT NOT NULL DEFAULT 'shared',
    "status" "MemoryAssertionIndexJobStatus" NOT NULL DEFAULT 'queued',
    "target_revision" TEXT NOT NULL,
    "indexed_revision" TEXT,
    "target_assertion_count" INTEGER NOT NULL DEFAULT 0,
    "completed_assertion_count" INTEGER NOT NULL DEFAULT 0,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "next_attempt_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_assertion_index_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_assertion_index_jobs_target_count_check" CHECK ("target_assertion_count" >= 0),
    CONSTRAINT "memory_assertion_index_jobs_completed_count_check" CHECK ("completed_assertion_count" >= 0),
    CONSTRAINT "memory_assertion_index_jobs_attempt_count_check" CHECK ("attempt_count" >= 0)
);

CREATE INDEX "memory_assertion_index_jobs_status_next_attempt_at_idx"
ON "memory_assertion_index_jobs"("status", "next_attempt_at");
