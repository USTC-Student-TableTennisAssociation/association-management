ALTER TABLE "memory_compilations"
    ADD COLUMN "source_time_text" TEXT,
    ADD COLUMN "source_time_supporting_block_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

DROP TABLE "memory_temporal_annotations";

DROP TYPE "MemoryTemporalKind";
DROP TYPE "MemoryTemporalPrecision";
DROP TYPE "MemoryTemporalDerivation";
