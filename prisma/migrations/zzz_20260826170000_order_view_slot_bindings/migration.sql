ALTER TABLE "view_slot_bindings"
ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

WITH ranked_bindings AS (
  SELECT
    "source_card_id",
    "slot_key",
    "target_card_id",
    ROW_NUMBER() OVER (
      PARTITION BY "source_card_id", "slot_key"
      ORDER BY "created_at", "target_card_id"
    ) - 1 AS "next_position"
  FROM "view_slot_bindings"
)
UPDATE "view_slot_bindings" AS binding
SET "position" = ranked."next_position"
FROM ranked_bindings AS ranked
WHERE binding."source_card_id" = ranked."source_card_id"
  AND binding."slot_key" = ranked."slot_key"
  AND binding."target_card_id" = ranked."target_card_id";

CREATE INDEX "view_slot_bindings_source_card_id_slot_key_position_idx"
ON "view_slot_bindings"("source_card_id", "slot_key", "position");
