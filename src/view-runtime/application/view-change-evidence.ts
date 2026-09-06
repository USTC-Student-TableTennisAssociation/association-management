import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import type { ViewChange, ViewModule } from "@/contracts";
import { embedMemoryQueries } from "@/memory/embedding-client";
import { renderResolvedAssertion } from "@/memory/resolved-assertion";
import type {
  ViewChangeExecution,
  ViewRelatedObject,
} from "@/view-runtime/application/view-change-context";

const DEFAULT_ASSERTION_LIMIT = 8;
const ASSERTION_SCAN_LIMIT = 400;

export type ViewChangeEvidenceEnvelope = {
  version: "view-change-evidence.v1";
  basis: "preexisting_shared_brain";
  relatedObjects: string[];
  changedFields: Array<{
    cardType: string;
    field: string;
    definition: string | null;
    before: unknown;
    after: unknown;
  }>;
  assertions: Array<{
    ref: string;
    statement: string;
    sources: string[];
  }>;
  coverage: "relevant_assertions_found" | "no_relevant_assertion" | "no_object_anchor";
  semanticRetrieval: "used" | "unavailable" | "not_needed";
  warnings: string[];
  truncated: boolean;
};

type EvidenceField = ViewChangeEvidenceEnvelope["changedFields"][number];

function value(changeValue: { present: false } | { present: true; value: unknown }): unknown {
  return changeValue.present ? changeValue.value : null;
}

function changedFields(
  viewModule: ViewModule,
  executions: readonly ViewChangeExecution[],
): EvidenceField[] {
  const fields: EvidenceField[] = [];
  const seen = new Set<string>();
  const add = (field: EvidenceField) => {
    const key = JSON.stringify(field);
    if (seen.has(key)) return;
    seen.add(key);
    fields.push(field);
  };
  const definitionFor = (change: ViewChange) => {
    const cardTypeKey = change.kind === "card_created" || change.kind === "card_deleted"
      ? change.card.cardTypeKey
      : change.cardTypeKey;
    return viewModule.schema.cardTypes.find((cardType) => cardType.key === cardTypeKey);
  };

  for (const execution of executions) {
    for (const change of execution.changes) {
      const cardType = definitionFor(change);
      if (change.kind === "dimension") {
        const definition = cardType?.dimensions.find((item) => item.key === change.dimensionKey);
        add({
          cardType: cardType?.label ?? change.cardTypeKey,
          field: definition?.label ?? change.dimensionKey,
          definition: definition?.description ?? null,
          before: value(change.before),
          after: value(change.after),
        });
        continue;
      }
      if (change.kind === "slot") {
        const definition = cardType?.slots.find((item) => item.key === change.slotKey);
        add({
          cardType: cardType?.label ?? change.cardTypeKey,
          field: definition?.label ?? change.slotKey,
          definition: definition?.description ?? null,
          before: change.before,
          after: change.after,
        });
        continue;
      }
      if (change.kind === "related_objects") {
        add({
          cardType: cardType?.label ?? change.cardTypeKey,
          field: "关联认知 Object",
          definition: cardType?.relatedObjects?.description ?? null,
          before: change.before,
          after: change.after,
        });
        continue;
      }
      for (const dimension of cardType?.dimensions ?? []) {
        const present = Object.hasOwn(change.card.dimensions, dimension.key);
        if (!present) continue;
        add({
          cardType: cardType?.label ?? change.card.cardTypeKey,
          field: dimension.label,
          definition: dimension.description ?? null,
          before: change.kind === "card_deleted" && present
            ? change.card.dimensions[dimension.key]
            : null,
          after: change.kind === "card_created" && present
            ? change.card.dimensions[dimension.key]
            : null,
        });
      }
    }
  }
  return fields;
}

