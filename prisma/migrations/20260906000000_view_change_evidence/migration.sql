ALTER TABLE "view_change_reactions"
ADD COLUMN "evidence_status" TEXT NOT NULL DEFAULT 'not_checked',
ADD COLUMN "evidence_json" JSONB NOT NULL DEFAULT '{}';
