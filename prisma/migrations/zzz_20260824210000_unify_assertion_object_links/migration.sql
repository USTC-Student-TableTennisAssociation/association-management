CREATE TABLE "memory_assertion_object_links" (
  "assertion_id" UUID NOT NULL,
  "global_object_id" UUID NOT NULL,
  CONSTRAINT "memory_assertion_object_links_pkey"
    PRIMARY KEY ("assertion_id", "global_object_id"),
  CONSTRAINT "memory_assertion_object_links_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "memory_assertion_object_links_global_object_id_fkey"
    FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "memory_assertion_object_links_global_object_id_idx"
  ON "memory_assertion_object_links"("global_object_id");

CREATE TABLE "memory_assertion_object_occurrences" (
  "atom_id" TEXT NOT NULL,
  "assertion_id" UUID NOT NULL,
  "global_object_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "source_start" INTEGER NOT NULL,
  "source_end" INTEGER NOT NULL,
  "source_text" TEXT NOT NULL,
  CONSTRAINT "memory_assertion_object_occurrences_pkey" PRIMARY KEY ("atom_id"),
  CONSTRAINT "memory_assertion_object_occurrences_source_span_check"
    CHECK ("ordinal" >= 0 AND "source_start" >= 0 AND "source_end" > "source_start"),
  CONSTRAINT "memory_assertion_object_occurrences_link_fkey"
    FOREIGN KEY ("assertion_id", "global_object_id")
    REFERENCES "memory_assertion_object_links"("assertion_id", "global_object_id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "memory_assertion_object_occurrences_assertion_id_ordinal_key"
  ON "memory_assertion_object_occurrences"("assertion_id", "ordinal");
CREATE INDEX "memory_assertion_object_occurrences_global_object_id_idx"
  ON "memory_assertion_object_occurrences"("global_object_id");

CREATE TABLE "memory_assertion_object_coverage" (
  "assertion_id" UUID NOT NULL,
  "global_object_id" UUID NOT NULL,
  CONSTRAINT "memory_assertion_object_coverage_pkey"
    PRIMARY KEY ("assertion_id", "global_object_id"),
  CONSTRAINT "memory_assertion_object_coverage_assertion_id_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "memory_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "memory_assertion_object_coverage_global_object_id_fkey"
    FOREIGN KEY ("global_object_id") REFERENCES "memory_global_objects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "memory_assertion_object_coverage_global_object_id_idx"
  ON "memory_assertion_object_coverage"("global_object_id");

-- Direct source-fragment resolutions and literal occurrences are canonical participation.
INSERT INTO "memory_assertion_object_links" ("assertion_id", "global_object_id")
SELECT "assertion_id", "global_object_id"
FROM "memory_global_assertion_reference_resolutions"
UNION
SELECT "assertion_id", "global_object_id"
FROM "memory_global_assertion_literal_references"
ON CONFLICT DO NOTHING;

-- Historical publishers used semantic links for both grounded participation and
-- reference-only coverage. Preserve grounded rows as core edges and demote
-- reference rows to the retrieval-only coverage index.
INSERT INTO "memory_assertion_object_links" ("assertion_id", "global_object_id")
SELECT link."assertion_id", link."global_object_id"
FROM "memory_assertion_semantic_object_links" link
JOIN "memory_assertions" assertion ON assertion."id" = link."assertion_id"
WHERE assertion."kind" = 'grounded'
ON CONFLICT DO NOTHING;

INSERT INTO "memory_assertion_object_coverage" ("assertion_id", "global_object_id")
SELECT link."assertion_id", link."global_object_id"
FROM "memory_assertion_semantic_object_links" link
JOIN "memory_assertions" assertion ON assertion."id" = link."assertion_id"
WHERE assertion."kind" = 'reference'
ON CONFLICT DO NOTHING;

INSERT INTO "memory_assertion_object_occurrences" (
  "atom_id", "assertion_id", "global_object_id", "ordinal",
  "source_start", "source_end", "source_text"
)
SELECT
  literal."atom_id", literal."assertion_id", literal."global_object_id",
  literal."global_ordinal", literal."source_start", literal."source_end", literal."source_text"
FROM "memory_global_assertion_literal_references" literal;

DROP TABLE "memory_assertion_semantic_object_links";
DROP TABLE "memory_global_assertion_literal_references";
DROP TABLE "memory_global_assertion_reference_resolutions";
