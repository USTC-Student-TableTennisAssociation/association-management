ALTER TABLE "view_command_proposals"
  ADD COLUMN "execution_id" UUID;

CREATE UNIQUE INDEX "view_command_proposals_execution_id_key"
  ON "view_command_proposals"("execution_id");

ALTER TABLE "view_command_proposals"
  ADD CONSTRAINT "view_command_proposals_execution_id_fkey"
  FOREIGN KEY ("execution_id") REFERENCES "view_command_executions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
