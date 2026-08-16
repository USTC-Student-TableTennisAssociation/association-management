UPDATE "library_compilation_jobs"
SET
    "status" = 'paused',
    "active_phase" = NULL,
    "active_stage" = NULL,
    "pause_requested" = FALSE,
    "global_status" = 'queued',
    "global_progress" = 0,
    "global_total" = 0,
    "global_retry_count" = 0,
    "global_status_message" = 'Global Object 结构已删除 identity summary，需要重新归并',
    "global_error_message" = NULL,
    "global_checkpoint" = '{}'::jsonb,
    "global_result" = '{}'::jsonb,
    "completed_at" = NULL
WHERE
    "global_checkpoint"::text LIKE '%"identitySummary"%'
    OR "global_result"::text LIKE '%"identitySummary"%';
