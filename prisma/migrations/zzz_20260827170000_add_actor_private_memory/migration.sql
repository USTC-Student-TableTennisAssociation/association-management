CREATE TYPE "MemoryActorHigherMemoryScope" AS ENUM (
    'interaction',
    'working_style',
    'working_set'
);

CREATE TABLE "memory_actor_preferences" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value_text" TEXT NOT NULL,
    "source_message_id" TEXT NOT NULL,
    "source_quote" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "memory_actor_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_actor_higher_memories" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "scope" "MemoryActorHigherMemoryScope" NOT NULL,
    "content_markdown" TEXT NOT NULL,
    "maintained_at" TIMESTAMPTZ(3) NOT NULL,
    "trigger_message_id" TEXT NOT NULL,
    "maintenance_reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "memory_actor_higher_memories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_actor_preferences_actor_id_key_key"
    ON "memory_actor_preferences"("actor_id", "key");
CREATE INDEX "memory_actor_preferences_actor_id_updated_at_idx"
    ON "memory_actor_preferences"("actor_id", "updated_at");
CREATE UNIQUE INDEX "memory_actor_higher_memories_actor_id_scope_key"
    ON "memory_actor_higher_memories"("actor_id", "scope");
CREATE INDEX "memory_actor_higher_memories_actor_id_maintained_at_idx"
    ON "memory_actor_higher_memories"("actor_id", "maintained_at");

ALTER TABLE "memory_actor_preferences"
    ADD CONSTRAINT "memory_actor_preferences_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "memory_actors"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_actor_higher_memories"
    ADD CONSTRAINT "memory_actor_higher_memories_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "memory_actors"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
