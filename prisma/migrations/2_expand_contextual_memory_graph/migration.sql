-- 扩展长期记忆节点类型。
ALTER TYPE "MemoryNodeKind" ADD VALUE 'person';
ALTER TYPE "MemoryNodeKind" ADD VALUE 'role';
ALTER TYPE "MemoryNodeKind" ADD VALUE 'historical_event';
ALTER TYPE "MemoryNodeKind" ADD VALUE 'archive_record';

-- 删除尚未形成稳定语义的旧关系，并增加上下文、历史与人物关系。
-- 当前记忆层仍处于冷启动阶段，不为旧关系保留兼容模型。
DELETE FROM "memory_edges"
WHERE "relation_type"::text IN ('supports', 'reveals_risk', 'challenges');

ALTER TYPE "MemoryRelationType" RENAME TO "MemoryRelationType_old";

CREATE TYPE "MemoryRelationType" AS ENUM (
    'routes_to',
    'has_trait',
    'uses',
    'contains',
    'next',
    'requires',
    'exception_to',
    'applies_to',
    'relevant_at',
    'informs',
    'constrains',
    'deviates_from',
    'establishes',
    'changes',
    'held_role',
    'responsible_for',
    'participated_in',
    'authored'
);

ALTER TABLE "memory_edges"
    ALTER COLUMN "relation_type" TYPE "MemoryRelationType"
    USING ("relation_type"::text::"MemoryRelationType");

DROP TYPE "MemoryRelationType_old";

-- 新节点类型的一对一语义扩展。
CREATE TABLE "memory_people" (
    "node_id" UUID NOT NULL,
    "identity_markdown" TEXT NOT NULL,
    "disambiguation_markdown" TEXT,

    CONSTRAINT "memory_people_pkey" PRIMARY KEY ("node_id")
);

CREATE TABLE "memory_roles" (
    "node_id" UUID NOT NULL,
    "definition_markdown" TEXT NOT NULL,
    "boundary_markdown" TEXT,
    "uncertainty_markdown" TEXT,

    CONSTRAINT "memory_roles_pkey" PRIMARY KEY ("node_id")
);

CREATE TABLE "memory_historical_events" (
    "node_id" UUID NOT NULL,
    "event_markdown" TEXT NOT NULL,
    "time_markdown" TEXT,
    "background_markdown" TEXT,
    "outcome_markdown" TEXT,
    "significance_markdown" TEXT,
    "uncertainty_markdown" TEXT,

    CONSTRAINT "memory_historical_events_pkey" PRIMARY KEY ("node_id")
);

CREATE TABLE "memory_archive_records" (
    "node_id" UUID NOT NULL,
    "content_overview_markdown" TEXT NOT NULL,
    "provenance_markdown" TEXT,
    "integrity_markdown" TEXT,

    CONSTRAINT "memory_archive_records_pkey" PRIMARY KEY ("node_id")
);

-- 一条边可限定在某个活动、活动特征或工作流中，也可记录任职等关系的时间范围。
ALTER TABLE "memory_edges"
    ADD COLUMN "context_node_id" UUID,
    ADD COLUMN "temporal_scope_markdown" TEXT;

DROP INDEX "memory_edges_from_node_id_to_node_id_relation_type_key";

CREATE UNIQUE INDEX "memory_edges_relation_context_key"
    ON "memory_edges"("from_node_id", "to_node_id", "relation_type", "context_node_id");

-- PostgreSQL 默认认为 NULL 彼此不同；此索引避免无上下文的同一关系被重复写入。
CREATE UNIQUE INDEX "memory_edges_contextless_relation_key"
    ON "memory_edges"("from_node_id", "to_node_id", "relation_type")
    WHERE "context_node_id" IS NULL;

CREATE INDEX "memory_edges_context_node_id_relation_type_status_idx"
    ON "memory_edges"("context_node_id", "relation_type", "status");

-- 为树状切分后的稳定原文块补充精确来源范围。
ALTER TABLE "memory_source_anchors"
    ADD COLUMN "start_block_id" TEXT,
    ADD COLUMN "end_block_id" TEXT;

CREATE INDEX "memory_source_anchors_block_range_idx"
    ON "memory_source_anchors"("source_asset_ref", "start_block_id", "end_block_id");

ALTER TABLE "memory_people"
    ADD CONSTRAINT "memory_people_node_id_fkey"
    FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_roles"
    ADD CONSTRAINT "memory_roles_node_id_fkey"
    FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_historical_events"
    ADD CONSTRAINT "memory_historical_events_node_id_fkey"
    FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_archive_records"
    ADD CONSTRAINT "memory_archive_records_node_id_fkey"
    FOREIGN KEY ("node_id") REFERENCES "memory_nodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_edges"
    ADD CONSTRAINT "memory_edges_context_node_id_fkey"
    FOREIGN KEY ("context_node_id") REFERENCES "memory_nodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
