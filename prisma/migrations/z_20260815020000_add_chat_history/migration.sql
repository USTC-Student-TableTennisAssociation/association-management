CREATE TYPE "ChatMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

CREATE TABLE "chat_conversations" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "client_message_id" TEXT NOT NULL,
    "role" "ChatMessageRole" NOT NULL,
    "parts" JSONB NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_conversations_actor_id_key"
ON "chat_conversations"("actor_id");

CREATE UNIQUE INDEX "chat_messages_conversation_id_client_message_id_key"
ON "chat_messages"("conversation_id", "client_message_id");

CREATE INDEX "chat_messages_conversation_id_position_created_at_idx"
ON "chat_messages"("conversation_id", "position", "created_at");

ALTER TABLE "chat_conversations"
ADD CONSTRAINT "chat_conversations_actor_id_fkey"
FOREIGN KEY ("actor_id") REFERENCES "memory_actors"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_messages"
ADD CONSTRAINT "chat_messages_conversation_id_fkey"
FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
