CREATE TABLE "semantic_view_higher_memories" (
    "id" UUID NOT NULL,
    "view_key" TEXT NOT NULL,
    "content_markdown" TEXT NOT NULL,
    "maintained_at" TIMESTAMPTZ(3) NOT NULL,
    "maintenance_reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "semantic_view_higher_memories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "semantic_view_higher_memories_view_key_key"
ON "semantic_view_higher_memories"("view_key");

CREATE INDEX "semantic_view_higher_memories_maintained_at_idx"
ON "semantic_view_higher_memories"("maintained_at");
