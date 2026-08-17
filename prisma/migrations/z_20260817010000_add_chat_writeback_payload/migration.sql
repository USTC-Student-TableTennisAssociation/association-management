ALTER TABLE "memory_chat_assertion_receipts"
    ADD COLUMN "conversation_id" UUID,
    ADD COLUMN "timezone" TEXT,
    ADD COLUMN "semantic_context" JSONB,
    ADD COLUMN "retrieval" JSONB;

CREATE INDEX "memory_chat_assertion_receipts_conversation_id_submitted_at_idx"
    ON "memory_chat_assertion_receipts"("conversation_id", "submitted_at");

ALTER TABLE "memory_chat_assertion_receipts"
    ADD CONSTRAINT "memory_chat_assertion_receipts_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
