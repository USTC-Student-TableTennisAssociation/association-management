-- Durable chat ordering is owned by the server. Repair the one legacy shape
-- that could contain duplicate positions before enforcing uniqueness.
ALTER TABLE "chat_conversations"
ADD COLUMN "next_message_position" INTEGER NOT NULL DEFAULT 0;

WITH duplicate_start AS (
  SELECT "conversation_id", MIN("position") AS "position"
  FROM (
    SELECT "conversation_id", "position"
    FROM "chat_messages"
    GROUP BY "conversation_id", "position"
    HAVING COUNT(*) > 1
  ) duplicated
  GROUP BY "conversation_id"
), repaired_order AS (
  SELECT
    message."id",
    ROW_NUMBER() OVER (
      PARTITION BY message."conversation_id"
      ORDER BY
        CASE WHEN message."position" < duplicate_start."position" THEN 0 ELSE 1 END,
        CASE WHEN message."position" < duplicate_start."position" THEN message."position" END,
        CASE WHEN message."position" < duplicate_start."position" THEN message."created_at" END,
        CASE WHEN message."position" >= duplicate_start."position" THEN message."created_at" END,
        message."id"
    ) - 1 AS "new_position"
  FROM "chat_messages" message
  INNER JOIN duplicate_start
    ON duplicate_start."conversation_id" = message."conversation_id"
)
UPDATE "chat_messages" message
SET "position" = repaired_order."new_position"
FROM repaired_order
WHERE repaired_order."id" = message."id";

UPDATE "chat_conversations" conversation
SET "next_message_position" = COALESCE((
  SELECT MAX(message."position") + 1
  FROM "chat_messages" message
  WHERE message."conversation_id" = conversation."id"
), 0);

CREATE UNIQUE INDEX "chat_messages_conversation_id_position_key"
ON "chat_messages"("conversation_id", "position");
