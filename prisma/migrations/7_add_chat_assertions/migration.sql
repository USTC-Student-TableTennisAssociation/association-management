CREATE TABLE "memory_actors" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "memory_actors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_chat_evidence" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "client_message_id" TEXT NOT NULL,
    "submitted_by_actor_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "raw_user_message" TEXT NOT NULL,
    "interpretation_context" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_chat_evidence_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "memory_assertions"
    ALTER COLUMN "source_region_id" DROP NOT NULL,
    ADD COLUMN "chat_evidence_id" UUID;

CREATE UNIQUE INDEX "memory_chat_evidence_submitted_by_actor_id_client_message_id_key"
    ON "memory_chat_evidence"("submitted_by_actor_id", "client_message_id");
CREATE INDEX "memory_chat_evidence_compilation_id_submitted_at_idx"
    ON "memory_chat_evidence"("compilation_id", "submitted_at");
CREATE UNIQUE INDEX "memory_assertions_chat_evidence_id_source_claim_id_key"
    ON "memory_assertions"("chat_evidence_id", "source_claim_id");
CREATE INDEX "memory_assertions_chat_evidence_id_idx"
    ON "memory_assertions"("chat_evidence_id");

ALTER TABLE "memory_chat_evidence"
    ADD CONSTRAINT "memory_chat_evidence_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_chat_evidence"
    ADD CONSTRAINT "memory_chat_evidence_submitted_by_actor_id_fkey"
    FOREIGN KEY ("submitted_by_actor_id") REFERENCES "memory_actors"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "memory_assertions"
    ADD CONSTRAINT "memory_assertions_chat_evidence_id_fkey"
    FOREIGN KEY ("chat_evidence_id") REFERENCES "memory_chat_evidence"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_assertions"
    ADD CONSTRAINT "memory_assertions_exactly_one_source_check"
    CHECK (num_nonnulls("source_region_id", "chat_evidence_id") = 1);
ALTER TABLE "memory_assertions"
    ADD CONSTRAINT "memory_assertions_chat_must_be_grounded_check"
    CHECK ("chat_evidence_id" IS NULL OR "kind" = 'grounded');
