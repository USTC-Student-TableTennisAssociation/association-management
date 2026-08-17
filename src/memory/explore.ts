import { getDatabase } from "@/db";
import { lexicalMatch } from "@/memory/database-locate";
import {
  renderResolvedAssertion,
  ResolvedAssertionIntegrityError,
  type ResolvedAssertionReference,
} from "@/memory/resolved-assertion";
import { getMemoryRetriever } from "@/memory/retriever";
import {
  curateRetrievalAssertions,
  resolveRetrievalTargets,
  type AssertionCuration,
  type RetrievalCuratorContext,
} from "@/memory/retrieval-curator";
import type {
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
const QUERY_CHAR_LIMIT = 500;
const FOCUS_CHAR_LIMIT = 300;

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
  compilationId?: string;
  query?: string;
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
  warnings: string[];
};

export type MemoryExploreRuntime = {
  signal?: AbortSignal;
  /** Main chat prefers Higher Memory; background fact agents explicitly disable it. */
  preferHigherMemory?: boolean;
  /** Main chat passes full semantic conversation; background agents omit it. */
  curatorContext?: RetrievalCuratorContext;
  /** Human-readable trace for target selection and assertion filtering. */
  curatorTrace?: import("@/ai/debug-trace").EchoDebugTrace;
  /** Keeps verbose Locate diagnostics out of the model-visible tool result. */
  onLocate?: (retrieval: MemoryRetrievalResult) => void;
};

export type MemorySearchIntent = {
  query: string;
  targetHints?: string[];
  targetObjectIds?: string[];
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
          ...(source.kind ? { kind: source.kind } : {}),
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
  compilationId: string | undefined,
  compact: Pick<MemoryExploreResult, "sourceTime" | "objects" | "assertions" | "connections" | "truncated">,
  targetObjectIds: string[],
): Promise<{
  compact: typeof compact & { higherMemories?: MemoryHigherMemorySeed[] };
  staleObjectIds: string[];
  newerAssertionIds: string[];
}> {
  if (!compilationId || !targetObjectIds.length) {
    return { compact, staleObjectIds: [], newerAssertionIds: [] };
  }
  const database = getDatabase();
  const rows = await database.memoryObjectHigherMemory.findMany({
    where: {
      compilationId,
      globalObjectId: { in: targetObjectIds },
    },
    select: {
      id: true,
      globalObjectId: true,
      contentMarkdown: true,
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
      compilationId,
      createdAt: { gt: earliestMaintainedAt },
      OR: [
        { literalGlobalReferences: { some: { globalObjectId: { in: higherMemoryObjectIds } } } },
        {
          fragmentReferences: {
            some: {
              globalResolutions: {
                some: { globalObjectId: { in: higherMemoryObjectIds } },
              },
            },
          },
        },
        { semanticObjectLinks: { some: { globalObjectId: { in: higherMemoryObjectIds } } } },
      ],
    },
    select: {
      id: true,
      createdAt: true,
      literalGlobalReferences: { select: { globalObjectId: true } },
      fragmentReferences: {
        select: {
          globalResolutions: { select: { globalObjectId: true } },
        },
      },
      semanticObjectLinks: { select: { globalObjectId: true } },
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
    const associatedObjectIds = new Set([
      ...assertion.literalGlobalReferences.map((reference) => reference.globalObjectId),
      ...assertion.fragmentReferences.flatMap((reference) =>
        reference.globalResolutions.map((resolution) => resolution.globalObjectId)
      ),
      ...assertion.semanticObjectLinks.map((link) => link.globalObjectId),
    ]);
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
        contentMarkdown: memory.contentMarkdown,
        maintainedAt: memory.maintainedAt.toISOString(),
      })),
    },
    staleObjectIds: [...staleObjectIds],
    newerAssertionIds,
  };
}

