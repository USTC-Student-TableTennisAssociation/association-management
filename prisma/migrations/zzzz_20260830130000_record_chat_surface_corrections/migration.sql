ALTER TABLE "memory_chat_assertion_captures"
  ADD COLUMN "applied_surface_corrections" JSONB NOT NULL DEFAULT '[]';
