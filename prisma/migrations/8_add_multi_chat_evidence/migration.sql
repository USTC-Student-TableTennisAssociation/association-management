CREATE TABLE "memory_chat_assertion_captures" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "queued_by_actor_id" UUID NOT NULL,
    "queued_by_message_id" TEXT NOT NULL,
    "queue_reason" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "semantic_context" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_chat_assertion_captures_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "memory_chat_evidence"
    ADD COLUMN "submitted_at_basis" TEXT NOT NULL DEFAULT 'server_received';

INSERT INTO "memory_chat_assertion_captures" (
    "id", "compilation_id", "queued_by_actor_id", "queued_by_message_id",
    "queue_reason", "submitted_at", "timezone", "semantic_context", "created_at"
)
SELECT
    evidence."id", evidence."compilation_id", evidence."submitted_by_actor_id",
    evidence."client_message_id", '由旧版单 Evidence Chat Assertion 迁移',
    evidence."submitted_at", evidence."timezone",
    COALESCE(evidence."interpretation_context", 'null'::jsonb), evidence."created_at"
FROM "memory_chat_evidence" AS evidence
WHERE EXISTS (
    SELECT 1 FROM "memory_assertions" AS assertion
    WHERE assertion."chat_evidence_id" = evidence."id"
);

ALTER TABLE "memory_assertions" ADD COLUMN "chat_capture_id" UUID;
UPDATE "memory_assertions"
SET "chat_capture_id" = "chat_evidence_id"
WHERE "chat_evidence_id" IS NOT NULL;

CREATE TABLE "memory_assertion_chat_evidence_links" (
    "assertion_id" UUID NOT NULL,
    "chat_evidence_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "evidence_quotes" TEXT[] NOT NULL,
    CONSTRAINT "memory_assertion_chat_evidence_links_pkey"
        PRIMARY KEY ("assertion_id", "chat_evidence_id")
);

INSERT INTO "memory_assertion_chat_evidence_links" (
    "assertion_id", "chat_evidence_id", "ordinal", "evidence_quotes"
)
SELECT assertion."id", assertion."chat_evidence_id", 0,
       ARRAY[evidence."raw_user_message"]::TEXT[]
FROM "memory_assertions" AS assertion
JOIN "memory_chat_evidence" AS evidence
  ON evidence."id" = assertion."chat_evidence_id"
WHERE assertion."chat_evidence_id" IS NOT NULL;

ALTER TABLE "memory_assertions"
    DROP CONSTRAINT "memory_assertions_exactly_one_source_check",
    DROP CONSTRAINT "memory_assertions_chat_must_be_grounded_check",
    DROP CONSTRAINT "memory_assertions_chat_evidence_id_fkey";
DROP INDEX "memory_assertions_chat_evidence_id_source_claim_id_key";
DROP INDEX "memory_assertions_chat_evidence_id_idx";
ALTER TABLE "memory_assertions" DROP COLUMN "chat_evidence_id";
ALTER TABLE "memory_chat_evidence" DROP COLUMN "interpretation_context";

CREATE UNIQUE INDEX "memory_chat_assertion_captures_queued_by_actor_id_queued_by_message_id_key"
    ON "memory_chat_assertion_captures"("queued_by_actor_id", "queued_by_message_id");
CREATE INDEX "memory_chat_assertion_captures_compilation_id_submitted_at_idx"
    ON "memory_chat_assertion_captures"("compilation_id", "submitted_at");
CREATE UNIQUE INDEX "memory_assertions_chat_capture_id_source_claim_id_key"
    ON "memory_assertions"("chat_capture_id", "source_claim_id");
CREATE INDEX "memory_assertions_chat_capture_id_idx"
    ON "memory_assertions"("chat_capture_id");
CREATE UNIQUE INDEX "memory_assertion_chat_evidence_links_assertion_id_ordinal_key"
    ON "memory_assertion_chat_evidence_links"("assertion_id", "ordinal");
CREATE INDEX "memory_assertion_chat_evidence_links_chat_evidence_id_idx"
    ON "memory_assertion_chat_evidence_links"("chat_evidence_id");

ALTER TABLE "memory_chat_assertion_captures"
    ADD CONSTRAINT "memory_chat_assertion_captures_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_chat_assertion_captures"
    ADD CONSTRAINT "memory_chat_assertion_captures_queued_by_actor_id_fkey"
    FOREIGN KEY ("queued_by_actor_id") REFERENCES "memory_actors"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "memory_assertions"
    ADD CONSTRAINT "memory_assertions_chat_capture_id_fkey"
    FOREIGN KEY ("chat_capture_id") REFERENCES "memory_chat_assertion_captures"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_assertion_chat_evidence_links"
    ADD CONSTRAINT "memory_assertion_chat_evidence_links_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_assertion_chat_evidence_links"
    ADD CONSTRAINT "memory_assertion_chat_evidence_links_chat_evidence_id_fkey"
    FOREIGN KEY ("chat_evidence_id") REFERENCES "memory_chat_evidence"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "memory_assertions"
    ADD CONSTRAINT "memory_assertions_exactly_one_source_check"
    CHECK (num_nonnulls("source_region_id", "chat_capture_id") = 1);
ALTER TABLE "memory_assertions"
    ADD CONSTRAINT "memory_assertions_chat_must_be_grounded_check"
    CHECK ("chat_capture_id" IS NULL OR "kind" = 'grounded');
