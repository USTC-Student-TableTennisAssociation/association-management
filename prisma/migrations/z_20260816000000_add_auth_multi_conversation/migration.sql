CREATE TYPE "AuthUserRole" AS ENUM ('ADMIN', 'MEMBER');
CREATE TYPE "AuthUserStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE "auth_users" (
    "id" UUID NOT NULL,
    "login_name" TEXT NOT NULL,
    "normalized_login_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "AuthUserRole" NOT NULL DEFAULT 'MEMBER',
    "status" "AuthUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "actor_id" UUID NOT NULL,
    "person_object_id" UUID,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

DROP INDEX "chat_conversations_actor_id_key";

ALTER TABLE "chat_conversations"
    ADD COLUMN "title" TEXT NOT NULL DEFAULT '旧对话',
    ADD COLUMN "archived_at" TIMESTAMPTZ(3),
    ADD COLUMN "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "chat_conversations"
SET "last_message_at" = "updated_at";

ALTER TABLE "memory_chat_evidence"
    ADD COLUMN "conversation_id" UUID;

UPDATE "memory_chat_evidence" AS evidence
SET "conversation_id" = conversation."id"
FROM "chat_conversations" AS conversation
WHERE conversation."actor_id" = evidence."submitted_by_actor_id";

CREATE UNIQUE INDEX "auth_users_normalized_login_name_key"
    ON "auth_users"("normalized_login_name");
CREATE UNIQUE INDEX "auth_users_actor_id_key"
    ON "auth_users"("actor_id");
CREATE UNIQUE INDEX "auth_users_person_object_id_key"
    ON "auth_users"("person_object_id");
CREATE UNIQUE INDEX "auth_sessions_token_hash_key"
    ON "auth_sessions"("token_hash");
CREATE INDEX "auth_sessions_user_id_expires_at_idx"
    ON "auth_sessions"("user_id", "expires_at");
CREATE INDEX "auth_sessions_expires_at_idx"
    ON "auth_sessions"("expires_at");
CREATE INDEX "chat_conversations_actor_id_archived_at_last_message_at_idx"
    ON "chat_conversations"("actor_id", "archived_at", "last_message_at");
CREATE INDEX "memory_chat_evidence_conversation_id_submitted_at_idx"
    ON "memory_chat_evidence"("conversation_id", "submitted_at");

ALTER TABLE "auth_users"
    ADD CONSTRAINT "auth_users_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "memory_actors"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "auth_users"
    ADD CONSTRAINT "auth_users_person_object_id_fkey"
    FOREIGN KEY ("person_object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "auth_sessions"
    ADD CONSTRAINT "auth_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "auth_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_chat_evidence"
    ADD CONSTRAINT "memory_chat_evidence_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
