import { getDatabase } from "@/db";
import { lexicalMatch } from "@/memory/database-locate";
import {
  renderResolvedAssertion,
  ResolvedAssertionIntegrityError,
  type ResolvedAssertionReference,
} from "@/memory/resolved-assertion";
import { getMemoryRetriever } from "@/memory/retriever";
import type {
  MemoryAssertionKind,
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
  kind: "search-memory" | "follow-object";
  mode: MemoryRetrievalResult["mode"];
  compilationId?: string;
  query?: string;
  globalObjectId?: string;
  focus?: string;
  sourceTime?: MemorySourceTime;
  objects: MemoryExploreObject[];
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
  /** Keeps verbose Locate diagnostics out of the model-visible tool result. */
  onLocate?: (retrieval: MemoryRetrievalResult) => void;
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

  // Preserve the resolved GlobalObjects that make the selected Assertions
  // intelligible before filling the remaining budget with lexical-only hits.
  const orderedObjectRefs: string[] = [];
  const candidateObjectRefs = new Set<string>();
  for (const assertion of selectedAssertionSeeds) {
    for (const objectRef of connectionsByAssertion.get(assertion.ref) ?? []) {
      if (candidateObjectRefs.has(objectRef)) continue;
      candidateObjectRefs.add(objectRef);
      orderedObjectRefs.push(objectRef);
    }
  }
  for (const object of seedMap.objects) {
    if (!object.lexicalMatch || candidateObjectRefs.has(object.ref)) continue;
    candidateObjectRefs.add(object.ref);
    orderedObjectRefs.push(object.ref);
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

/**
 * Run the existing Locate pipeline as a bounded, serializable AI tool result.
 * SourceBlock content is deliberately omitted; sources are provenance anchors only.
 */
export async function searchMemory(
  query: string,
  runtime: MemoryExploreRuntime = {},
): Promise<MemoryExploreResult> {
  const normalizedQuery = requiredText(query, "query", QUERY_CHAR_LIMIT);
  throwIfAborted(runtime.signal);
  const retrieval = await getMemoryRetriever().retrieve({
    query: normalizedQuery,
    signal: runtime.signal,
  });
  throwIfAborted(runtime.signal);
  runtime.onLocate?.(retrieval);
  const compact = compactLocatedSeedMap(retrieval.seedMap, SEARCH_ASSERTION_LIMIT);
  const compilationId = retrieval.compilationId ?? retrieval.trace?.snapshot.id;
  return resultWithCounts({
    kind: "search-memory",
    mode: retrieval.mode,
    ...(compilationId ? { compilationId } : {}),
    query: normalizedQuery,
    ...compact,
    warnings: retrieval.trace?.warnings ?? [],
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
      sourceRegion: { select: { sourceNodeId: true, label: true } },
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
      sourceTitle: assertion.compilation.sourceTitle,
      sourceSha256: assertion.compilation.sourceSha256,
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
  const selectedAssertions = rankedAssertions.slice(0, FOLLOW_ASSERTION_LIMIT);
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
    warnings: scanTruncated
      ? [`仅扫描了前 ${FOLLOW_ASSERTION_SCAN_LIMIT} 个关联 Assertion`]
      : [],
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
