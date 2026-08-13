CREATE TYPE "SemanticCardProposalStatus" AS ENUM (
    'pending', 'approved', 'rejected', 'applied', 'failed'
);

CREATE TABLE "semantic_cards" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "source_object_id" UUID NOT NULL,
    "view_key" TEXT NOT NULL,
    "card_type_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "semantic_cards_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "semantic_content_dimensions" (
    "id" UUID NOT NULL,
    "card_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content_markdown" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "semantic_content_dimensions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "semantic_content_dimension_supports" (
    "content_dimension_id" UUID NOT NULL,
    "assertion_id" UUID NOT NULL,
    CONSTRAINT "semantic_content_dimension_supports_pkey"
        PRIMARY KEY ("content_dimension_id", "assertion_id")
);

CREATE TABLE "semantic_slot_bindings" (
    "source_card_id" UUID NOT NULL,
    "slot_key" TEXT NOT NULL,
    "target_card_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "semantic_slot_bindings_pkey"
        PRIMARY KEY ("source_card_id", "slot_key", "target_card_id")
);

CREATE TABLE "semantic_slot_binding_supports" (
    "source_card_id" UUID NOT NULL,
    "slot_key" TEXT NOT NULL,
    "target_card_id" UUID NOT NULL,
    "assertion_id" UUID NOT NULL,
    CONSTRAINT "semantic_slot_binding_supports_pkey"
        PRIMARY KEY ("source_card_id", "slot_key", "target_card_id", "assertion_id")
);

CREATE TABLE "semantic_card_proposals" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "view_key" TEXT NOT NULL,
    "status" "SemanticCardProposalStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "applied_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,
    CONSTRAINT "semantic_card_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "semantic_cards_view_key_card_type_key_idx"
    ON "semantic_cards"("view_key", "card_type_key");
CREATE INDEX "semantic_cards_source_object_id_idx"
    ON "semantic_cards"("source_object_id");
CREATE UNIQUE INDEX "semantic_content_dimensions_card_id_name_key"
    ON "semantic_content_dimensions"("card_id", "name");
CREATE INDEX "semantic_content_dimension_supports_assertion_id_idx"
    ON "semantic_content_dimension_supports"("assertion_id");
CREATE INDEX "semantic_slot_bindings_target_card_id_idx"
    ON "semantic_slot_bindings"("target_card_id");
CREATE INDEX "semantic_slot_binding_supports_assertion_id_idx"
    ON "semantic_slot_binding_supports"("assertion_id");
CREATE INDEX "semantic_card_proposals_view_key_status_created_at_idx"
    ON "semantic_card_proposals"("view_key", "status", "created_at");

ALTER TABLE "semantic_cards"
    ADD CONSTRAINT "semantic_cards_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "semantic_cards"
    ADD CONSTRAINT "semantic_cards_source_object_id_fkey"
    FOREIGN KEY ("source_object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "semantic_content_dimensions"
    ADD CONSTRAINT "semantic_content_dimensions_card_id_fkey"
    FOREIGN KEY ("card_id") REFERENCES "semantic_cards"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "semantic_content_dimension_supports"
    ADD CONSTRAINT "semantic_content_dimension_supports_dimension_id_fkey"
    FOREIGN KEY ("content_dimension_id") REFERENCES "semantic_content_dimensions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "semantic_content_dimension_supports"
    ADD CONSTRAINT "semantic_content_dimension_supports_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "semantic_slot_bindings"
    ADD CONSTRAINT "semantic_slot_bindings_source_card_id_fkey"
    FOREIGN KEY ("source_card_id") REFERENCES "semantic_cards"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "semantic_slot_bindings"
    ADD CONSTRAINT "semantic_slot_bindings_target_card_id_fkey"
    FOREIGN KEY ("target_card_id") REFERENCES "semantic_cards"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "semantic_slot_binding_supports"
    ADD CONSTRAINT "semantic_slot_binding_supports_binding_fkey"
    FOREIGN KEY ("source_card_id", "slot_key", "target_card_id")
    REFERENCES "semantic_slot_bindings"("source_card_id", "slot_key", "target_card_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "semantic_slot_binding_supports"
    ADD CONSTRAINT "semantic_slot_binding_supports_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "semantic_card_proposals"
    ADD CONSTRAINT "semantic_card_proposals_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
