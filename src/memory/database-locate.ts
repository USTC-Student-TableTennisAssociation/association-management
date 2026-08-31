import { getDatabase } from "@/db";
import { embedMemoryQueries } from "@/memory/embedding-client";
import {
  renderResolvedAssertion,
  type ResolvedAssertionReference,
} from "@/memory/resolved-assertion";
import {
  type MemoryAssertionSeed,
  type MemoryChannelTrace,
  type MemoryMatchMethod,
  type MemoryObjectAssertionConnection,
  type MemoryObjectSeed,
  type MemoryQuery,
  type MemoryRetrievalResult,
  type MemorySeedMatch,
  type MemorySearchTrace,
  type MemorySourceReference,
} from "@/memory/types";

const OBJECT_HITS_PER_FACET = 32;
const ASSERTION_LEXICAL_HITS_PER_FACET = 16;
const ASSERTION_VECTOR_HITS_PER_FACET = 16;
const ASSERTION_SEED_LIMIT = 48;

type LexicalMatch = {
  method: Exclude<MemoryMatchMethod, "vector">;
  score: number;
};

type ObjectRecord = Awaited<ReturnType<typeof loadObjects>>[number];
type AssertionRecord = Awaited<ReturnType<typeof loadAssertions>>[number];

type RankedObjectHit = {
  facetId: string;
  object: ObjectRecord;
  method: LexicalMatch["method"];
  score: number;
  rank: number;
};

type RankedAssertionHit = {
  facetId: string;
  assertion: AssertionRecord;
  method: MemoryMatchMethod;
  score: number;
  distance?: number;
  rank: number;
};

type VectorRow = {
  assertionId: string;
  distance: number;
  score: number;
};

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function identityNormalized(value: string): string {
  return normalized(value).replace(/[\s“”"'《》〈〉【】（）()，,。.!！?？:：;；·—_-]/g, "");
}

function bigrams(value: string): string[] {
  const compact = identityNormalized(value);
  if (compact.length < 2) return compact ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2));
}

function diceSimilarity(left: string, right: string): number {
  const leftParts = bigrams(left);
  const rightParts = bigrams(right);
  if (!leftParts.length || !rightParts.length) return 0;
  const remaining = new Map<string, number>();
  for (const part of rightParts) remaining.set(part, (remaining.get(part) ?? 0) + 1);
  let overlap = 0;
  for (const part of leftParts) {
    const count = remaining.get(part) ?? 0;
    if (count > 0) {
      overlap += 1;
      remaining.set(part, count - 1);
    }
  }
  return (2 * overlap) / (leftParts.length + rightParts.length);
}

function candidateMatch(query: string, candidate: string): LexicalMatch | undefined {
  const rawQuery = query.trim().toLocaleLowerCase("zh-CN");
  const rawCandidate = candidate.trim().toLocaleLowerCase("zh-CN");
  if (rawQuery === rawCandidate) return { method: "exact", score: 1 };

  const queryNormalized = normalized(query);
  const candidateNormalized = normalized(candidate);
  if (
    queryNormalized === candidateNormalized ||
    identityNormalized(query) === identityNormalized(candidate)
  ) {
    return { method: "normalized-exact", score: 0.99 };
  }

  const shorter = Math.min(identityNormalized(query).length, identityNormalized(candidate).length);
  if (
    shorter >= 2 &&
    (queryNormalized.includes(candidateNormalized) || candidateNormalized.includes(queryNormalized))
  ) {
    const coverage = shorter / Math.max(identityNormalized(query).length, identityNormalized(candidate).length);
    return { method: "contains", score: 0.9 + coverage * 0.07 };
  }

  const similarity = diceSimilarity(query, candidate);
  if (similarity <= 0) return undefined;
  return { method: "fuzzy", score: similarity * 0.85 };
}

