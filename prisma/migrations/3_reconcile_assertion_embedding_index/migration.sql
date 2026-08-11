-- 旧 Search migration 曾把 embedding profile 写进基础 Compilation。
-- 将这些派生字段迁出基础表，使 cold-start importer 可以保持基础 schema 权威。
ALTER TABLE "memory_compilations"
    DROP COLUMN IF EXISTS "embedding_model_key",
    DROP COLUMN IF EXISTS "embedding_model_revision",
    DROP COLUMN IF EXISTS "embedding_dimension";

CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TABLE IF NOT EXISTS "memory_assertion_embeddings" (
    "assertion_id" UUID NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_assertion_embeddings_pkey" PRIMARY KEY ("assertion_id"),
    CONSTRAINT "memory_assertion_embeddings_assertion_id_fkey"
        FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "memory_assertion_embedding_indexes" (
    "compilation_id" UUID NOT NULL,
    "model_key" TEXT NOT NULL,
    "model_revision" TEXT NOT NULL,
    "dimension" INTEGER NOT NULL,
    "indexed_assertion_count" INTEGER NOT NULL,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_assertion_embedding_indexes_pkey" PRIMARY KEY ("compilation_id"),
    CONSTRAINT "memory_assertion_embedding_indexes_dimension_check" CHECK ("dimension" = 1024),
    CONSTRAINT "memory_assertion_embedding_indexes_count_check" CHECK ("indexed_assertion_count" >= 0),
    CONSTRAINT "memory_assertion_embedding_indexes_compilation_id_fkey"
        FOREIGN KEY ("compilation_id") REFERENCES "memory_compilations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);
