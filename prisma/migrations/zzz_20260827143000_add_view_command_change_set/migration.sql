ALTER TABLE "view_command_executions"
ADD COLUMN "change_set_json" JSONB NOT NULL DEFAULT '[]'::JSONB;
