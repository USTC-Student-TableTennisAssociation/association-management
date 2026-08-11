-- 早期开发数据库曾应用过只新增 Fragment IR、但保留 legacy Object/Mention 的迁移版本。
-- 不修改已应用 migration；用前向迁移把实际数据库收敛到当前基础 schema。
DROP TABLE IF EXISTS "memory_object_mentions";
DROP TABLE IF EXISTS "memory_objects";

ALTER TABLE "memory_compilations"
    DROP COLUMN IF EXISTS "object_count",
    DROP COLUMN IF EXISTS "object_mention_count",
    ALTER COLUMN "object_fragment_count" DROP DEFAULT,
    ALTER COLUMN "surface_form_count" DROP DEFAULT,
    ALTER COLUMN "fragment_reference_count" DROP DEFAULT;

ALTER TABLE "memory_assertions"
    ALTER COLUMN "context_dependent" DROP DEFAULT;

-- PostgreSQL 会把旧 migration 中超过 63 字节的显式名称截断；改成 Prisma 当前期望的名称。
ALTER INDEX IF EXISTS "memory_source_object_fragments_source_region_id_source_fragment"
    RENAME TO "memory_source_object_fragments_source_region_id_source_frag_key";
ALTER INDEX IF EXISTS "memory_global_assertion_literal_references_assertion_literal_ke"
    RENAME TO "memory_global_assertion_literal_references_assertion_id_lit_key";
ALTER INDEX IF EXISTS "memory_global_assertion_literal_references_assertion_global_idx"
    RENAME TO "memory_global_assertion_literal_references_assertion_id_glo_idx";
ALTER INDEX IF EXISTS "memory_global_assertion_literal_references_global_object_idx"
    RENAME TO "memory_global_assertion_literal_references_global_object_id_idx";

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'memory_global_assertion_literal_references_global_object_id_fke'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'memory_global_assertion_literal_references_global_object_i_fkey'
    ) THEN
        ALTER TABLE "memory_global_assertion_literal_references"
            RENAME CONSTRAINT "memory_global_assertion_literal_references_global_object_id_fke"
            TO "memory_global_assertion_literal_references_global_object_i_fkey";
    END IF;
END $$;
