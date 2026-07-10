-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "GuidelineKind" AS ENUM ('workflow', 'rule', 'checklist', 'experience');

-- CreateEnum
CREATE TYPE "GuidelineStatus" AS ENUM ('draft', 'published');

-- CreateEnum
CREATE TYPE "GuidelineRelationType" AS ENUM ('contains', 'triggers', 'requires', 'next', 'exception');

-- CreateTable
CREATE TABLE "guidelines" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "GuidelineKind" NOT NULL,
    "content_markdown" TEXT NOT NULL DEFAULT '',
    "is_mandatory" BOOLEAN NOT NULL DEFAULT false,
    "applies_when_jsonb" JSONB,
    "suggested_actions_jsonb" JSONB NOT NULL DEFAULT '[]',
    "basis_note" TEXT,
    "status" "GuidelineStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guidelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guideline_links" (
    "from_guideline_id" UUID NOT NULL,
    "to_guideline_id" UUID NOT NULL,
    "relation_type" "GuidelineRelationType" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guideline_links_pkey" PRIMARY KEY ("from_guideline_id","to_guideline_id","relation_type")
);

-- CreateIndex
CREATE INDEX "guidelines_status_idx" ON "guidelines"("status");

-- CreateIndex
CREATE INDEX "guidelines_kind_idx" ON "guidelines"("kind");

-- CreateIndex
CREATE INDEX "guideline_links_to_guideline_id_relation_type_idx" ON "guideline_links"("to_guideline_id", "relation_type");

-- AddForeignKey
ALTER TABLE "guideline_links" ADD CONSTRAINT "guideline_links_from_guideline_id_fkey" FOREIGN KEY ("from_guideline_id") REFERENCES "guidelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guideline_links" ADD CONSTRAINT "guideline_links_to_guideline_id_fkey" FOREIGN KEY ("to_guideline_id") REFERENCES "guidelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
