ALTER TABLE "library_compilation_jobs"
  ADD COLUMN "active_stage" TEXT,
  ADD COLUMN "global_status" TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN "global_progress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "global_total" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "global_retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "global_status_message" TEXT,
  ADD COLUMN "global_error_message" TEXT,
  ADD COLUMN "global_checkpoint" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "global_result" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "library_source_processing_runs"
  ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "checkpoint" JSONB NOT NULL DEFAULT '{}';

UPDATE "library_compilation_jobs"
SET
  "global_status" = 'ready',
  "global_status_message" = '旧任务创建于跨文件 Global Object 阶段上线前'
WHERE "status" IN ('completed', 'awaiting_review');
