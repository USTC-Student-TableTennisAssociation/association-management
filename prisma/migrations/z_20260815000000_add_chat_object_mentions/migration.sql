-- 对话中新建的 GlobalObject 只在成功 Assertion 的同一事务内获得名称来源。
CREATE TABLE "memory_chat_object_mentions" (
    "global_object_id" UUID NOT NULL,
    "chat_evidence_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "surface_form" TEXT NOT NULL,
    "normalized_surface_form" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_chat_object_mentions_pkey"
        PRIMARY KEY ("global_object_id", "chat_evidence_id", "ordinal")
);

CREATE UNIQUE INDEX "memory_chat_object_mentions_chat_evidence_id_ordinal_key"
    ON "memory_chat_object_mentions"("chat_evidence_id", "ordinal");

CREATE UNIQUE INDEX "memory_chat_object_mentions_global_object_id_chat_evidence_id_surface_form_key"
    ON "memory_chat_object_mentions"("global_object_id", "chat_evidence_id", "surface_form");

CREATE INDEX "memory_chat_object_mentions_global_object_id_idx"
    ON "memory_chat_object_mentions"("global_object_id");

CREATE INDEX "memory_chat_object_mentions_chat_evidence_id_idx"
    ON "memory_chat_object_mentions"("chat_evidence_id");

CREATE INDEX "memory_chat_object_mentions_normalized_surface_form_idx"
    ON "memory_chat_object_mentions"("normalized_surface_form");

ALTER TABLE "memory_chat_object_mentions"
    ADD CONSTRAINT "memory_chat_object_mentions_global_object_id_fkey"
    FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_chat_object_mentions"
    ADD CONSTRAINT "memory_chat_object_mentions_chat_evidence_id_fkey"
    FOREIGN KEY ("chat_evidence_id") REFERENCES "memory_chat_evidence"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
