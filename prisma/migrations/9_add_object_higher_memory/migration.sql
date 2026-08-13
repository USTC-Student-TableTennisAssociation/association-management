CREATE TABLE "memory_object_higher_memories" (
    "id" UUID NOT NULL,
    "compilation_id" UUID NOT NULL,
    "global_object_id" UUID NOT NULL,
    "content_markdown" TEXT NOT NULL,
    "maintained_at" TIMESTAMPTZ(3) NOT NULL,
    "trigger_message_id" TEXT NOT NULL,
    "maintenance_reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "memory_object_higher_memories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_object_higher_memories_global_object_id_key"
    ON "memory_object_higher_memories"("global_object_id");
CREATE INDEX "memory_object_higher_memories_compilation_id_maintained_at_idx"
    ON "memory_object_higher_memories"("compilation_id", "maintained_at");

ALTER TABLE "memory_object_higher_memories"
    ADD CONSTRAINT "memory_object_higher_memories_compilation_id_fkey"
    FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_object_higher_memories"
    ADD CONSTRAINT "memory_object_higher_memories_global_object_id_fkey"
    FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
