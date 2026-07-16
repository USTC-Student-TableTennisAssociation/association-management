BEGIN;

-- CreateEnum
CREATE TYPE "OrganizationTermPhase" AS ENUM ('planned', 'active', 'closing');

-- CreateTable
CREATE TABLE "members" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enrollment_year" SMALLINT,
    "left_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_terms" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "starts_on" DATE,
    "ends_on" DATE,
    "phase" "OrganizationTermPhase" NOT NULL DEFAULT 'planned',
    "president_member_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_terms_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint
ALTER TABLE "members"
  ADD CONSTRAINT "members_name_not_blank_check"
  CHECK ("name" ~ '[^[:space:]]');

-- AddCheckConstraint
ALTER TABLE "organization_terms"
  ADD CONSTRAINT "organization_terms_name_not_blank_check"
  CHECK ("name" ~ '[^[:space:]]');

-- AddCheckConstraint
ALTER TABLE "organization_terms"
  ADD CONSTRAINT "organization_terms_phase_fields_check"
  CHECK (
    (
      "phase" = 'planned'
      AND "ends_on" IS NULL
      AND "archived_at" IS NULL
    )
    OR (
      "phase" = 'active'
      AND "president_member_id" IS NOT NULL
      AND "starts_on" IS NOT NULL
      AND "ends_on" IS NULL
      AND "archived_at" IS NULL
    )
    OR (
      "phase" = 'closing'
      AND "president_member_id" IS NOT NULL
      AND "starts_on" IS NOT NULL
      AND "ends_on" IS NOT NULL
    )
  );

-- AddCheckConstraint
ALTER TABLE "organization_terms"
  ADD CONSTRAINT "organization_terms_date_order_check"
  CHECK (
    "ends_on" IS NULL
    OR (
      "starts_on" IS NOT NULL
      AND "ends_on" >= "starts_on"
    )
  );

-- CreateIndex
CREATE UNIQUE INDEX "organization_terms_name_key" ON "organization_terms"("name");

-- CreateIndex
CREATE INDEX "organization_terms_phase_archived_at_idx" ON "organization_terms"("phase", "archived_at");

-- CreateIndex
CREATE INDEX "organization_terms_president_member_id_idx" ON "organization_terms"("president_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_terms_one_active_idx"
  ON "organization_terms"("phase")
  WHERE "phase" = 'active';

-- AddForeignKey
ALTER TABLE "organization_terms" ADD CONSTRAINT "organization_terms_president_member_id_fkey" FOREIGN KEY ("president_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