function lexicalMatch(query: string, label: string, aliases: string[] = []): LexicalMatch | undefined {
  const labelMatch = candidateMatch(query, label);
  let best = labelMatch;
  for (const alias of aliases) {
    const aliasMatch = candidateMatch(query, alias);
    if (!aliasMatch) continue;
    const adjusted: LexicalMatch = {
      method: aliasMatch.method === "exact" || aliasMatch.method === "normalized-exact"
        ? "alias"
        : aliasMatch.method,
      score: Math.min(0.98, aliasMatch.score),
    };
    if (!best || adjusted.score > best.score) best = adjusted;
  }
  return best;
}

function environmentScore(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`${name} 必须是 -1 到 1 之间的数字`);
  }
  return value;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function objectStableKey(item: ObjectRecord): string {
  return `${item.globalObjectKey}\u0000${item.id}`;
}

function assertionStableKey(item: AssertionRecord): string {
  return item.id;
}

function renderAssertion(assertion: AssertionRecord): string {
  return renderResolvedAssertion({
    globalStatementTemplateMarkdown: assertion.globalStatementTemplateMarkdown,
    references: assertion.references,
    assertionKey: assertionStableKey(assertion),
  });
}

async function loadObjects() {
  const rows = await getDatabase().memoryGlobalObject.findMany({
    select: {
      id: true,
      globalObjectKey: true,
      canonicalName: true,
      surfaceMemberships: {
        select: {
          surfaceFormOrdinal: true,
          objectFragment: {
            select: {
              sourceFragmentId: true,
              surfaceForms: true,
            },
          },
        },
      },
      chatMentions: { select: { surfaceForm: true } },
    },
  });
  return rows.map((row) => {
    const surfaceForms = new Set<string>();
    for (const membership of row.surfaceMemberships) {
      const surfaceForm = membership.objectFragment.surfaceForms[membership.surfaceFormOrdinal];
      if (surfaceForm === undefined) {
        throw new Error(
          `GlobalObject ${row.globalObjectKey} 的 Fragment ${membership.objectFragment.sourceFragmentId} ` +
            `缺少 surface ordinal ${membership.surfaceFormOrdinal}`,
        );
      }
      if (surfaceForm.trim()) surfaceForms.add(surfaceForm);
    }
    for (const mention of row.chatMentions ?? []) {
      if (mention.surfaceForm.trim()) surfaceForms.add(mention.surfaceForm);
    }
    return {
      id: row.id,
      globalObjectKey: row.globalObjectKey,
      canonicalName: row.canonicalName,
      surfaceForms: [...surfaceForms].sort((left, right) => left.localeCompare(right, "zh-CN")),
    };
  });
}

async function loadAssertions() {
  const rows = await getDatabase().memoryAssertion.findMany({
    select: {
      id: true,
      sourceClaimId: true,
      kind: true,
      globalStatementTemplateMarkdown: true,
      contextDependent: true,
      sourceRegion: {
        select: {
          sourceNodeId: true,
          label: true,
        },
      },
      objectLinks: {
        orderBy: { globalObjectId: "asc" },
        select: {
          globalObject: {
            select: {
              id: true,
              canonicalName: true,
            },
          },
        },
      },
      objectCoverage: {
        orderBy: { globalObjectId: "asc" },
        select: {
          globalObject: {
            select: {
              id: true,
              canonicalName: true,
            },
          },
        },
      },
    },
  });
  return rows.map((row) => {
    const references = row.objectLinks.map<ResolvedAssertionReference>(
      ({ globalObject }) => ({
        globalObjectId: globalObject.id,
        canonicalName: globalObject.canonicalName,
      }),
    );
    const coverageReferences = row.objectCoverage.map<ResolvedAssertionReference>(
      ({ globalObject }) => ({
        globalObjectId: globalObject.id,
        canonicalName: globalObject.canonicalName,
      }),
    );
    return {
      id: row.id,
      sourceClaimId: row.sourceClaimId,
      kind: row.kind,
      globalStatementTemplateMarkdown: row.globalStatementTemplateMarkdown,
      contextDependent: row.contextDependent,
      sourceRegion: row.sourceRegion,
      references,
      coverageReferences,
    };
  });
}

