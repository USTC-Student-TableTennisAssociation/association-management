CREATE TYPE "MemoryAmbientHigherMemoryScope" AS ENUM ('workspace', 'recent');

CREATE TABLE "memory_ambient_higher_memories" (
    "id" UUID NOT NULL,
    "scope" "MemoryAmbientHigherMemoryScope" NOT NULL,
    "content_markdown" TEXT NOT NULL,
    "maintained_at" TIMESTAMPTZ(3) NOT NULL,
    "trigger_message_id" TEXT NOT NULL,
    "maintenance_reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "memory_ambient_higher_memories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_ambient_higher_memories_scope_key"
    ON "memory_ambient_higher_memories"("scope");
CREATE INDEX "memory_ambient_higher_memories_maintained_at_idx"
    ON "memory_ambient_higher_memories"("maintained_at");