function normalized(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[\s“”"'《》〈〉【】（）()，,。.!！?？:：;；·—_\-]/g, "");
}

function bigrams(value: string): Set<string> {
  const text = normalized(value);
  if (text.length < 2) return new Set(text ? [text] : []);
  return new Set(Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)));
}

function overlap(left: string, right: string): number {
  const leftParts = bigrams(left);
  const rightParts = bigrams(right);
  if (!leftParts.size || !rightParts.size) return 0;
  let shared = 0;
  for (const item of leftParts) if (rightParts.has(item)) shared += 1;
  return (2 * shared) / (leftParts.size + rightParts.size);
}

function scalarTexts(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) return value.flatMap(scalarTexts).slice(0, 12);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(scalarTexts).slice(0, 12);
}

function scoreAssertion(statement: string, fields: readonly EvidenceField[]): number {
  const normalizedStatement = normalized(statement);
  let score = 0;
  for (const field of fields) {
    const cardType = normalized(field.cardType);
    if (cardType.length >= 2 && normalizedStatement.includes(cardType)) score += 2;
    const label = normalized(field.field);
    if (label.length >= 2 && normalizedStatement.includes(label)) score += 5;
    for (const candidate of [...scalarTexts(field.before), ...scalarTexts(field.after)]) {
      const token = normalized(candidate);
      if (token.length >= 2 && normalizedStatement.includes(token)) score += 8;
    }
    score += overlap(statement, field.field) * 8;
    score += overlap(statement, field.definition ?? "") * 3;
  }
  return score;
}

function semanticQuery(objects: readonly string[], fields: readonly EvidenceField[]): string {
  return [
    objects.join("、"),
    ...fields.flatMap((field) => [
      `${field.cardType} ${field.field}`,
      field.definition ?? "",
      ...scalarTexts(field.before),
      ...scalarTexts(field.after),
    ]),
  ].filter(Boolean).join("；").slice(0, 2_000);
}

type SemanticRanker = (input: {
  query: string;
  assertionIds: string[];
}) => Promise<ReadonlyMap<string, number>>;

async function rankSemantically(input: {
  database: PrismaClient;
  query: string;
  assertionIds: string[];
}): Promise<ReadonlyMap<string, number>> {
  if (!input.assertionIds.length || !input.query.trim()) return new Map();
  const index = await input.database.memoryAssertionEmbeddingIndex.findUnique({
    where: { id: "shared" },
  });
  if (!index) throw new Error("Assertion embedding index 尚未建立");
  const embedding = await embedMemoryQueries([input.query]);
  if (
    embedding.model !== index.modelKey ||
    embedding.modelRevision !== index.modelRevision ||
    embedding.dimension !== index.dimension
  ) {
    throw new Error("查询 embedding 与 Assertion index 不兼容");
  }
  const vector = `[${embedding.vectors[0].join(",")}]`;
  const ids = input.assertionIds.map((id) => Prisma.sql`${id}::uuid`);
  const rows = await input.database.$queryRaw<Array<{
    assertionId: string;
    score: number;
  }>>(Prisma.sql`
    SELECT
      e."assertion_id" AS "assertionId",
      (1 - (e."embedding" <=> ${vector}::vector))::float8 AS "score"
    FROM "memory_assertion_embeddings" e
    WHERE e."assertion_id" IN (${Prisma.join(ids)})
    ORDER BY e."embedding" <=> ${vector}::vector, e."assertion_id"
    LIMIT 32
  `);
  return new Map(rows.map((row) => [row.assertionId, row.score]));
}

