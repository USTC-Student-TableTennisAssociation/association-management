import { getDatabase } from "@/db";
import type { EvidenceSemantics } from "@/evidence/types";
import { lexicalMatch } from "@/memory/database-locate";
import {
  parseCognitiveMemory,
  parseOperationalMemoryIndex,
  renderCognitiveMemory,
} from "@/memory/higher-memory-document";
import {
  renderResolvedAssertion,
  type ResolvedAssertionReference,
} from "@/memory/resolved-assertion";
import { getMemoryRetriever } from "@/memory/retriever";
import type {
  EvidenceCoverage,
  MemoryAssertionKind,
  MemoryHigherMemorySeed,
  MemoryObjectAssertionConnection,
  MemoryRetrievalResult,
  MemorySourceReference,
  MemorySourceTime,
  StructuredSeedMap,
} from "@/memory/types";

const SEARCH_ASSERTION_LIMIT = 12;
const FOLLOW_ASSERTION_LIMIT = 12;
const OBJECT_LIMIT = 16;
const FOLLOW_ASSERTION_SCAN_LIMIT = 128;
const SURFACE_FORM_LIMIT = 8;
const SOURCE_LIMIT_PER_ASSERTION = 4;
const COLD_BOOTSTRAP_ASSERTION_LIMIT = 32;
const OPERATIONAL_INDEX_ASPECT_LIMIT = 8;
const OPERATIONAL_INDEX_ASSERTION_LIMIT = 64;
const OPERATIONAL_INDEX_MIN_MATCH_SCORE = 0.25;
const QUERY_CHAR_LIMIT = 500;
const FOCUS_CHAR_LIMIT = 300;

export type MemorySearchTaskShape = "fact" | "synthesis";

export type MemoryExploreObject = {
  ref: string;
  id: string;
  globalObjectKey: string;
  canonicalName: string;
  surfaceForms: string[];
  lexicalMatch: boolean;
  semanticMatch: boolean;
};

export type MemoryExploreAssertion = {
  ref: string;
  id?: string;
  kind: MemoryAssertionKind;
  dereferenceRequired: boolean;
  sourceNodeId?: string;
  sourceClaimId: string;
  renderedStatement: string;
  contextDependent: boolean;
  sources: MemorySourceReference[];
};

export type MemoryExploreResult = {
  kind: "search-memory" | "follow-object" | "business-context" | "artifact-knowledge";
  mode: MemoryRetrievalResult["mode"];
  query?: string;
  taskShape?: MemorySearchTaskShape;
  knowledgeState?: {
    targetObjectId: string;
    higherMemory: "absent" | "fresh" | "stale";
    coldBootstrapApplied: boolean;
  };
  globalObjectId?: string;
  focus?: string;
  sourceTime?: MemorySourceTime;
  objects: MemoryExploreObject[];
  higherMemories?: MemoryHigherMemorySeed[];
  assertions: MemoryExploreAssertion[];
  connections: MemoryObjectAssertionConnection[];
  counts: {
    objects: number;
    assertions: number;
    connections: number;
  };
  truncated: {
    objects: boolean;
    assertions: boolean;
  };
  coverage?: EvidenceCoverage;
  semantics?: EvidenceSemantics;
  warnings: string[];
};

export type MemoryExploreRuntime = {
  signal?: AbortSignal;
  /** Main chat prefers Higher Memory; background fact agents explicitly disable it. */
  preferHigherMemory?: boolean;
  /** Keeps verbose Locate diagnostics out of the model-visible tool result. */
  onLocate?: (retrieval: MemoryRetrievalResult) => void;
};

export type MemorySearchIntent = {
  query: string;
  targetHints?: string[];
  targetObjectIds?: string[];
  taskShape?: MemorySearchTaskShape;
};

type FollowAssertionRecord = Awaited<ReturnType<typeof loadFollowAssertions>>[number];

