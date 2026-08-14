-- Object 身份修改采用可审计 Proposal；批准前不改变 GlobalObject 图。
CREATE TABLE "memory_object_change_proposals" (
  "id" UUID NOT NULL,
  "compilation_id" UUID NOT NULL,
  "status" "SemanticCardProposalStatus" NOT NULL DEFAULT 'pending',
  "reason" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMPTZ(3),
  "applied_at" TIMESTAMPTZ(3),
  "failure_reason" TEXT,

  CONSTRAINT "memory_object_change_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_object_change_proposals_compilation_id_status_created_at_idx"
  ON "memory_object_change_proposals"("compilation_id", "status", "created_at");

ALTER TABLE "memory_object_change_proposals"
  ADD CONSTRAINT "memory_object_change_proposals_compilation_id_fkey"
  FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