/** Ensure post-maintenance Assertions are Curator candidates even if Locate rank is low. */
async function appendAssertionsToCompact(
  compilationId: string,
  compact: Pick<MemoryExploreResult, "sourceTime" | "objects" | "assertions" | "connections" | "truncated">,
  assertionIds: string[],
): Promise<typeof compact> {
  const existingAssertionIds = new Set(compact.assertions.flatMap((assertion) =>
    assertion.id ? [assertion.id] : []
  ));
  const missingIds = assertionIds.filter((id) => !existingAssertionIds.has(id));
  if (!missingIds.length) return compact;

  const loaded = await loadFollowAssertions(compilationId, missingIds);
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
  const addedObjects = await loadGlobalObjects(compilationId, missingObjectIds);
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

function curatorObject(object: MemoryExploreObject) {
  return {
    id: object.id,
    canonicalName: object.canonicalName,
    surfaceForms: object.surfaceForms,
    lexicalMatch: object.lexicalMatch,
    semanticMatch: object.semanticMatch,
  };
}

function sourceSummary(assertion: MemoryExploreAssertion): string[] {
  return assertion.sources.map((source) => source.kind === "chat"
    ? `chat:${source.submittedAt}:${source.actorDisplayName}`
    : `document:${source.sourceTitle}:${source.sourceRegionLabel}:pages=${source.pages.join(",")}`
  );
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
    .slice(0, 3);
  const targetObjectIds = (typeof intent === "string" ? [] : intent.targetObjectIds ?? [])
    .map((id) => requiredText(id, "targetObjectId", 200))
    .slice(0, 3);
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
  const compilationId = retrieval.compilationId ?? retrieval.trace?.snapshot.id;
  const useCurator = runtime.curatorContext !== undefined && retrieval.mode === "object-assertion";
  // Curator receives a wider internal candidate pool, while legacy/background
  // callers keep the existing bounded output unchanged.
  let rawCompact = compactLocatedSeedMap(
    retrieval.seedMap,
    useCurator ? 20 : SEARCH_ASSERTION_LIMIT,
  );
  if (useCurator && compilationId && targetObjectIds.length) {
    const missingTargetIds = targetObjectIds.filter((id) =>
      !rawCompact.objects.some((object) => object.id === id)
    );
    if (missingTargetIds.length) {
      const loadedTargets = await loadGlobalObjects(compilationId, missingTargetIds);
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
  const target = useCurator
    ? await resolveRetrievalTargets({
        query: normalizedQuery,
        targetHints,
        explicitTargetObjectIds: targetObjectIds,
        candidates: rawCompact.objects.map(curatorObject),
        context: runtime.curatorContext,
        signal: runtime.signal,
        trace: runtime.curatorTrace,
      })
    : {
        targetObjectIds: rawCompact.objects.slice(0, 1).map((object) => object.id),
        mode: "fallback" as const,
        reasons: [],
        candidateObjectIds: rawCompact.objects.map((object) => object.id),
      };
  const targetIds = target.targetObjectIds;
  const higherMemoryPreference = runtime.preferHigherMemory === false ||
      retrieval.mode !== "object-assertion"
    ? {
        compact: rawCompact,
        staleObjectIds: [] as string[],
        newerAssertionIds: [] as string[],
      }
    : await preferObjectHigherMemories(compilationId, rawCompact, targetIds);
  if (compilationId && higherMemoryPreference.newerAssertionIds.length) {
    rawCompact = await appendAssertionsToCompact(
      compilationId,
      rawCompact,
      higherMemoryPreference.newerAssertionIds,
    );
  }
  const preferredHigherMemories = (higherMemoryPreference.compact as typeof rawCompact & {
    higherMemories?: MemoryHigherMemorySeed[];
  }).higherMemories;
  const higherMemoryCompact: typeof rawCompact & {
    higherMemories?: MemoryHigherMemorySeed[];
  } = {
    ...rawCompact,
    ...(preferredHigherMemories
      ? { higherMemories: preferredHigherMemories }
      : {}),
  };
  const staleHigherMemoryObjectIds = new Set(higherMemoryPreference.staleObjectIds);
  const higherMemoryTargetIds = new Set(
    higherMemoryCompact.higherMemories?.map((memory) => memory.globalObjectId) ?? [],
  );
  const assertionTargetIds = targetIds.filter((id) =>
    !higherMemoryTargetIds.has(id) || staleHigherMemoryObjectIds.has(id)
  );
  let assertionCuration: AssertionCuration | undefined;
  let compact: typeof higherMemoryCompact = higherMemoryCompact;
  if (assertionTargetIds.length && useCurator) {
    const candidateAssertions = targetConstrainedCandidates(rawCompact, assertionTargetIds);
    assertionCuration = await curateRetrievalAssertions({
      query: normalizedQuery,
      targetHints,
      targetObjects: rawCompact.objects
        .filter((object) => assertionTargetIds.includes(object.id))
        .map(curatorObject),
      candidates: candidateAssertions.flatMap((assertion) => assertion.id ? [{
        id: assertion.id,
        renderedStatement: assertion.renderedStatement,
        kind: assertion.kind,
        contextDependent: assertion.contextDependent,
        sourceSummary: sourceSummary(assertion),
      }] : []),
      context: runtime.curatorContext,
      signal: runtime.signal,
      trace: runtime.curatorTrace,
    });
    compact = filterCompactResult(
      rawCompact,
      targetIds,
      assertionCuration.selectedAssertionIds,
    );
    if (higherMemoryCompact.higherMemories?.length) {
      compact = {
        ...compact,
        higherMemories: higherMemoryCompact.higherMemories,
      };
    }
  } else if (
    higherMemoryCompact.higherMemories?.length &&
    staleHigherMemoryObjectIds.size === 0
  ) {
    compact = {
      ...higherMemoryCompact,
      objects: higherMemoryCompact.objects.filter((object) => targetIds.includes(object.id)),
      assertions: [],
      connections: [],
      truncated: {
        ...higherMemoryCompact.truncated,
        assertions:
          higherMemoryCompact.truncated.assertions ||
          higherMemoryCompact.assertions.length > 0,
      },
    };
  }
  const higherMemoryNotice = compact.higherMemories?.length
    ? [staleHigherMemoryObjectIds.size
        ? "Higher Memory 维护后出现了新的关联 Assertion；已同时返回本次检索命中的 Assertions。在 Higher Memory 下次维护完成前，回答当前状态时必须优先核对较新的 Assertion。"
        : assertionTargetIds.length
          ? "已优先返回有记录目标的完整 Higher Memory；Assertions 只来自尚无 Higher Memory 的其他目标。"
          : "已优先返回完整 Higher Memory；普通 Assertions 本次未进入上下文，需要细节、来源或未覆盖信息时请显式 followObject。"]
    : [];
  const coverageNotice = assertionCuration
    ? [
        `Retrieval Curator 覆盖判断：${assertionCuration.coverage}。` +
          (assertionCuration.missingAspects.length
            ? ` 未覆盖：${assertionCuration.missingAspects.join("；")}`
            : ""),
      ]
    : [];
  return resultWithCounts({
    kind: "search-memory",
    mode: retrieval.mode,
    ...(compilationId ? { compilationId } : {}),
    query: normalizedQuery,
    ...compact,
    warnings: [
      ...(retrieval.trace?.warnings ?? []),
      ...(target.warning ? [target.warning] : []),
      ...(assertionCuration?.warning ? [assertionCuration.warning] : []),
      ...higherMemoryNotice,
      ...coverageNotice,
    ],
  });
}

async function latestCompilation(): Promise<{ id: string; sourceTime: MemorySourceTime }> {
  const compilation = await getDatabase().memoryCompilation.findFirst({
    orderBy: { importedAt: "desc" },
    select: {
      id: true,
      sourceTitle: true,
      sourceSha256: true,
      sourceTimeText: true,
      sourceTimeSupportingBlockIds: true,
    },
  });
  if (!compilation) throw new Error("数据库中没有来源语义 Compilation");
  const evidence = compilation.sourceTimeSupportingBlockIds.length
    ? await getDatabase().memorySourceBlock.findMany({
        where: {
          compilationId: compilation.id,
          sourceBlockId: { in: compilation.sourceTimeSupportingBlockIds },
        },
        select: { sourceBlockId: true, sourcePages: true },
      })
    : [];
  const byId = new Map(evidence.map((item) => [item.sourceBlockId, item]));
  return {
    id: compilation.id,
    sourceTime: {
      sourceTitle: compilation.sourceTitle,
      sourceSha256: compilation.sourceSha256,
      text: compilation.sourceTimeText,
      supportingBlocks: compilation.sourceTimeSupportingBlockIds.map((sourceBlockId) => {
        const block = byId.get(sourceBlockId);
        if (!block) throw new Error(`Source Time evidence block 不存在：${sourceBlockId}`);
        return { sourceBlockId, pages: block.sourcePages };
      }),
    },
  };
}

async function loadGlobalObjects(compilationId: string, objectIds: string[]) {
  if (!objectIds.length) return [];
  const rows = await getDatabase().memoryGlobalObject.findMany({
    where: {
      compilationId,
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

async function loadFollowAssertions(compilationId: string, assertionIds: string[]) {
  if (!assertionIds.length) return [];
  return getDatabase().memoryAssertion.findMany({
    where: {
      compilationId,
      id: { in: [...new Set(assertionIds)] },
    },
    select: {
      id: true,
      sourceClaimId: true,
      kind: true,
      globalStatementTemplateMarkdown: true,
      contextDependent: true,
      compilation: { select: { sourceTitle: true, sourceSha256: true } },
      sourceRegion: {
        select: {
          sourceNodeId: true,
          label: true,
          sourceTitle: true,
          sourceSha256: true,
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
      fragmentReferences: {
        orderBy: { ordinal: "asc" },
        select: {
          ordinal: true,
          objectFragment: { select: { sourceFragmentId: true } },
          globalResolutions: {
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
      },
      literalGlobalReferences: {
        orderBy: { globalOrdinal: "asc" },
        select: {
          globalObject: {
            select: {
              id: true,
              canonicalName: true,
            },
          },
        },
      },
      semanticObjectLinks: {
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
  const assertionKey = assertion.id;
  const fragmentReferences = assertion.fragmentReferences.map((reference) => {
    if (reference.globalResolutions.length !== 1) {
      throw new ResolvedAssertionIntegrityError(
        `Assertion ${assertionKey} 的 reference ordinal ${reference.ordinal} ` +
          `需要唯一 GlobalObject resolution，实际为 ${reference.globalResolutions.length}`,
      );
    }
    const globalObject = reference.globalResolutions[0].globalObject;
    return {
      globalObjectId: globalObject.id,
      canonicalName: globalObject.canonicalName,
    };
  });
  const literalReferences = assertion.literalGlobalReferences.map(({ globalObject }) => ({
    globalObjectId: globalObject.id,
    canonicalName: globalObject.canonicalName,
  }));
  return [...fragmentReferences, ...literalReferences];
}

function semanticReferences(assertion: FollowAssertionRecord): ResolvedAssertionReference[] {
  return assertion.semanticObjectLinks.map(({ globalObject }) => ({
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
    associatedReferences: [...references, ...semanticReferences(assertion)],
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
      sourceTitle: assertion.sourceRegion!.sourceTitle ?? assertion.compilation.sourceTitle,
      sourceSha256: assertion.sourceRegion!.sourceSha256 ?? assertion.compilation.sourceSha256,
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
  compilationId: string;
  globalObjectId: string;
  focus?: string;
  sourceTime: MemorySourceTime;
  warning: string;
}): MemoryExploreResult {
  return resultWithCounts({
    kind: "follow-object",
    mode: "object-assertion",
    compilationId: input.compilationId,
    globalObjectId: input.globalObjectId,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    sourceTime: input.sourceTime,
    objects: [],
    assertions: [],
    connections: [],
    truncated: { objects: false, assertions: false },
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

  const compilation = await latestCompilation();
  const compilationId = compilation.id;
  throwIfAborted(runtime.signal);
  const [targetObjects, fragmentResolutionRows, literalReferenceRows, semanticLinkRows] = await Promise.all([
    loadGlobalObjects(compilationId, [normalizedObjectId]),
    getDatabase().memoryGlobalAssertionReferenceResolution.findMany({
      where: {
        globalObjectId: normalizedObjectId,
        globalObject: { compilationId },
      },
      select: { assertionId: true },
      distinct: ["assertionId"],
      orderBy: { assertionId: "asc" },
      take: FOLLOW_ASSERTION_SCAN_LIMIT + 1,
    }),
    getDatabase().memoryGlobalAssertionLiteralReference.findMany({
      where: {
        globalObjectId: normalizedObjectId,
        globalObject: { compilationId },
      },
      select: { assertionId: true },
      distinct: ["assertionId"],
      orderBy: { assertionId: "asc" },
      take: FOLLOW_ASSERTION_SCAN_LIMIT + 1,
    }),
    getDatabase().memoryAssertionSemanticObjectLink.findMany({
      where: {
        globalObjectId: normalizedObjectId,
        globalObject: { compilationId },
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
      compilationId,
      globalObjectId: normalizedObjectId,
      focus: normalizedFocus,
      sourceTime: compilation.sourceTime,
      warning: `GlobalObject ${normalizedObjectId} 不存在于当前 Compilation`,
    });
  }
  const allAssertionIds = [...new Set([
    ...fragmentResolutionRows.map((row) => row.assertionId),
    ...literalReferenceRows.map((row) => row.assertionId),
    ...semanticLinkRows.map((row) => row.assertionId),
  ])].sort();
  const scanTruncated = allAssertionIds.length > FOLLOW_ASSERTION_SCAN_LIMIT;
  const scannedAssertionIds = allAssertionIds.slice(0, FOLLOW_ASSERTION_SCAN_LIMIT);
  const loadedAssertions = await loadFollowAssertions(compilationId, scannedAssertionIds);
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
  let selectedAssertions = rankedAssertions.slice(0, FOLLOW_ASSERTION_LIMIT);
  let assertionCuration: AssertionCuration | undefined;
  if (runtime.curatorContext) {
    const candidateAssertions = rankedAssertions.slice(0, 20);
    assertionCuration = await curateRetrievalAssertions({
      query: normalizedFocus ?? runtime.curatorContext.originalUserMessage,
      targetHints: [targetObject.canonicalName],
      targetObjects: [{
        id: targetObject.id,
        canonicalName: targetObject.canonicalName,
        surfaceForms: targetObject.surfaceForms,
        lexicalMatch: true,
        semanticMatch: true,
      }],
      candidates: candidateAssertions.map((assertion) => ({
        id: assertion.row.id,
        renderedStatement: assertion.renderedStatement,
        kind: assertion.row.kind,
        contextDependent: assertion.row.contextDependent,
        sourceSummary: assertionSources(assertion.row).map((source) => source.kind === "chat"
          ? `chat:${source.submittedAt}:${source.actorDisplayName}`
          : `document:${source.sourceTitle}:${source.sourceRegionLabel}:pages=${source.pages.join(",")}`
        ),
      })),
      context: runtime.curatorContext,
      signal: runtime.signal,
      trace: runtime.curatorTrace,
    });
    const selectedIds = new Set(assertionCuration.selectedAssertionIds);
    selectedAssertions = candidateAssertions.filter((assertion) => selectedIds.has(assertion.row.id));
  }
  const relatedObjectIds = new Set<string>([normalizedObjectId]);
  for (const assertion of selectedAssertions) {
    for (const reference of assertion.associatedReferences) relatedObjectIds.add(reference.globalObjectId);
  }

  const allObjects = await loadGlobalObjects(compilationId, [...relatedObjectIds]);
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
    for (const objectId of new Set(assertion.associatedReferences.map((reference) => reference.globalObjectId))) {
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
    compilationId,
    globalObjectId: normalizedObjectId,
    ...(normalizedFocus === undefined ? {} : { focus: normalizedFocus }),
    sourceTime: compilation.sourceTime,
    objects,
    assertions,
    connections,
    truncated: {
      objects: orderedObjects.length > selectedObjects.length,
      assertions:
        scanTruncated || rankedAssertions.length > selectedAssertions.length,
    },
    warnings: [
      ...(scanTruncated
        ? [`仅扫描了前 ${FOLLOW_ASSERTION_SCAN_LIMIT} 个关联 Assertion`]
        : []),
      ...(assertionCuration?.warning ? [assertionCuration.warning] : []),
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
