UPDATE "library_catalog_assessments" AS assessment
SET "object_candidates" = COALESCE(
  (
    SELECT jsonb_agg(candidate - 'confidence')
    FROM jsonb_array_elements(assessment."object_candidates") AS candidate
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof("object_candidates") = 'array'
  AND "object_candidates"::text LIKE '%"confidence"%';

UPDATE "library_catalog_assessments"
SET "preview_excerpt" = regexp_replace(
  regexp_replace(
    "preview_excerpt",
    '（置信度 [0-9]+(\.[0-9]+)?；位置：',
    '（位置：',
    'g'
  ),
  '（置信度 [0-9]+(\.[0-9]+)?）',
  '',
  'g'
)
WHERE "preview_excerpt" LIKE '%置信度%';
