BEGIN;

-- CreateEnum
CREATE TYPE "ProjectPhase" AS ENUM ('draft', 'planning', 'preparation', 'active', 'closing', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_term_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "phase" "ProjectPhase" NOT NULL DEFAULT 'draft',
    "owner_member_id" UUID,
    "planned_start_on" DATE,
    "planned_end_on" DATE,
    "actual_start_on" DATE,
    "actual_end_on" DATE,
    "completed_on" DATE,
    "cancelled_on" DATE,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "assignee_member_id" UUID,
    "description" TEXT,
    "acceptance_criteria" TEXT,
    "current_progress" TEXT,
    "due_on" DATE,
    "completed_on" DATE,
    "cancelled_on" DATE,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_title_not_blank_check"
  CHECK ("title" ~ '[^[:space:]]');

-- AddCheckConstraint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_summary_not_blank_check"
  CHECK ("summary" IS NULL OR "summary" ~ '[^[:space:]]');

-- AddCheckConstraint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_owner_required_after_draft_check"
  CHECK ("phase" = 'draft' OR "owner_member_id" IS NOT NULL);

-- AddCheckConstraint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_terminal_phase_dates_check"
  CHECK (
    (
      "phase" = 'completed'
      AND "completed_on" IS NOT NULL
      AND "cancelled_on" IS NULL
    )
    OR (
      "phase" = 'cancelled'
      AND "cancelled_on" IS NOT NULL
      AND "completed_on" IS NULL
    )
    OR (
      "phase" NOT IN ('completed', 'cancelled')
      AND "completed_on" IS NULL
      AND "cancelled_on" IS NULL
    )
  );

-- AddCheckConstraint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_planned_date_order_check"
  CHECK (
    "planned_start_on" IS NULL
    OR "planned_end_on" IS NULL
    OR "planned_end_on" >= "planned_start_on"
  );

-- AddCheckConstraint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_actual_date_order_check"
  CHECK (
    "actual_start_on" IS NULL
    OR "actual_end_on" IS NULL
    OR "actual_end_on" >= "actual_start_on"
  );

-- AddCheckConstraint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_archive_terminal_check"
  CHECK (
    "archived_at" IS NULL
    OR "phase" IN ('completed', 'cancelled')
  );

-- AddCheckConstraint
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_title_not_blank_check"
  CHECK ("title" ~ '[^[:space:]]');

-- AddCheckConstraint
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_terminal_dates_mutually_exclusive_check"
  CHECK ("completed_on" IS NULL OR "cancelled_on" IS NULL);

-- AddCheckConstraint
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_completion_requirements_check"
  CHECK (
    "completed_on" IS NULL
    OR (
      "assignee_member_id" IS NOT NULL
      AND "acceptance_criteria" IS NOT NULL
      AND "acceptance_criteria" ~ '[^[:space:]]'
    )
  );

-- AddCheckConstraint
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_archive_terminal_check"
  CHECK (
    "archived_at" IS NULL
    OR "completed_on" IS NOT NULL
    OR "cancelled_on" IS NOT NULL
  );

-- CreateIndex
CREATE INDEX "projects_organization_term_id_phase_idx" ON "projects"("organization_term_id", "phase");

-- CreateIndex
CREATE INDEX "projects_owner_member_id_idx" ON "projects"("owner_member_id");

-- CreateIndex
CREATE INDEX "tasks_project_id_idx" ON "tasks"("project_id");

-- CreateIndex
CREATE INDEX "tasks_assignee_member_id_idx" ON "tasks"("assignee_member_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_term_id_fkey" FOREIGN KEY ("organization_term_id") REFERENCES "organization_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_member_id_fkey" FOREIGN KEY ("owner_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_member_id_fkey" FOREIGN KEY ("assignee_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
