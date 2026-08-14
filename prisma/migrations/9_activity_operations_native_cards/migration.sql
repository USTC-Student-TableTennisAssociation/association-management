-- Activity Operations creates runtime business identities in the Card system itself.
-- A source-backed Card still keeps both source columns; a native Card keeps neither.
ALTER TABLE "semantic_cards"
    ALTER COLUMN "compilation_id" DROP NOT NULL,
    ALTER COLUMN "source_object_id" DROP NOT NULL;

ALTER TABLE "semantic_cards"
    ADD CONSTRAINT "semantic_cards_source_identity_pair_check"
    CHECK (
        ("compilation_id" IS NULL AND "source_object_id" IS NULL)
        OR
        ("compilation_id" IS NOT NULL AND "source_object_id" IS NOT NULL)
    );

-- Most SlotBindings remain internal to one Business View. The one explicit
-- cross-view contract is Activity Operations Assignment.assignee ->
-- Society Information PersonCard, so operational assignments reuse the same
-- person identity instead of copying Person Cards into another View.
CREATE OR REPLACE FUNCTION enforce_semantic_slot_binding_view_isolation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    source_view_key TEXT;
    target_view_key TEXT;
    source_card_type_key TEXT;
    target_card_type_key TEXT;
    source_compilation_id UUID;
    target_compilation_id UUID;
BEGIN
    SELECT "view_key", "card_type_key", "compilation_id"
      INTO source_view_key, source_card_type_key, source_compilation_id
      FROM "semantic_cards"
     WHERE "id" = NEW."source_card_id";

    SELECT "view_key", "card_type_key", "compilation_id"
      INTO target_view_key, target_card_type_key, target_compilation_id
      FROM "semantic_cards"
     WHERE "id" = NEW."target_card_id";

    IF source_view_key IS DISTINCT FROM target_view_key THEN
        IF NOT (
            source_view_key = 'activity_operations'
            AND source_card_type_key = 'AssignmentCard'
            AND NEW."slot_key" = 'assignee'
            AND target_view_key = 'society_information'
            AND target_card_type_key = 'PersonCard'
        ) THEN
            RAISE EXCEPTION
                'cross Business View SlotBinding is forbidden: % (%) -> % (%)',
                NEW."source_card_id", source_view_key,
                NEW."target_card_id", target_view_key;
        END IF;
    ELSIF source_compilation_id IS NOT NULL
       AND target_compilation_id IS NOT NULL
       AND source_compilation_id IS DISTINCT FROM target_compilation_id THEN
        RAISE EXCEPTION
            'cross Compilation SlotBinding is forbidden: % (%) -> % (%)',
            NEW."source_card_id", source_compilation_id,
            NEW."target_card_id", target_compilation_id;
    END IF;

    RETURN NEW;
END;
$$;

-- The exception now depends on slot_key, so updates to the key itself must
-- also pass through the database backstop.
DROP TRIGGER "semantic_slot_bindings_view_isolation"
ON "semantic_slot_bindings";

CREATE TRIGGER "semantic_slot_bindings_view_isolation"
BEFORE INSERT OR UPDATE OF "source_card_id", "slot_key", "target_card_id"
ON "semantic_slot_bindings"
FOR EACH ROW
EXECUTE FUNCTION enforce_semantic_slot_binding_view_isolation();