function retrievalReferences(assertion: AssertionRecord): ResolvedAssertionReference[] {
  return [...assertion.references, ...assertion.coverageReferences];
}

function rankObjectLexical(
  facets: MemoryQuery["facets"],
  objects: ObjectRecord[],
  minimumScore: number,
): RankedObjectHit[] {
  return (facets ?? []).flatMap((facet) =>
    objects
      .flatMap((object) => {
        const match = lexicalMatch(facet.text, object.canonicalName, object.surfaceForms);
        return match && match.score >= minimumScore ? [{ facetId: facet.id, object, ...match }] : [];
      })
      .sort((left, right) => right.score - left.score || objectStableKey(left.object).localeCompare(objectStableKey(right.object)))
      .slice(0, OBJECT_HITS_PER_FACET)
      .map((hit, index) => ({ ...hit, rank: index + 1 })),
  );
}

function rankAssertionLexical(
  facets: MemoryQuery["facets"],
  assertions: AssertionRecord[],
  minimumScore: number,
): RankedAssertionHit[] {
  return (facets ?? []).flatMap((facet) =>
    assertions
      .flatMap((assertion) => {
        const match = lexicalMatch(facet.text, renderAssertion(assertion));
        return match && match.score >= minimumScore
          ? [{ facetId: facet.id, assertion, ...match }]
          : [];
      })
      .sort((left, right) => right.score - left.score || assertionStableKey(left.assertion).localeCompare(assertionStableKey(right.assertion)))
      .slice(0, ASSERTION_LEXICAL_HITS_PER_FACET)
      .map((hit, index) => ({ ...hit, rank: index + 1 })),
  );
}

async function rankAssertionVectors(input: {
  facets: NonNullable<MemoryQuery["facets"]>;
  vectors: number[][];
  assertionsById: Map<string, AssertionRecord>;
  minimumScore: number;
}): Promise<RankedAssertionHit[]> {
  const database = getDatabase();
  const lists = await Promise.all(
    input.facets.map(async (facet, index) => {
      const literal = vectorLiteral(input.vectors[index]);
      const rows = await database.$queryRaw<VectorRow[]>`
        SELECT
          e."assertion_id" AS "assertionId",
          (e."embedding" <=> ${literal}::vector)::float8 AS "distance",
          (1 - (e."embedding" <=> ${literal}::vector))::float8 AS "score"
        FROM "memory_assertion_embeddings" e
        ORDER BY e."embedding" <=> ${literal}::vector, e."assertion_id"
        LIMIT ${ASSERTION_VECTOR_HITS_PER_FACET}
      `;
      return rows.flatMap((row, rank) => {
        const assertion = input.assertionsById.get(row.assertionId);
        return assertion && row.score >= input.minimumScore
          ? [{
              facetId: facet.id,
              assertion,
              method: "vector" as const,
              score: row.score,
              distance: row.distance,
              rank: rank + 1,
            }]
          : [];
      });
    }),
  );
  return lists.flat();
}

function groupedMatches<T extends { facetId: string; rank: number; score: number }>(
  hits: T[],
  id: (hit: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const hit of hits) {
    const key = id(hit);
    result.set(key, [...(result.get(key) ?? []), hit]);
  }
  return result;
}

function matchesForAssertion(hits: RankedAssertionHit[]): MemorySeedMatch[] {
  return hits
    .map((hit) => ({
      facetId: hit.facetId,
      channel: hit.method === "vector" ? "assertion-vector" as const : "assertion-lexical" as const,
      method: hit.method,
      rank: hit.rank,
      score: hit.score,
      ...(hit.distance === undefined ? {} : { distance: hit.distance }),
    }))
    .sort((left, right) => left.rank - right.rank || right.score - left.score);
}

