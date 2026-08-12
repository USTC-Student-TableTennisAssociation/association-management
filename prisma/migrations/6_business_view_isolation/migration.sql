-- Promote the walking-skeleton key to the first formal Business View.
UPDATE "semantic_cards"
SET "view_key" = 'society_information'
WHERE "view_key" = 'society_overview';

UPDATE "semantic_card_proposals"
SET
    "view_key" = 'society_information',
    "payload" = jsonb_set("payload", '{viewKey}', '"society_information"'::jsonb)
WHERE "view_key" = 'society_overview'
   OR "payload"->>'viewKey' = 'society_overview';

-- SlotBinding is always internal to one Business View and one Compilation.
-- The application validates this before apply; the trigger is the database backstop
-- for every direct or future write path.
CREATE OR REPLACE FUNCTION enforce_semantic_slot_binding_view_isolation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    source_view_key TEXT;
    target_view_key TEXT;
    source_compilation_id UUID;
    target_compilation_id UUID;
BEGIN
    SELECT "view_key", "compilation_id"
      INTO source_view_key, source_compilation_id
      FROM "semantic_cards"
     WHERE "id" = NEW."source_card_id";

    SELECT "view_key", "compilation_id"
      INTO target_view_key, target_compilation_id
      FROM "semantic_cards"
     WHERE "id" = NEW."target_card_id";

    IF source_view_key IS DISTINCT FROM target_view_key THEN
        RAISE EXCEPTION
            'cross Business View SlotBinding is forbidden: % (%) -> % (%)',
            NEW."source_card_id", source_view_key,
            NEW."target_card_id", target_view_key;
    END IF;

    IF source_compilation_id IS DISTINCT FROM target_compilation_id THEN
        RAISE EXCEPTION
            'cross Compilation SlotBinding is forbidden: % (%) -> % (%)',
            NEW."source_card_id", source_compilation_id,
            NEW."target_card_id", target_compilation_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "semantic_slot_bindings_view_isolation"
BEFORE INSERT OR UPDATE OF "source_card_id", "target_card_id"
ON "semantic_slot_bindings"
FOR EACH ROW
EXECUTE FUNCTION enforce_semantic_slot_binding_view_isolation();
