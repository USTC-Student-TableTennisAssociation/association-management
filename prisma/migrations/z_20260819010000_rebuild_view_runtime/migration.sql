-- Echo View Runtime v1 is intentionally destructive. No legacy Semantic View data is migrated.
DROP TABLE IF EXISTS "semantic_slot_binding_supports" CASCADE;
DROP TABLE IF EXISTS "semantic_content_dimension_supports" CASCADE;
DROP TABLE IF EXISTS "semantic_slot_bindings" CASCADE;
DROP TABLE IF EXISTS "semantic_content_dimensions" CASCADE;
DROP TABLE IF EXISTS "semantic_card_proposals" CASCADE;
DROP TABLE IF EXISTS "semantic_cards" CASCADE;
DROP TABLE IF EXISTS "semantic_view_higher_memories" CASCADE;

CREATE TYPE "ProposalStatus_new" AS ENUM (
  'pending',
  'approved',
  'rejected',
  'applied',
  'failed'
);

ALTER TABLE "memory_object_change_proposals"
  ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "memory_object_change_proposals"
  ALTER COLUMN "status" TYPE "ProposalStatus_new"
  USING ("status"::text::"ProposalStatus_new");
DROP TYPE "SemanticCardProposalStatus";
ALTER TYPE "ProposalStatus_new" RENAME TO "ProposalStatus";
ALTER TABLE "memory_object_change_proposals"
  ALTER COLUMN "status" SET DEFAULT 'pending';

CREATE TYPE "InstalledViewStatus" AS ENUM (
  'enabled',
  'disabled',
  'incompatible'
);

CREATE TYPE "ViewCommandInitiator" AS ENUM (
  'human',
  'ai',
  'system'
);

CREATE TABLE "installed_views" (
  "view_key" TEXT PRIMARY KEY,
  "module_id" TEXT NOT NULL,
  "module_version" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL,
  "state_version" BIGINT NOT NULL DEFAULT 0,
  "status" "InstalledViewStatus" NOT NULL DEFAULT 'enabled',
  "settings_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL
);

CREATE TABLE "view_cards" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "view_key" TEXT NOT NULL,
  "card_type_key" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "view_cards_view_key_fkey"
    FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "view_cards_view_key_card_type_key_idx"
  ON "view_cards"("view_key", "card_type_key");

CREATE TABLE "view_dimension_values" (
  "card_id" UUID NOT NULL,
  "dimension_key" TEXT NOT NULL,
  "value_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "view_dimension_values_pkey" PRIMARY KEY ("card_id", "dimension_key"),
  CONSTRAINT "view_dimension_values_card_id_fkey"
    FOREIGN KEY ("card_id") REFERENCES "view_cards"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "view_slot_bindings" (
  "source_card_id" UUID NOT NULL,
  "slot_key" TEXT NOT NULL,
  "target_card_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "view_slot_bindings_pkey"
    PRIMARY KEY ("source_card_id", "slot_key", "target_card_id"),
  CONSTRAINT "view_slot_bindings_source_card_id_fkey"
    FOREIGN KEY ("source_card_id") REFERENCES "view_cards"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "view_slot_bindings_target_card_id_fkey"
    FOREIGN KEY ("target_card_id") REFERENCES "view_cards"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "view_slot_bindings_target_card_id_idx"
  ON "view_slot_bindings"("target_card_id");

CREATE OR REPLACE FUNCTION "enforce_view_local_slot"()
RETURNS TRIGGER AS $$
DECLARE
  source_view TEXT;
  target_view TEXT;
BEGIN
  SELECT "view_key" INTO source_view FROM "view_cards" WHERE "id" = NEW."source_card_id";
  SELECT "view_key" INTO target_view FROM "view_cards" WHERE "id" = NEW."target_card_id";
  IF source_view IS NULL OR target_view IS NULL OR source_view <> target_view THEN
    RAISE EXCEPTION 'ViewSlotBinding must remain inside one View';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "view_slot_bindings_same_view"
BEFORE INSERT OR UPDATE ON "view_slot_bindings"
FOR EACH ROW EXECUTE FUNCTION "enforce_view_local_slot"();

CREATE TABLE "view_card_related_objects" (
  "card_id" UUID NOT NULL,
  "object_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "view_card_related_objects_pkey" PRIMARY KEY ("card_id", "object_id"),
  CONSTRAINT "view_card_related_objects_card_id_fkey"
    FOREIGN KEY ("card_id") REFERENCES "view_cards"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "view_card_related_objects_object_id_fkey"
    FOREIGN KEY ("object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "view_card_related_objects_object_id_idx"
  ON "view_card_related_objects"("object_id");

CREATE TABLE "view_command_proposals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "view_key" TEXT NOT NULL,
  "command_key" TEXT NOT NULL,
  "command_version" TEXT NOT NULL,
  "input_json" JSONB NOT NULL,
  "expected_state_version" BIGINT NOT NULL,
  "proposed_by_actor_id" UUID,
  "skill_id" TEXT,
  "status" "ProposalStatus" NOT NULL DEFAULT 'pending',
  "failure_reason" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMPTZ(3),
  "applied_at" TIMESTAMPTZ(3),
  CONSTRAINT "view_command_proposals_view_key_fkey"
    FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "view_command_proposals_view_key_status_created_at_idx"
  ON "view_command_proposals"("view_key", "status", "created_at");

CREATE TABLE "view_command_executions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "view_key" TEXT NOT NULL,
  "command_key" TEXT NOT NULL,
  "command_version" TEXT NOT NULL,
  "input_json" JSONB NOT NULL,
  "actor_id" UUID,
  "initiator" "ViewCommandInitiator" NOT NULL,
  "skill_id" TEXT,
  "state_version_before" BIGINT NOT NULL,
  "state_version_after" BIGINT NOT NULL,
  "result_summary_json" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "view_command_executions_view_key_fkey"
    FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "view_command_executions_view_key_created_at_idx"
  ON "view_command_executions"("view_key", "created_at");

CREATE TABLE "domain_event_outbox" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_type" TEXT NOT NULL,
  "event_version" TEXT NOT NULL,
  "view_key" TEXT NOT NULL,
  "state_version" BIGINT NOT NULL,
  "payload_json" JSONB NOT NULL,
  "metadata_json" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMPTZ(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "domain_event_outbox_view_key_fkey"
    FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "domain_event_outbox_published_at_occurred_at_idx"
  ON "domain_event_outbox"("published_at", "occurred_at");
CREATE INDEX "domain_event_outbox_view_key_state_version_idx"
  ON "domain_event_outbox"("view_key", "state_version");

CREATE TABLE "view_higher_memories" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "view_key" TEXT NOT NULL UNIQUE,
  "content_markdown" TEXT NOT NULL,
  "maintained_at" TIMESTAMPTZ(3) NOT NULL,
  "maintenance_reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "view_higher_memories_view_key_fkey"
    FOREIGN KEY ("view_key") REFERENCES "installed_views"("view_key")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "view_higher_memories_maintained_at_idx"
  ON "view_higher_memories"("maintained_at");
