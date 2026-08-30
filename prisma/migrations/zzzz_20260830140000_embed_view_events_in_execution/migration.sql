ALTER TABLE "view_command_executions"
  ADD COLUMN "events_json" JSONB NOT NULL DEFAULT '[]';

DROP TABLE "domain_event_outbox";
