BEGIN;

-- 旧列没有时区信息；现有数据无需保留精确的本地时区语义，统一按 UTC 墙钟值转换。
ALTER TABLE "guidelines"
  ALTER COLUMN "created_at" DROP DEFAULT;

ALTER TABLE "guidelines"
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3)
    USING ("created_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(3)
    USING ("updated_at" AT TIME ZONE 'UTC');

ALTER TABLE "guidelines"
  ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "guideline_links"
  ALTER COLUMN "created_at" DROP DEFAULT;

ALTER TABLE "guideline_links"
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3)
    USING ("created_at" AT TIME ZONE 'UTC');

ALTER TABLE "guideline_links"
  ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

COMMIT;