export async function retrieveViewChangeEvidence(input: {
  database: PrismaClient;
  viewModule: ViewModule;
  executions: readonly ViewChangeExecution[];
  objects: readonly ViewRelatedObject[];
  limit?: number;
  semanticRanker?: SemanticRanker;
}): Promise<ViewChangeEvidenceEnvelope> {
  const fields = changedFields(input.viewModule, input.executions);
  const objectIds = [...new Set(input.objects.map((object) => object.id))];
  const relatedObjects = [...new Set(input.objects.map((object) => object.canonicalName))];
  if (!objectIds.length) {
    return {
      version: "view-change-evidence.v1",
      basis: "preexisting_shared_brain",
      relatedObjects,
      changedFields: fields,
      assertions: [],
      coverage: "no_object_anchor",
      semanticRetrieval: "not_needed",
      warnings: [],
      truncated: false,
    };
  }

  const rows = await input.database.memoryAssertion.findMany({
    where: {
      kind: "grounded",
      OR: [
        { objectLinks: { some: { globalObjectId: { in: objectIds } } } },
        { objectCoverage: { some: { globalObjectId: { in: objectIds } } } },
      ],
    },
    select: {
      id: true,
      globalStatementTemplateMarkdown: true,
      sourceRegion: {
        select: {
          label: true,
          sourceDocument: { select: { title: true } },
        },
      },
      chatEvidenceLinks: {
        orderBy: { ordinal: "asc" },
        take: 2,
        select: {
          chatEvidence: {
            select: { submittedBy: { select: { displayName: true } } },
          },
        },
      },
      objectLinks: {
        orderBy: { globalObjectId: "asc" },
        select: {
          globalObject: { select: { id: true, canonicalName: true } },
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: ASSERTION_SCAN_LIMIT + 1,
  });
  const scanned = rows.slice(0, ASSERTION_SCAN_LIMIT).flatMap((row) => {
    try {
      const statement = renderResolvedAssertion({
        assertionKey: row.id,
        globalStatementTemplateMarkdown: row.globalStatementTemplateMarkdown,
        references: row.objectLinks.map(({ globalObject }) => ({
          globalObjectId: globalObject.id,
          canonicalName: globalObject.canonicalName,
        })),
      });
      return [{
        id: row.id,
        statement,
        score: scoreAssertion(statement, fields),
        sources: row.sourceRegion
          ? [`${row.sourceRegion.sourceDocument.title} · ${row.sourceRegion.label}`]
          : row.chatEvidenceLinks.map(({ chatEvidence }) =>
              `对话 · ${chatEvidence.submittedBy.displayName}`
            ),
      }];
    } catch {
      return [];
    }
  });
  let semanticScores: ReadonlyMap<string, number> = new Map();
  let semanticRetrieval: ViewChangeEvidenceEnvelope["semanticRetrieval"] = "used";
  const warnings: string[] = [];
  try {
    semanticScores = await (input.semanticRanker ?? ((request) => rankSemantically({
      database: input.database,
      ...request,
    })) )({
      query: semanticQuery(relatedObjects, fields),
      assertionIds: scanned.map((row) => row.id),
    });
  } catch (error) {
    semanticRetrieval = "unavailable";
    warnings.push(
      `语义排序不可用，已保留 Object 锚定的字面检索：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rankedRelevant = scanned
    .map((row) => ({
      ...row,
      semanticScore: semanticScores.get(row.id) ?? 0,
    }))
    .filter((row) => row.score >= 1 || row.semanticScore >= 0.35)
    .sort((left, right) =>
      (right.score + right.semanticScore * 10) - (left.score + left.semanticScore * 10) ||
      left.id.localeCompare(right.id)
    );
  const limit = input.limit ?? DEFAULT_ASSERTION_LIMIT;
  const relevant = rankedRelevant.slice(0, limit);

  return {
    version: "view-change-evidence.v1",
    basis: "preexisting_shared_brain",
    relatedObjects,
    changedFields: fields,
    assertions: relevant.map((row, index) => ({
      ref: `E${index + 1}`,
      statement: row.statement,
      sources: row.sources,
    })),
    coverage: relevant.length ? "relevant_assertions_found" : "no_relevant_assertion",
    semanticRetrieval,
    warnings,
    truncated: rows.length > ASSERTION_SCAN_LIMIT || rankedRelevant.length > limit,
  };
}
