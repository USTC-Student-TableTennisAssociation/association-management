CREATE TYPE "LibraryNodeKind" AS ENUM ('file', 'folder');
CREATE TYPE "LibraryProcessingProfile" AS ENUM ('catalog', 'coarse', 'deep');
CREATE TYPE "LibraryProcessingStatus" AS ENUM ('idle', 'queued', 'running', 'ready', 'failed');
CREATE TYPE "LibraryPlanStatus" AS ENUM ('pending', 'approved', 'rejected', 'applied', 'failed');

CREATE TABLE "library_import_batches" (
  "id" UUID NOT NULL,
  "display_name" TEXT NOT NULL,
  "original_root" TEXT,
  "status" TEXT NOT NULL DEFAULT 'running',
  "file_count" INTEGER NOT NULL DEFAULT 0,
  "unique_blob_count" INTEGER NOT NULL DEFAULT 0,
  "error_message" TEXT,
  "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "library_import_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "library_source_blobs" (
  "id" UUID NOT NULL,
  "sha256" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "library_source_blobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "library_source_blobs_sha256_key" ON "library_source_blobs"("sha256");

CREATE TABLE "library_nodes" (
  "id" UUID NOT NULL,
  "kind" "LibraryNodeKind" NOT NULL,
  "parent_id" UUID,
  "name" TEXT NOT NULL,
  "normalized_name" TEXT NOT NULL,
  "blob_id" UUID,
  "import_batch_id" UUID,
  "original_relative_path" TEXT,
  "processing_profile" "LibraryProcessingProfile" NOT NULL DEFAULT 'catalog',
  "processing_status" "LibraryProcessingStatus" NOT NULL DEFAULT 'idle',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "library_nodes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "library_nodes_kind_blob_check" CHECK (
    ("kind" = 'file' AND "blob_id" IS NOT NULL) OR
    ("kind" = 'folder' AND "blob_id" IS NULL)
  )
);

CREATE UNIQUE INDEX "library_nodes_parent_id_normalized_name_key" ON "library_nodes"("parent_id", "normalized_name");
CREATE INDEX "library_nodes_parent_id_kind_name_idx" ON "library_nodes"("parent_id", "kind", "name");
CREATE INDEX "library_nodes_blob_id_idx" ON "library_nodes"("blob_id");
CREATE INDEX "library_nodes_processing_profile_processing_status_idx" ON "library_nodes"("processing_profile", "processing_status");

CREATE TABLE "library_source_processing_runs" (
  "id" UUID NOT NULL,
  "library_node_id" UUID NOT NULL,
  "profile" "LibraryProcessingProfile" NOT NULL,
  "profile_version" TEXT NOT NULL,
  "status" "LibraryProcessingStatus" NOT NULL DEFAULT 'queued',
  "parser_key" TEXT,
  "artifact_location" TEXT,
  "result_summary" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "library_source_processing_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "library_source_processing_runs_library_node_id_created_at_idx" ON "library_source_processing_runs"("library_node_id", "created_at");
CREATE INDEX "library_source_processing_runs_status_created_at_idx" ON "library_source_processing_runs"("status", "created_at");

CREATE TABLE "library_source_documents" (
  "id" UUID NOT NULL,
  "processing_run_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "parser" TEXT NOT NULL,
  "structure_metadata" JSONB NOT NULL DEFAULT '{}',
  "block_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "library_source_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "library_source_documents_processing_run_id_key" ON "library_source_documents"("processing_run_id");

CREATE TABLE "library_plans" (
  "id" UUID NOT NULL,
  "status" "LibraryPlanStatus" NOT NULL DEFAULT 'pending',
  "reason" TEXT NOT NULL,
  "operations" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMPTZ(3),
  "applied_at" TIMESTAMPTZ(3),
  "failure_reason" TEXT,
  CONSTRAINT "library_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "library_plans_status_created_at_idx" ON "library_plans"("status", "created_at");

ALTER TABLE "library_nodes" ADD CONSTRAINT "library_nodes_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "library_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "library_nodes" ADD CONSTRAINT "library_nodes_blob_id_fkey"
  FOREIGN KEY ("blob_id") REFERENCES "library_source_blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "library_nodes" ADD CONSTRAINT "library_nodes_import_batch_id_fkey"
  FOREIGN KEY ("import_batch_id") REFERENCES "library_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "library_source_processing_runs" ADD CONSTRAINT "library_source_processing_runs_library_node_id_fkey"
  FOREIGN KEY ("library_node_id") REFERENCES "library_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "library_source_documents" ADD CONSTRAINT "library_source_documents_processing_run_id_fkey"
  FOREIGN KEY ("processing_run_id") REFERENCES "library_source_processing_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