function matchesForObject(
  lexicalHits: RankedObjectHit[],
  supportingAssertionMatches: MemorySeedMatch[],
): MemorySeedMatch[] {
  const direct = lexicalHits.map<MemorySeedMatch>((hit) => ({
    facetId: hit.facetId,
    channel: "object-lexical",
    method: hit.method,
    rank: hit.rank,
    score: hit.score,
  }));
  const semantic = supportingAssertionMatches.map((match) => ({ ...match }));
  return [...direct, ...semantic].sort(
    (left, right) => left.rank - right.rank || right.score - left.score,
  );
}

async function loadSources(
  assertionIds: string[],
): Promise<Map<string, MemorySourceReference[]>> {
  if (!assertionIds.length) return new Map();
  const rows = await getDatabase().memoryAssertion.findMany({
    where: { id: { in: assertionIds } },
    select: {
      id: true,
      sourceRegion: {
        select: {
          sourceNodeId: true,
          label: true,
          sourceDocument: {
            select: {
              id: true,
              title: true,
              sourceBlob: { select: { sha256: true } },
            },
          },
        },
      },
      chatEvidenceLinks: {
        orderBy: { ordinal: "asc" },
        select: {
          ordinal: true,
          chatEvidence: {
            select: {
              id: true,
              submittedAt: true,
              timezone: true,
              submittedBy: { select: { id: true, displayName: true } },
            },
          },
        },
      },
      sourceBlockLinks: {
        orderBy: { ordinal: "asc" },
        select: {
          ordinal: true,
          sourceBlock: {
            select: {
              sourceDocumentId: true,
              sourceBlockId: true,
              sourcePages: true,
            },
          },
        },
      },
    },
  });
  return new Map(
    rows.map((row) => {
      const sources: MemorySourceReference[] = row.sourceRegion
        ? row.sourceBlockLinks.map(({ ordinal, sourceBlock }) => ({
            kind: "document",
            sourceDocumentId: sourceBlock.sourceDocumentId,
            sourceTitle: row.sourceRegion!.sourceDocument.title,
            sourceSha256: row.sourceRegion!.sourceDocument.sourceBlob.sha256,
            sourceNodeId: row.sourceRegion!.sourceNodeId,
            sourceRegionLabel: row.sourceRegion!.label,
            sourceBlockId: sourceBlock.sourceBlockId,
            ordinal,
            pages: sourceBlock.sourcePages,
          }))
        : row.chatEvidenceLinks.map(({ ordinal, chatEvidence }) => ({
              kind: "chat",
              evidenceId: chatEvidence.id,
              actorId: chatEvidence.submittedBy.id,
              actorDisplayName: chatEvidence.submittedBy.displayName,
              submittedAt: chatEvidence.submittedAt.toISOString(),
              timezone: chatEvidence.timezone,
              ordinal,
            }));
      return [row.id, sources];
    }),
  );
}

function channelTrace<T extends RankedObjectHit | RankedAssertionHit>(input: {
  facets: NonNullable<MemoryQuery["facets"]>;
  hits: T[];
  targetRef: (hit: T) => string;
  label: (hit: T) => string;
  selected: (hit: T) => boolean;
}): MemoryChannelTrace[] {
  return input.facets.map((facet) => ({
    facetId: facet.id,
    facetText: facet.text,
    hits: input.hits
      .filter((hit) => hit.facetId === facet.id)
      .map((hit) => ({
        facetId: hit.facetId,
        targetRef: input.targetRef(hit),
        label: input.label(hit),
        method: hit.method,
        rank: hit.rank,
        score: hit.score,
        ...("distance" in hit && hit.distance !== undefined ? { distance: hit.distance } : {}),
        selected: input.selected(hit),
      })),
  }));
}