function requiredText(value: string, label: string, maxChars: number): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} 不能为空`);
  if (text.length > maxChars) throw new Error(`${label} 不能超过 ${maxChars} 个字符`);
  return text;
}

function optionalText(value: string | undefined, label: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxChars) throw new Error(`${label} 不能超过 ${maxChars} 个字符`);
  return text;
}

function identityText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("记忆检索已取消");
}

function safeSources(sources: MemorySourceReference[]): MemorySourceReference[] {
  return sources.slice(0, SOURCE_LIMIT_PER_ASSERTION).map((source) =>
    source.kind === "chat"
      ? {
          kind: "chat" as const,
          evidenceId: source.evidenceId,
          actorId: source.actorId,
          actorDisplayName: source.actorDisplayName,
          submittedAt: source.submittedAt,
          timezone: source.timezone,
          ordinal: source.ordinal,
        }
      : {
          kind: "document" as const,
          sourceDocumentId: source.sourceDocumentId,
          sourceTitle: source.sourceTitle,
          sourceSha256: source.sourceSha256,
          sourceNodeId: source.sourceNodeId,
          sourceRegionLabel: source.sourceRegionLabel,
          sourceBlockId: source.sourceBlockId,
          ordinal: source.ordinal,
          pages: [...source.pages],
        },
  );
}

function compactObject(input: {
  ref: string;
  id: string;
  globalObjectKey: string;
  canonicalName: string;
  surfaceForms: string[];
  lexicalMatch?: boolean;
  semanticMatch?: boolean;
}): MemoryExploreObject {
  return {
    ref: input.ref,
    id: input.id,
    globalObjectKey: input.globalObjectKey,
    canonicalName: input.canonicalName,
    surfaceForms: input.surfaceForms.slice(0, SURFACE_FORM_LIMIT),
    lexicalMatch: input.lexicalMatch ?? false,
    semanticMatch: input.semanticMatch ?? false,
  };
}

function compactAssertion(input: {
  ref: string;
  id?: string;
  kind: MemoryAssertionKind;
  dereferenceRequired: boolean;
  sourceNodeId?: string;
  sourceClaimId: string;
  renderedStatement: string;
  contextDependent: boolean;
  sources: MemorySourceReference[];
}): MemoryExploreAssertion {
  return {
    ref: input.ref,
    ...(input.id ? { id: input.id } : {}),
    kind: input.kind,
    dereferenceRequired: input.dereferenceRequired,
    ...(input.sourceNodeId ? { sourceNodeId: input.sourceNodeId } : {}),
    sourceClaimId: input.sourceClaimId,
    renderedStatement: input.renderedStatement,
    contextDependent: input.contextDependent,
    sources: safeSources(input.sources),
  };
}

function resultWithCounts(
  result: Omit<MemoryExploreResult, "counts">,
): MemoryExploreResult {
  return {
    ...result,
    counts: {
      objects: result.objects.length,
      assertions: result.assertions.length,
      connections: result.connections.length,
    },
  };
}

function compactLocatedSeedMap(
  seedMap: StructuredSeedMap,
  assertionLimit: number,
): Pick<MemoryExploreResult, "sourceTime" | "objects" | "assertions" | "connections" | "truncated"> {
  const selectedAssertionSeeds = seedMap.assertions.slice(0, assertionLimit);
  const assertionRefs = new Set(selectedAssertionSeeds.map((assertion) => assertion.ref));
  const connectionsByAssertion = new Map<string, string[]>();
  for (const connection of seedMap.connections) {
    if (!assertionRefs.has(connection.assertionRef)) continue;
    const objectRefs = connectionsByAssertion.get(connection.assertionRef) ?? [];
    objectRefs.push(connection.objectRef);
    connectionsByAssertion.set(connection.assertionRef, objectRefs);
  }

  // Explicit entity/name matches are target candidates and must remain ahead of
  // objects that only appear because a semantically similar Assertion mentions
  // them. Related objects are filled in afterwards for evidence intelligibility.
  const orderedObjectRefs: string[] = [];
  const candidateObjectRefs = new Set<string>();
  for (const object of seedMap.objects) {
    if (!object.lexicalMatch || candidateObjectRefs.has(object.ref)) continue;
    candidateObjectRefs.add(object.ref);
    orderedObjectRefs.push(object.ref);
  }
  for (const assertion of selectedAssertionSeeds) {
    for (const objectRef of connectionsByAssertion.get(assertion.ref) ?? []) {
      if (candidateObjectRefs.has(objectRef)) continue;
      candidateObjectRefs.add(objectRef);
      orderedObjectRefs.push(objectRef);
    }
  }

  const objectByRef = new Map(seedMap.objects.map((object) => [object.ref, object]));
  const objectCandidates = orderedObjectRefs.flatMap((ref) => {
    const object = objectByRef.get(ref);
    return object ? [object] : [];
  });
  const selectedObjectSeeds = objectCandidates.slice(0, OBJECT_LIMIT);
  const objectRefs = new Set(selectedObjectSeeds.map((object) => object.ref));
  const seenConnections = new Set<string>();
  const connections = seedMap.connections.filter((connection) => {
    if (!assertionRefs.has(connection.assertionRef) || !objectRefs.has(connection.objectRef)) {
      return false;
    }
    const key = `${connection.assertionRef}\u0000${connection.objectRef}`;
    if (seenConnections.has(key)) return false;
    seenConnections.add(key);
    return true;
  });

  return {
    ...(seedMap.sourceTime ? { sourceTime: seedMap.sourceTime } : {}),
    objects: selectedObjectSeeds.map(compactObject),
    assertions: selectedAssertionSeeds.map(compactAssertion),
    connections,
    truncated: {
      objects: objectCandidates.length > selectedObjectSeeds.length,
      assertions: seedMap.assertions.length > selectedAssertionSeeds.length,
    },
  };
}

async function preferObjectHigherMemories(
  compact: Pick<MemoryExploreResult, "sourceTime" | "objects" | "assertions" | "connections" | "truncated">,
  targetObjectIds: string[],
): Promise<{
  compact: typeof compact & { higherMemories?: MemoryHigherMemorySeed[] };
  staleObjectIds: string[];
  newerAssertionIds: string[];
}> {
  if (!targetObjectIds.length) {
    return { compact, staleObjectIds: [], newerAssertionIds: [] };
  }
  const database = getDatabase();
  const rows = await database.memoryObjectHigherMemory.findMany({
    where: {
      globalObjectId: { in: targetObjectIds },
    },
    select: {
      id: true,
      globalObjectId: true,
      cognitiveMemory: true,
      operationalIndex: true,
      maintainedAt: true,
    },
  });
  if (!rows.length) return { compact, staleObjectIds: [], newerAssertionIds: [] };
  const earliestMaintainedAt = rows.reduce(
    (earliest, row) => row.maintainedAt < earliest ? row.maintainedAt : earliest,
    rows[0].maintainedAt,
  );
  const higherMemoryObjectIds = rows.map((row) => row.globalObjectId);
  const newerAssertions = await database.memoryAssertion.findMany({
    where: {
      createdAt: { gt: earliestMaintainedAt },
      objectLinks: { some: { globalObjectId: { in: higherMemoryObjectIds } } },
    },
    select: {
      id: true,
      createdAt: true,
      objectLinks: { select: { globalObjectId: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 24,
  });
  const maintainedAtByObjectId = new Map(
    rows.map((row) => [row.globalObjectId, row.maintainedAt]),
  );
  const staleObjectIds = new Set<string>();
  const newerAssertionIds: string[] = [];
  for (const assertion of newerAssertions) {
    const associatedObjectIds = new Set(
      assertion.objectLinks.map((link) => link.globalObjectId),
    );
    let makesMemoryStale = false;
    for (const objectId of associatedObjectIds) {
      const maintainedAt = maintainedAtByObjectId.get(objectId);
      if (maintainedAt && assertion.createdAt > maintainedAt) {
        staleObjectIds.add(objectId);
        makesMemoryStale = true;
      }
    }
    if (makesMemoryStale) newerAssertionIds.push(assertion.id);
  }
  const objectOrder = new Map(targetObjectIds.map((id, index) => [id, index]));
  const ordered = rows.sort((left, right) =>
    (objectOrder.get(left.globalObjectId) ?? Number.MAX_SAFE_INTEGER) -
      (objectOrder.get(right.globalObjectId) ?? Number.MAX_SAFE_INTEGER) ||
    left.globalObjectId.localeCompare(right.globalObjectId)
  );
  return {
    compact: {
      ...compact,
      higherMemories: ordered.map((memory, index) => ({
        ref: `H${index + 1}`,
        id: memory.id,
        globalObjectId: memory.globalObjectId,
        contentMarkdown: renderCognitiveMemory(parseCognitiveMemory(memory.cognitiveMemory)),
        operationalIndex: parseOperationalMemoryIndex(memory.operationalIndex),
        maintainedAt: memory.maintainedAt.toISOString(),
      })),
    },
    staleObjectIds: [...staleObjectIds],
    newerAssertionIds,
  };
}

function operationalAspectMatchScore(
  query: string,
  aspect: MemoryHigherMemorySeed["operationalIndex"]["aspects"][number],
): number {
  return Math.max(
    0,
    ...[
      aspect.key,
      aspect.label,
      aspect.summary,
      ...aspect.recommendedQueries,
      ...aspect.unresolvedAspects,
      ...aspect.sourceTitles,
    ].map((text) => lexicalMatch(query, text)?.score ?? 0),
  );
}

/**
 * The main model still chooses to search and supplies the query. Once it does,
 * the Operational Memory Index contributes bounded candidates; it never dumps
 * Assertion or Source content into the model context by itself.
 */
async function operationalIndexAssertionIds(input: {
  query: string;
  higherMemories: readonly MemoryHigherMemorySeed[];
}): Promise<{ assertionIds: string[]; aspectKeys: string[] }> {
  const rankedAspects = input.higherMemories
    .flatMap((memory) => memory.operationalIndex.aspects)
    .map((aspect) => ({ aspect, score: operationalAspectMatchScore(input.query, aspect) }))
    .filter((item) => item.score >= OPERATIONAL_INDEX_MIN_MATCH_SCORE)
    .sort((left, right) =>
      right.score - left.score || left.aspect.key.localeCompare(right.aspect.key)
    )
    .slice(0, OPERATIONAL_INDEX_ASPECT_LIMIT);
  if (!rankedAspects.length) return { assertionIds: [], aspectKeys: [] };

  const directAssertionIds = rankedAspects.flatMap((item) => item.aspect.assertionIds);
  const sourceNodeIds = [...new Set(rankedAspects.flatMap((item) => item.aspect.sourceNodeIds))];
  const sourceTitles = [...new Set(rankedAspects.flatMap((item) => item.aspect.sourceTitles))];
  const sourceRegions = sourceNodeIds.length || sourceTitles.length
    ? await getDatabase().memorySourceRegion.findMany({
        where: {
          OR: [
            ...(sourceNodeIds.length ? [{ sourceNodeId: { in: sourceNodeIds } }] : []),
            ...(sourceTitles.length
              ? [{ sourceDocument: { title: { in: sourceTitles } } }]
              : []),
          ],
        },
        select: {
          assertions: {
            select: { id: true },
            orderBy: { id: "asc" },
            take: OPERATIONAL_INDEX_ASSERTION_LIMIT,
          },
        },
        take: OPERATIONAL_INDEX_ASSERTION_LIMIT,
      })
    : [];
  return {
    assertionIds: [...new Set([
      ...directAssertionIds,
      ...sourceRegions.flatMap((region) => region.assertions.map((assertion) => assertion.id)),
    ])].slice(0, OPERATIONAL_INDEX_ASSERTION_LIMIT),
    aspectKeys: rankedAspects.map((item) => item.aspect.key),
  };
}

/** Add Assertion candidates reached through an explicit memory index or Object relation. */
async function appendAssertionsToCompact(
  compact: Pick<MemoryExploreResult, "sourceTime" | "objects" | "assertions" | "connections" | "truncated">,
  assertionIds: string[],
): Promise<typeof compact> {
  const existingAssertionIds = new Set(compact.assertions.flatMap((assertion) =>
    assertion.id ? [assertion.id] : []
  ));
  const missingIds = assertionIds.filter((id) => !existingAssertionIds.has(id));
  if (!missingIds.length) return compact;

  const loaded = await loadFollowAssertions(missingIds);
  const loadedById = new Map(loaded.map((assertion) => [assertion.id, assertion]));
  const rendered = missingIds.flatMap((id) => {
    const assertion = loadedById.get(id);
    return assertion ? [renderFollowAssertion(assertion)] : [];
  });
  if (!rendered.length) return compact;

  const existingObjectIds = new Set(compact.objects.map((object) => object.id));
  const missingObjectIds = [...new Set(rendered.flatMap((assertion) =>
    assertion.associatedReferences.map((reference) => reference.globalObjectId)
  ))].filter((id) => !existingObjectIds.has(id));
  const addedObjects = await loadGlobalObjects(missingObjectIds);
  const objects = [
    ...compact.objects,
    ...addedObjects.map((object, index) => compactObject({
      ref: `OF${index + 1}`,
      ...object,
      semanticMatch: true,
    })),
  ];
  const objectRefById = new Map(objects.map((object) => [object.id, object.ref]));
  const assertions = rendered.map((assertion, index) => compactAssertion({
    ref: `AF${index + 1}`,
    id: assertion.row.id,
    kind: assertion.row.kind,
    dereferenceRequired: assertion.row.kind === "reference",
    ...(assertion.row.sourceRegion
      ? { sourceNodeId: assertion.row.sourceRegion.sourceNodeId }
      : {}),
    sourceClaimId: assertion.row.sourceClaimId,
    renderedStatement: assertion.renderedStatement,
    contextDependent: assertion.row.contextDependent,
    sources: assertionSources(assertion.row),
  }));
  const connections = rendered.flatMap((assertion, assertionIndex) =>
    [...new Set(assertion.associatedReferences.map((reference) => reference.globalObjectId))]
      .flatMap((objectId) => {
        const objectRef = objectRefById.get(objectId);
        return objectRef ? [{ assertionRef: `AF${assertionIndex + 1}`, objectRef }] : [];
      })
  );
  return {
    ...compact,
    objects,
    assertions: [...compact.assertions, ...assertions],
    connections: [...compact.connections, ...connections],
  };
}

function targetConstrainedCandidates(
  compact: Pick<MemoryExploreResult, "objects" | "assertions" | "connections">,
  targetObjectIds: string[],
): MemoryExploreAssertion[] {
  const targetRefs = new Set(compact.objects
    .filter((object) => targetObjectIds.includes(object.id))
    .map((object) => object.ref));
  const assertionRefs = new Set(compact.connections
    .filter((connection) => targetRefs.has(connection.objectRef))
    .map((connection) => connection.assertionRef));
  return compact.assertions.filter((assertion) => assertionRefs.has(assertion.ref));
}

function synthesisCandidateScore(query: string, assertion: MemoryExploreAssertion): number {
  const sourceLabels = assertion.sources.flatMap((source) =>
    source.kind === "chat" ? [] : [source.sourceTitle, source.sourceRegionLabel]
  );
  const searchable = [assertion.renderedStatement, ...sourceLabels].join("\n");
  const lexical = lexicalMatch(query, searchable)?.score ?? 0;
  return lexical + (assertion.kind === "reference" ? 0.25 : 0);
}

function rankSynthesisCandidates(
  query: string,
  assertions: MemoryExploreAssertion[],
): MemoryExploreAssertion[] {
  return [...assertions].sort((left, right) =>
    synthesisCandidateScore(query, right) - synthesisCandidateScore(query, left) ||
    left.ref.localeCompare(right.ref)
  );
}

async function targetLinkedAssertionIds(
  globalObjectId: string,
  query: string,
): Promise<string[]> {
  const database = getDatabase();
  const [coreLinks, coverageLinks] = await Promise.all([
    database.memoryAssertionObjectLink.findMany({
      where: { globalObjectId },
      select: { assertionId: true },
      distinct: ["assertionId"],
      orderBy: { assertionId: "asc" },
      take: FOLLOW_ASSERTION_SCAN_LIMIT,
    }),
    database.memoryAssertionObjectCoverage.findMany({
      where: { globalObjectId },
      select: { assertionId: true },
      distinct: ["assertionId"],
      orderBy: { assertionId: "asc" },
      take: FOLLOW_ASSERTION_SCAN_LIMIT,
    }),
  ]);
  const assertionIds = [...new Set([
    ...coreLinks.map((row) => row.assertionId),
    ...coverageLinks.map((row) => row.assertionId),
  ])];
  const loaded = await loadFollowAssertions(assertionIds);
  return loaded
    .map(renderFollowAssertion)
    .map((assertion) => {
      const sources = assertionSources(assertion.row);
      const sourceLabels = sources.flatMap((source) =>
        source.kind === "chat" ? [] : [source.sourceTitle, source.sourceRegionLabel]
      );
      const searchable = [assertion.renderedStatement, ...sourceLabels].join("\n");
      return {
        id: assertion.row.id,
        score: (lexicalMatch(query, searchable)?.score ?? 0) +
          (assertion.row.kind === "reference" ? 0.25 : 0),
      };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, COLD_BOOTSTRAP_ASSERTION_LIMIT)
    .map((item) => item.id);
}

function resolveTargetObjectIds(input: {
  objects: MemoryExploreObject[];
  targetHints: string[];
  explicitTargetObjectIds: string[];
}): { ids: string[]; warning?: string } {
  const availableIds = new Set(input.objects.map((object) => object.id));
  const explicitIds = [...new Set(input.explicitTargetObjectIds)]
    .filter((id) => availableIds.has(id));
  if (explicitIds.length) return { ids: explicitIds };
  if (!input.targetHints.length) {
    return { ids: input.objects.slice(0, 1).map((object) => object.id) };
  }

  const normalizedHints = new Set(input.targetHints.map(identityText).filter(Boolean));
  const matches = input.objects.filter((object) =>
    [object.canonicalName, ...object.surfaceForms]
      .map(identityText)
      .some((name) => normalizedHints.has(name))
  );
  if (matches.length === 1) return { ids: [matches[0].id] };
  return {
    ids: [],
    warning: matches.length
      ? "targetHints 同时精确匹配多个 Object；请从返回的 O# 中明确选择目标。"
      : "targetHints 未唯一精确匹配当前 Object；请从返回的 O# 中明确选择目标。",
  };
}

function filterCompactResult(
  compact: Pick<MemoryExploreResult, "sourceTime" | "objects" | "assertions" | "connections" | "truncated">,
  targetObjectIds: string[],
  selectedAssertionIds: string[],
) {
  const selectedAssertionIdSet = new Set(selectedAssertionIds);
  const selectedAssertions = compact.assertions.filter((assertion) =>
    assertion.id && selectedAssertionIdSet.has(assertion.id)
  );
  const selectedAssertionRefs = new Set(selectedAssertions.map((assertion) => assertion.ref));
  const necessaryObjectRefs = new Set(compact.connections
    .filter((connection) => selectedAssertionRefs.has(connection.assertionRef))
    .map((connection) => connection.objectRef));
  for (const object of compact.objects) {
    if (targetObjectIds.includes(object.id)) necessaryObjectRefs.add(object.ref);
  }
  const selectedObjects = [
    ...compact.objects.filter((object) => targetObjectIds.includes(object.id)),
    ...compact.objects.filter((object) =>
      !targetObjectIds.includes(object.id) && necessaryObjectRefs.has(object.ref)
    ),
  ];
  const localObjectRefByOldRef = new Map(
    selectedObjects.map((object, index) => [object.ref, `O${index + 1}`]),
  );
  const localAssertionRefByOldRef = new Map(
    selectedAssertions.map((assertion, index) => [assertion.ref, `A${index + 1}`]),
  );
  const selectedObjectRefs = new Set(selectedObjects.map((object) => object.ref));
  const connections = compact.connections.filter((connection) =>
    selectedAssertionRefs.has(connection.assertionRef) &&
    selectedObjectRefs.has(connection.objectRef)
  ).map((connection) => ({
    assertionRef: localAssertionRefByOldRef.get(connection.assertionRef)!,
    objectRef: localObjectRefByOldRef.get(connection.objectRef)!,
  }));
  return {
    ...compact,
    objects: selectedObjects.map((object) => ({
      ...object,
      ref: localObjectRefByOldRef.get(object.ref)!,
    })),
    assertions: selectedAssertions.map((assertion) => ({
      ...assertion,
      ref: localAssertionRefByOldRef.get(assertion.ref)!,
    })),
    connections,
    truncated: {
      objects: compact.truncated.objects || compact.objects.length > selectedObjects.length,
      assertions: compact.truncated.assertions || compact.assertions.length > selectedAssertions.length,
    },
  };
}

/**
 * Run the existing Locate pipeline as a bounded, serializable AI tool result.
 * SourceBlock content is deliberately omitted; sources are provenance anchors only.
 */
export async function searchMemory(
  intent: string | MemorySearchIntent,
  runtime: MemoryExploreRuntime = {},
): Promise<MemoryExploreResult> {
  const normalizedQuery = requiredText(
    typeof intent === "string" ? intent : intent.query,
    "query",
    QUERY_CHAR_LIMIT,
  );
  const targetHints = (typeof intent === "string" ? [] : intent.targetHints ?? [])
    .map((hint) => requiredText(hint, "targetHint", 200))
    .slice(0, 8);
  const targetObjectIds = (typeof intent === "string" ? [] : intent.targetObjectIds ?? [])
    .map((id) => requiredText(id, "targetObjectId", 200))
    .slice(0, 3);
  const taskShape: MemorySearchTaskShape = typeof intent === "string"
    ? "fact"
    : intent.taskShape ?? "fact";
  throwIfAborted(runtime.signal);
  const targetFacets = targetHints.map((text, index) => ({
      id: `facet-target-${index + 1}`,
      text,
      source: "query" as const,
    }));
  const retrieval = await getMemoryRetriever().retrieve({
    query: normalizedQuery,
    ...(targetFacets.length ? { objectFacets: targetFacets } : {}),
    signal: runtime.signal,
  });
  throwIfAborted(runtime.signal);
  runtime.onLocate?.(retrieval);
  let rawCompact = compactLocatedSeedMap(retrieval.seedMap, SEARCH_ASSERTION_LIMIT);
  if (targetObjectIds.length) {
    const missingTargetIds = targetObjectIds.filter((id) =>
      !rawCompact.objects.some((object) => object.id === id)
    );
    if (missingTargetIds.length) {
      const loadedTargets = await loadGlobalObjects(missingTargetIds);
      rawCompact = {
        ...rawCompact,
        objects: [
          ...loadedTargets.map((object, index) => compactObject({
            ref: `OT${index + 1}`,
            ...object,
            lexicalMatch: true,
            semanticMatch: false,
          })),
          ...rawCompact.objects,
        ],
      };
    }
  }
  const target = resolveTargetObjectIds({
    objects: rawCompact.objects,
    targetHints,
    explicitTargetObjectIds: targetObjectIds,
  });
  const targetIds = target.ids;
  const targetSelectionRequested = targetHints.length > 0 || targetObjectIds.length > 0;
  const higherMemoryPreference = runtime.preferHigherMemory === false ||
      retrieval.mode !== "object-assertion"
    ? {
        compact: rawCompact,
        staleObjectIds: [] as string[],
        newerAssertionIds: [] as string[],
      }
    : await preferObjectHigherMemories(rawCompact, targetIds);
  if (higherMemoryPreference.newerAssertionIds.length) {
    rawCompact = await appendAssertionsToCompact(
      rawCompact,
      higherMemoryPreference.newerAssertionIds,
    );
  }
  const preferredHigherMemories = (higherMemoryPreference.compact as typeof rawCompact & {
    higherMemories?: MemoryHigherMemorySeed[];
  }).higherMemories;
  const operationalNavigation = preferredHigherMemories?.length
    ? await operationalIndexAssertionIds({
        query: normalizedQuery,
        higherMemories: preferredHigherMemories,
      })
    : { assertionIds: [], aspectKeys: [] };
  if (operationalNavigation.assertionIds.length) {
    rawCompact = await appendAssertionsToCompact(
      rawCompact,
      operationalNavigation.assertionIds,
    );
  }
  const higherMemoryObjectIds = new Set(
    (preferredHigherMemories ?? []).map((memory) => memory.globalObjectId),
  );
  const coldTargetId = runtime.preferHigherMemory !== false && targetIds.length === 1 &&
      !higherMemoryObjectIds.has(targetIds[0])
    ? targetIds[0]
    : undefined;
  const synthesisTargetId = targetIds.length === 1 ? targetIds[0] : undefined;
  let coldBootstrapApplied = false;
  if (taskShape === "synthesis" && synthesisTargetId) {
    const linkedAssertionIds = await targetLinkedAssertionIds(
      synthesisTargetId,
      normalizedQuery,
    );
    if (linkedAssertionIds.length) {
      rawCompact = await appendAssertionsToCompact(
        rawCompact,
        linkedAssertionIds,
      );
      coldBootstrapApplied = coldTargetId === synthesisTargetId;
    }
  }
  const higherMemoryCompact: typeof rawCompact & {
    higherMemories?: MemoryHigherMemorySeed[];
  } = {
    ...rawCompact,
    ...(preferredHigherMemories
      ? { higherMemories: preferredHigherMemories }
      : {}),
  };
  const staleHigherMemoryObjectIds = new Set(higherMemoryPreference.staleObjectIds);
  const targetCandidates = targetIds.length
    ? targetConstrainedCandidates(rawCompact, targetIds)
    : [];
  const rankedCandidates = taskShape === "synthesis"
    ? rankSynthesisCandidates(normalizedQuery, targetCandidates)
    : targetCandidates;
  const selectedAssertionIds = rankedCandidates
    .slice(0, SEARCH_ASSERTION_LIMIT)
    .flatMap((assertion) => assertion.id ? [assertion.id] : []);
  let compact: typeof higherMemoryCompact = targetIds.length && targetSelectionRequested
    ? filterCompactResult(rawCompact, targetIds, selectedAssertionIds)
    : targetSelectionRequested
      ? { ...rawCompact, assertions: [], connections: [] }
      : higherMemoryCompact;
  if (higherMemoryCompact.higherMemories?.length) {
    compact = {
      ...compact,
      higherMemories: higherMemoryCompact.higherMemories,
    };
  }
  const higherMemoryNotice = compact.higherMemories?.length
    ? [staleHigherMemoryObjectIds.size
        ? "Higher Memory 维护后出现了新的关联 Assertion；已同时返回本次检索命中的 Assertions。在 Higher Memory 下次维护完成前，回答当前状态时必须优先核对较新的 Assertion。"
        : "已返回目标的 Cognitive Higher Memory 与 Operational Memory Index 作为定向和导航；当前 query 仍独立检索/筛选 Assertions，Higher Memory 本身不代表问题已完整覆盖。"]
    : [];
  const coldObjectNotice = coldTargetId
    ? [coldBootstrapApplied
        ? "目标 Object 尚无 Higher Memory；本次 synthesis 检索已补充 Object 关联 Assertion 与来源入口。单次 query 的 coverage 不代表整个知识库覆盖。"
        : "目标 Object 尚无 Higher Memory；当前是首次定向状态，单次 query 未命中不得解释为知识不存在。"]
    : [];
  const operationalIndexNotice = operationalNavigation.aspectKeys.length
    ? [operationalNavigation.assertionIds.length
        ? `Operational Memory Index 已按当前 query 使用主题 ${operationalNavigation.aspectKeys.join("、")} 补充候选 Assertion/Source 导航；这里只影响检索候选，不自动加载原文。`
        : `Operational Memory Index 已匹配主题 ${operationalNavigation.aspectKeys.join("、")}，但这些主题尚无可解析的 Assertion/Source 导航。`]
    : [];
  const candidateSelectionTruncated = rankedCandidates.length > selectedAssertionIds.length;
  const coverage: EvidenceCoverage = compact.higherMemories?.length && !compact.assertions.length
      ? {
          level: "partial",
          missingAspects: ["Higher Memory 仅提供对象级认知和检索导航；尚未对当前问题取得并筛选足够的 Assertion。"],
          observationComplete: false,
          contentPresence: "present",
        }
      : compact.assertions.length
        ? {
            level: taskShape === "synthesis" || compact.truncated.assertions || candidateSelectionTruncated
              ? "partial"
              : "complete",
            missingAspects: taskShape === "synthesis"
              ? ["synthesis 返回的是相关事实与原文入口，不声明已经穷尽完整资料。"]
              : compact.truncated.assertions || candidateSelectionTruncated
                ? ["当前检索仍有未返回的匹配 Assertion。"]
              : [],
            observationComplete: taskShape !== "synthesis" &&
              !compact.truncated.assertions && !candidateSelectionTruncated,
            contentPresence: "present",
          }
        : {
            level: "insufficient",
            missingAspects: [target.warning ?? "当前检索没有返回足以回答的 Assertion 或 Higher Memory。"],
            observationComplete: !compact.truncated.assertions && !compact.truncated.objects,
            contentPresence: compact.truncated.assertions || compact.truncated.objects
              ? "unknown"
              : "absent",
          };
  return resultWithCounts({
    kind: "search-memory",
    mode: retrieval.mode,
    query: normalizedQuery,
    taskShape,
    ...(targetIds.length === 1 && runtime.preferHigherMemory !== false
      ? {
          knowledgeState: {
            targetObjectId: targetIds[0],
            higherMemory: coldTargetId
              ? "absent" as const
              : staleHigherMemoryObjectIds.has(targetIds[0])
                ? "stale" as const
                : "fresh" as const,
            coldBootstrapApplied,
          },
        }
      : {}),
    ...compact,
    coverage,
    warnings: [
      ...(retrieval.trace?.warnings ?? []),
      ...(target.warning ? [target.warning] : []),
      ...higherMemoryNotice,
      ...coldObjectNotice,
      ...operationalIndexNotice,
    ],
  });
}

async function loadGlobalObjects(objectIds: string[]) {
  if (!objectIds.length) return [];
  const rows = await getDatabase().memoryGlobalObject.findMany({
    where: {
      id: { in: [...new Set(objectIds)] },
    },
    select: {
      id: true,
      globalObjectKey: true,
      canonicalName: true,
      surfaceMemberships: {
        select: {
          surfaceFormOrdinal: true,
          objectFragment: { select: { surfaceForms: true } },
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
          `GlobalObject ${row.globalObjectKey} 缺少 surface ordinal ${membership.surfaceFormOrdinal}`,
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
      surfaceForms: [...surfaceForms].sort((left, right) =>
        left.localeCompare(right, "zh-CN"),
      ),
    };
  });
}

async function loadFollowAssertions(assertionIds: string[]) {
  if (!assertionIds.length) return [];
  return getDatabase().memoryAssertion.findMany({
    where: {
      id: { in: [...new Set(assertionIds)] },
    },
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
}

function resolvedReferences(assertion: FollowAssertionRecord): ResolvedAssertionReference[] {
  return assertion.objectLinks.map(({ globalObject }) => ({
    globalObjectId: globalObject.id,
    canonicalName: globalObject.canonicalName,
  }));
}

function coverageReferences(assertion: FollowAssertionRecord): ResolvedAssertionReference[] {
  return assertion.objectCoverage.map(({ globalObject }) => ({
    globalObjectId: globalObject.id,
    canonicalName: globalObject.canonicalName,
  }));
}

function renderFollowAssertion(assertion: FollowAssertionRecord): {
  row: FollowAssertionRecord;
  renderedStatement: string;
  references: ResolvedAssertionReference[];
  associatedReferences: ResolvedAssertionReference[];
} {
  const references = resolvedReferences(assertion);
  return {
    row: assertion,
    references,
    associatedReferences: [...references, ...coverageReferences(assertion)],
    renderedStatement: renderResolvedAssertion({
      globalStatementTemplateMarkdown: assertion.globalStatementTemplateMarkdown,
      references,
      assertionKey: assertion.id,
    }),
  };
}

function assertionSources(assertion: FollowAssertionRecord): MemorySourceReference[] {
  if (assertion.sourceRegion) {
    return assertion.sourceBlockLinks.map(({ ordinal, sourceBlock }) => ({
      kind: "document",
      sourceDocumentId: sourceBlock.sourceDocumentId,
      sourceTitle: assertion.sourceRegion!.sourceDocument.title,
      sourceSha256: assertion.sourceRegion!.sourceDocument.sourceBlob.sha256,
      sourceNodeId: assertion.sourceRegion!.sourceNodeId,
      sourceRegionLabel: assertion.sourceRegion!.label,
      sourceBlockId: sourceBlock.sourceBlockId,
      ordinal,
      pages: sourceBlock.sourcePages,
    }));
  }
  return assertion.chatEvidenceLinks.map(({ ordinal, chatEvidence }) => ({
        kind: "chat",
        evidenceId: chatEvidence.id,
        actorId: chatEvidence.submittedBy.id,
        actorDisplayName: chatEvidence.submittedBy.displayName,
        submittedAt: chatEvidence.submittedAt.toISOString(),
        timezone: chatEvidence.timezone,
        ordinal,
      }));
}

function emptyFollowResult(input: {
  globalObjectId: string;
  focus?: string;
  warning: string;
}): MemoryExploreResult {
  return resultWithCounts({
    kind: "follow-object",
    mode: "object-assertion",
    globalObjectId: input.globalObjectId,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    objects: [],
    assertions: [],
    connections: [],
    truncated: { objects: false, assertions: false },
    coverage: {
      level: "insufficient",
      missingAspects: [input.warning],
      observationComplete: true,
      contentPresence: "absent",
    },
    warnings: [input.warning],
  });
}

/**
 * Follow one GlobalObject through resolved Assertion references and return the
 * GlobalObjects resolved from those Assertions. Fragments never leave this query.
 */
export async function followObject(
  globalObjectId: string,
  focus?: string,
  runtime: MemoryExploreRuntime = {},
): Promise<MemoryExploreResult> {
  const normalizedObjectId = requiredText(globalObjectId, "globalObjectId", 200);
  const normalizedFocus = optionalText(focus, "focus", FOCUS_CHAR_LIMIT);
  throwIfAborted(runtime.signal);

  throwIfAborted(runtime.signal);
  const [targetObjects, coreLinkRows, coverageRows] = await Promise.all([
    loadGlobalObjects([normalizedObjectId]),
    getDatabase().memoryAssertionObjectLink.findMany({
      where: {
        globalObjectId: normalizedObjectId,
      },
      select: { assertionId: true },
      distinct: ["assertionId"],
      orderBy: { assertionId: "asc" },
      take: FOLLOW_ASSERTION_SCAN_LIMIT + 1,
    }),
    getDatabase().memoryAssertionObjectCoverage.findMany({
      where: {
        globalObjectId: normalizedObjectId,
      },
      select: { assertionId: true },
      distinct: ["assertionId"],
      orderBy: { assertionId: "asc" },
      take: FOLLOW_ASSERTION_SCAN_LIMIT + 1,
    }),
  ]);
  throwIfAborted(runtime.signal);
  const targetObject = targetObjects[0];
  if (!targetObject) {
    return emptyFollowResult({
      globalObjectId: normalizedObjectId,
      focus: normalizedFocus,
      warning: `GlobalObject ${normalizedObjectId} 不存在于 Shared Brain`,
    });
  }
  const allAssertionIds = [...new Set([
    ...coreLinkRows.map((row) => row.assertionId),
    ...coverageRows.map((row) => row.assertionId),
  ])].sort();
  const scanTruncated = allAssertionIds.length > FOLLOW_ASSERTION_SCAN_LIMIT;
  const scannedAssertionIds = allAssertionIds.slice(0, FOLLOW_ASSERTION_SCAN_LIMIT);
  const loadedAssertions = await loadFollowAssertions(scannedAssertionIds);
  throwIfAborted(runtime.signal);

  const rankedAssertions = loadedAssertions
    .map(renderFollowAssertion)
    .map((assertion) => ({
      ...assertion,
      focusScore: normalizedFocus
        ? lexicalMatch(normalizedFocus, assertion.renderedStatement)?.score ?? 0
        : 0,
    }))
    .sort(
      (left, right) =>
        right.focusScore - left.focusScore ||
        (left.row.sourceRegion?.sourceNodeId ?? left.row.id).localeCompare(
          right.row.sourceRegion?.sourceNodeId ?? right.row.id,
        ) ||
        left.row.sourceClaimId.localeCompare(right.row.sourceClaimId),
    );
  const selectedAssertions = rankedAssertions.slice(0, FOLLOW_ASSERTION_LIMIT);
  const relatedObjectIds = new Set<string>([normalizedObjectId]);
  for (const assertion of selectedAssertions) {
    for (const reference of assertion.associatedReferences) relatedObjectIds.add(reference.globalObjectId);
  }

  const allObjects = await loadGlobalObjects([...relatedObjectIds]);
  throwIfAborted(runtime.signal);
  const orderedObjects = allObjects
    .sort(
      (left, right) =>
        Number(right.id === normalizedObjectId) - Number(left.id === normalizedObjectId) ||
        left.canonicalName.localeCompare(right.canonicalName, "zh-CN") ||
        left.id.localeCompare(right.id),
    );
  const selectedObjects = orderedObjects.slice(0, OBJECT_LIMIT);
  const objectRefById = new Map(
    selectedObjects.map((object, index) => [object.id, `O${index + 1}`]),
  );
  const assertionRefById = new Map(
    selectedAssertions.map((assertion, index) => [assertion.row.id, `A${index + 1}`]),
  );

  const objects = selectedObjects.map((object) => compactObject({
    ref: objectRefById.get(object.id)!,
    ...object,
    lexicalMatch: false,
    semanticMatch: selectedAssertions.some((assertion) =>
      assertion.associatedReferences.some((reference) => reference.globalObjectId === object.id),
    ),
  }));
  const assertions = selectedAssertions.map((assertion) => compactAssertion({
    ref: assertionRefById.get(assertion.row.id)!,
    id: assertion.row.id,
    kind: assertion.row.kind,
    dereferenceRequired: assertion.row.kind === "reference",
    ...(assertion.row.sourceRegion
      ? { sourceNodeId: assertion.row.sourceRegion.sourceNodeId }
      : {}),
    sourceClaimId: assertion.row.sourceClaimId,
    renderedStatement: assertion.renderedStatement,
    contextDependent: assertion.row.contextDependent,
    sources: assertionSources(assertion.row),
  }));
  const connections: MemoryObjectAssertionConnection[] = [];
  const seenConnections = new Set<string>();
  for (const assertion of selectedAssertions) {
    const assertionRef = assertionRefById.get(assertion.row.id)!;
    for (const objectId of new Set(assertion.references.map((reference) => reference.globalObjectId))) {
      const objectRef = objectRefById.get(objectId);
      if (!objectRef) continue;
      const key = `${assertionRef}\u0000${objectRef}`;
      if (seenConnections.has(key)) continue;
      seenConnections.add(key);
      connections.push({ assertionRef, objectRef });
    }
  }

  return resultWithCounts({
    kind: "follow-object",
    mode: "object-assertion",
    globalObjectId: normalizedObjectId,
    ...(normalizedFocus === undefined ? {} : { focus: normalizedFocus }),
    objects,
    assertions,
    connections,
    truncated: {
      objects: orderedObjects.length > selectedObjects.length,
      assertions:
        scanTruncated || rankedAssertions.length > selectedAssertions.length,
    },
    coverage: assertions.length
        ? {
            level: scanTruncated || rankedAssertions.length > selectedAssertions.length
              ? "partial"
              : "complete",
            missingAspects: scanTruncated || rankedAssertions.length > selectedAssertions.length
              ? ["当前 Object 仍有未返回的关联 Assertion。"]
              : [],
            observationComplete: !scanTruncated &&
              rankedAssertions.length <= selectedAssertions.length,
            contentPresence: "present",
          }
        : {
            level: "insufficient",
            missingAspects: ["当前 Object 没有返回足以回答的关联 Assertion。"],
            observationComplete: !scanTruncated,
            contentPresence: scanTruncated ? "unknown" : "absent",
          },
    warnings: [
      ...(scanTruncated
        ? [`仅扫描了前 ${FOLLOW_ASSERTION_SCAN_LIMIT} 个关联 Assertion`]
        : []),
    ],
  });
}

export const memoryExploreLimits = {
  queryChars: QUERY_CHAR_LIMIT,
  focusChars: FOCUS_CHAR_LIMIT,
  searchAssertions: SEARCH_ASSERTION_LIMIT,
  followAssertions: FOLLOW_ASSERTION_LIMIT,
  objects: OBJECT_LIMIT,
  followAssertionScan: FOLLOW_ASSERTION_SCAN_LIMIT,
  surfaceFormsPerObject: SURFACE_FORM_LIMIT,
  sourcesPerAssertion: SOURCE_LIMIT_PER_ASSERTION,
} as const;
