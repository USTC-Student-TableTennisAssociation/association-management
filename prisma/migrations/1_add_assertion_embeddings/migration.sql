CREATE EXTENSION IF NOT EXISTS "vector";

ALTER TABLE "memory_compilations"
    ADD COLUMN "embedding_model_key" TEXT,
    ADD COLUMN "embedding_model_revision" TEXT,
    ADD COLUMN "embedding_dimension" INTEGER;

-- 已有来源编译必须重新运行 importer 才可检索；占位值只用于安全完成 schema 升级。
UPDATE "memory_compilations"
SET "embedding_model_key" = 'unindexed',
    "embedding_model_revision" = 'unindexed',
    "embedding_dimension" = 0
WHERE "embedding_model_key" IS NULL;

ALTER TABLE "memory_compilations"
    ALTER COLUMN "embedding_model_key" SET NOT NULL,
    ALTER COLUMN "embedding_model_revision" SET NOT NULL,
    ALTER COLUMN "embedding_dimension" SET NOT NULL;

CREATE TABLE "memory_assertion_embeddings" (
    "assertion_id" UUID NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_assertion_embeddings_pkey" PRIMARY KEY ("assertion_id")
);

ALTER TABLE "memory_assertion_embeddings"
    ADD CONSTRAINT "memory_assertion_embeddings_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