export async function locateObjectAssertions(input: MemoryQuery): Promise<MemoryRetrievalResult> {
  const started = Date.now();
  const database = getDatabase();
  const [embeddingIndex, globalObjectCount, objectFragmentCount, surfaceFormCount,
    fragmentReferenceCount, assertionCount] = await Promise.all([
    database.memoryAssertionEmbeddingIndex.findUnique({ where: { id: "shared" } }),
    database.memoryGlobalObject.count(),
    database.memorySourceObjectFragment.count(),
    database.memoryGlobalObjectSurfaceMembership.count(),
    database.memoryAssertionFragmentReference.count(),
    database.memoryAssertion.count(),
  ]);

  const facets = (input.facets?.length
    ? input.facets
    : [{ id: "facet-0", text: input.query, source: "query" as const }]
  ).slice(0, 4);
  const objectFacets = (input.objectFacets?.length ? input.objectFacets : facets).slice(0, 4);
  const warnings = [...(input.facetWarnings ?? [])];
  const minimumLexicalScore = environmentScore("MEMORY_MIN_LEXICAL_SCORE", 0.18);
  const minimumVectorScore = environmentScore("MEMORY_MIN_VECTOR_SCORE", 0.35);

  const [objects, assertions] = await Promise.all([
    loadObjects(),
    loadAssertions(),
  ]);
  const assertionsById = new Map(assertions.map((item) => [item.id, item]));
  const objectLexicalHits = rankObjectLexical(objectFacets, objects, minimumLexicalScore);
  const assertionLexicalHits = rankAssertionLexical(facets, assertions, minimumLexicalScore);

  let assertionVectorHits: RankedAssertionHit[] = [];
  try {
    if (!embeddingIndex) {
      throw new Error("Shared Brain 尚未建立 Assertion embedding index");
    }
    if (embeddingIndex.indexedAssertionCount !== assertionCount) {
      throw new Error(
        `Assertion embedding index 不完整：${embeddingIndex.indexedAssertionCount}/${assertionCount}`,
      );
    }
    const embedding = await embedMemoryQueries(facets.map((facet) => facet.text), {
      signal: input.signal,
    });
    if (
      embedding.model !== embeddingIndex.modelKey ||
      embedding.modelRevision !== embeddingIndex.modelRevision ||
      embedding.dimension !== embeddingIndex.dimension
    ) {
      throw new Error(
        `查询 embedding profile ${embedding.model}@${embedding.modelRevision}/${embedding.dimension} ` +
        `与数据库 ${embeddingIndex.modelKey}@${embeddingIndex.modelRevision}/${embeddingIndex.dimension} 不一致`,
      );
    }
    assertionVectorHits = await rankAssertionVectors({
      facets,
      vectors: embedding.vectors,
      assertionsById,
      minimumScore: minimumVectorScore,
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    // 新来源已发布但本地 BGE-M3 服务暂未启动时，仍允许 Shared Brain 使用 lexical 通道。
    // 只有显式设置 MEMORY_VECTOR_REQUIRED=true 的严格环境才拒绝降级。
    if (process.env.MEMORY_VECTOR_REQUIRED === "true") throw error;
    warnings.push(`Assertion vector 通道不可用，已仅使用 lexical：${String(error)}`);
  }

  const allAssertionHits = [...assertionLexicalHits, ...assertionVectorHits];
  const assertionHitsById = groupedMatches(allAssertionHits, (hit) => hit.assertion.id);
  const orderedAssertions = [...assertionHitsById]
    .map(([id, hits]) => ({
      id,
      assertion: hits[0].assertion,
      hits,
      bestScore: Math.max(...hits.map((hit) => hit.score)),
      bestRank: Math.min(...hits.map((hit) => hit.rank)),
      facetCount: new Set(hits.map((hit) => hit.facetId)).size,
    }))
    .sort(
      (left, right) =>
        right.bestScore - left.bestScore ||
        left.bestRank - right.bestRank ||
        right.facetCount - left.facetCount ||
        assertionStableKey(left.assertion).localeCompare(assertionStableKey(right.assertion)),
    );

  const assertionRefById = new Map(
    orderedAssertions.map((item, index) => [item.id, `A${index + 1}`]),
  );
  const selectedAssertions = orderedAssertions.slice(0, ASSERTION_SEED_LIMIT);
  const selectedAssertionIds = new Set(selectedAssertions.map((item) => item.id));
  const sourcesByAssertion = await loadSources([...selectedAssertionIds]);

  const lexicalObjectHitsById = groupedMatches(objectLexicalHits, (hit) => hit.object.id);
  const objectRecords = new Map(objects.map((item) => [item.id, item]));

  const supportingAssertionsByObject = new Map<string, Set<string>>();
  const supportingMatchesByObject = new Map<string, MemorySeedMatch[]>();
  for (const selected of selectedAssertions) {
    const assertionRef = assertionRefById.get(selected.id)!;
    const matches = matchesForAssertion(selected.hits);
    for (const objectId of new Set(retrievalReferences(selected.assertion).map((reference) => reference.globalObjectId))) {
      const refs = supportingAssertionsByObject.get(objectId) ?? new Set<string>();
      refs.add(assertionRef);
      supportingAssertionsByObject.set(objectId, refs);
      supportingMatchesByObject.set(
        objectId,
        [...(supportingMatchesByObject.get(objectId) ?? []), ...matches],
      );
    }
  }

  const objectIds = new Set([
    ...lexicalObjectHitsById.keys(),
    ...supportingAssertionsByObject.keys(),
  ]);
  const orderedObjects = [...objectIds]
    .map((id) => {
      const object = objectRecords.get(id);
      if (!object) throw new Error(`无法加载 Object ${id}`);
      const lexicalHits = lexicalObjectHitsById.get(id) ?? [];
      const semanticMatches = supportingMatchesByObject.get(id) ?? [];
      return {
        id,
        object,
        lexicalHits,
        semanticMatches,
        bestScore: Math.max(
          0,
          ...lexicalHits.map((hit) => hit.score),
          ...semanticMatches.map((hit) => hit.score),
        ),
        bestRank: Math.min(
          Number.MAX_SAFE_INTEGER,
          ...lexicalHits.map((hit) => hit.rank),
          ...semanticMatches.map((hit) => hit.rank),
        ),
      };
    })
    .sort(
      (left, right) =>
        right.bestScore - left.bestScore ||
        left.bestRank - right.bestRank ||
        objectStableKey(left.object).localeCompare(objectStableKey(right.object)),
    );
  const objectRefById = new Map(
    orderedObjects.map((item, index) => [item.id, `O${index + 1}`]),
  );

  const assertionSeeds: MemoryAssertionSeed[] = selectedAssertions.map((item) => {
    const matchedBy = matchesForAssertion(item.hits);
    return {
      ref: assertionRefById.get(item.id)!,
      id: item.assertion.id,
      kind: item.assertion.kind,
      dereferenceRequired: item.assertion.kind === "reference",
      ...(item.assertion.sourceRegion
        ? { sourceNodeId: item.assertion.sourceRegion.sourceNodeId }
        : {}),
      sourceClaimId: item.assertion.sourceClaimId,
      renderedStatement: renderAssertion(item.assertion),
      contextDependent: item.assertion.contextDependent,
      matchedBy,
      matchedFacets: [...new Set(matchedBy.map((match) => match.facetId))].sort(),
      sources: sourcesByAssertion.get(item.id) ?? [],
    };
  });

  const objectSeeds: MemoryObjectSeed[] = orderedObjects.map((item) => {
    const supportingAssertions = [...(supportingAssertionsByObject.get(item.id) ?? [])]
      .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
    const matchedBy = matchesForObject(item.lexicalHits, item.semanticMatches);
    return {
      ref: objectRefById.get(item.id)!,
      id: item.object.id,
      globalObjectKey: item.object.globalObjectKey,
      canonicalName: item.object.canonicalName,
      surfaceForms: item.object.surfaceForms,
      matchedBy,
      matchedFacets: [...new Set(matchedBy.map((match) => match.facetId))].sort(),
      supportingAssertions,
      lexicalMatch: item.lexicalHits.length > 0,
      semanticMatch: supportingAssertions.length > 0,
    };
  });

  const connections: MemoryObjectAssertionConnection[] = [];
  for (const selected of selectedAssertions) {
    const assertionRef = assertionRefById.get(selected.id)!;
    const resolvedObjectIds = new Set(
      selected.assertion.references.map((reference) => reference.globalObjectId),
    );
    for (const objectId of resolvedObjectIds) {
      const objectRef = objectRefById.get(objectId);
      if (!objectRef) continue;
      connections.push({
        assertionRef,
        objectRef,
      });
    }
  }

  const selectedObjectIds = new Set(orderedObjects.map((item) => item.id));
  const selectedAssertionIdSet = new Set(selectedAssertions.map((item) => item.id));
  const trace: MemorySearchTrace = {
    version: "structured-seed-map.v1",
    query: input.query,
    snapshot: {
      indexedAt: embeddingIndex?.indexedAt.toISOString() ?? null,
      embeddingModel: embeddingIndex?.modelKey ?? null,
      embeddingRevision: embeddingIndex?.modelRevision ?? null,
      embeddingDimension: embeddingIndex?.dimension ?? null,
      embeddingAssertionCount: embeddingIndex?.indexedAssertionCount ?? 0,
      globalObjectCount,
      objectFragmentCount,
      surfaceFormCount,
      fragmentReferenceCount,
      assertionCount,
    },
    facets,
    objectLexical: channelTrace({
      facets: objectFacets,
      hits: objectLexicalHits,
      targetRef: (hit) => objectRefById.get(hit.object.id) ?? objectStableKey(hit.object),
      label: (hit) => hit.object.canonicalName,
      selected: (hit) => selectedObjectIds.has(hit.object.id),
    }),
    assertionLexical: channelTrace({
      facets,
      hits: assertionLexicalHits,
      targetRef: (hit) => assertionRefById.get(hit.assertion.id) ?? assertionStableKey(hit.assertion),
      label: (hit) => renderAssertion(hit.assertion),
      selected: (hit) => selectedAssertionIdSet.has(hit.assertion.id),
    }),
    assertionVector: channelTrace({
      facets,
      hits: assertionVectorHits,
      targetRef: (hit) => assertionRefById.get(hit.assertion.id) ?? assertionStableKey(hit.assertion),
      label: (hit) => renderAssertion(hit.assertion),
      selected: (hit) => selectedAssertionIdSet.has(hit.assertion.id),
    }),
    semanticDerivedObjects: objectSeeds
      .filter((item) => item.semanticMatch)
      .map((item) => ({
        objectRef: item.ref,
        canonicalName: item.canonicalName,
        supportingAssertions: item.supportingAssertions,
        matchedFacets: item.matchedFacets,
      })),
    finalSeedMap: {
      objectRefs: objectSeeds.map((item) => item.ref),
      assertionRefs: assertionSeeds.map((item) => item.ref),
      connections: connections.length,
    },
    answerUsedAssertionRefs: [],
    budget: {
      facetLimit: 4,
      objectHitsPerFacet: OBJECT_HITS_PER_FACET,
      assertionLexicalHitsPerFacet: ASSERTION_LEXICAL_HITS_PER_FACET,
      assertionVectorHitsPerFacet: ASSERTION_VECTOR_HITS_PER_FACET,
      assertionSeeds: ASSERTION_SEED_LIMIT,
    },
    durationMs: Date.now() - started,
    warnings,
  };

  return {
    query: input.query,
    mode: "object-assertion",
    seedMap: {
      facets,
      objects: objectSeeds,
      assertions: assertionSeeds,
      connections,
    },
    trace,
  };
}

export { diceSimilarity, lexicalMatch, renderAssertion };
