import { getDatabase } from "@/db";
import type { MemoryExploreResult } from "@/memory/explore";
import {
  parseCognitiveMemory,
  parseOperationalMemoryIndex,
  renderCognitiveMemory,
} from "@/memory/higher-memory-document";
import { renderResolvedAssertion } from "@/memory/resolved-assertion";

function searchable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/\.[a-z0-9]{1,10}$/iu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export async function findArtifactsByTitle(input: {
  title: string;
  limit?: number;
}) {
  const title = searchable(input.title);
  if (!title) throw new Error("文件标题不能为空");
  const rows = await getDatabase().libraryNode.findMany({
    where: { kind: "file" },
    select: {
      id: true,
      name: true,
      originalRelativePath: true,
      processingProfile: true,
      processingStatus: true,
      blob: {
        select: {
          id: true,
          mimeType: true,
          processingRuns: {
            where: { isCurrent: true },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              profile: true,
              status: true,
              stage: true,
              publishedAt: true,
              publishedAssertionCount: true,
              publishedObjectCount: true,
            },
          },
        },
      },
    },
  });
  const matched = rows.flatMap((row) => {
    const name = searchable(row.name);
    const path = searchable(row.originalRelativePath ?? "");
    const match = name === title
      ? { score: 0, matchKind: "exact_title" as const }
      : name.includes(title)
        ? { score: 1, matchKind: "title_contains" as const }
        : path.includes(title)
          ? { score: 2, matchKind: "path_contains" as const }
          : title.includes(name) && name.length >= 6
            ? { score: 3, matchKind: "query_contains_title" as const }
            : undefined;
    return match === undefined ? [] : [{ row, ...match }];
  }).sort((left, right) =>
    left.score - right.score || left.row.name.localeCompare(right.row.name, "zh-CN")
  );
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  return {
    queryTitle: input.title,
    matchedCount: matched.length,
    returnedCount: Math.min(matched.length, limit),
    truncated: matched.length > limit,
    items: matched.slice(0, limit).map(({ row, matchKind }) => {
      const run = row.blob?.processingRuns[0];
      return {
        nodeId: row.id,
        name: row.name,
        path: row.originalRelativePath,
        matchKind,
        mimeType: row.blob?.mimeType,
        profile: row.processingProfile,
        status: row.processingStatus,
        compilation: run
          ? {
              runId: run.id,
              profile: run.profile,
              status: run.status,
              stage: run.stage,
              publishedAt: run.publishedAt?.toISOString() ?? null,
              publishedAssertionCount: run.publishedAssertionCount,
              publishedObjectCount: run.publishedObjectCount,
              sharedBrainStatus: run.publishedAt
                ? "published" as const
                : "not_published" as const,
            }
          : {
              publishedAt: null,
              publishedAssertionCount: 0,
              publishedObjectCount: 0,
              sharedBrainStatus: "not_published" as const,
            },
      };
    }),
  };
}

export async function getArtifactPublishedKnowledge(input: {
  nodeId: string;
  query?: string;
  assertionLimit?: number;
  cursor?: number;
  includeHigherMemory?: boolean;
  includeConnections?: boolean;
}): Promise<{
  artifact: {
    nodeId: string;
    name: string;
    path: string | null;
    profile: string;
    status: string;
    publishedAt: string | null;
    publishedAssertionCount: number;
    publishedObjectCount: number;
  };
  page: {
    query: string | null;
    cursor: number;
    returnedAssertionCount: number;
    matchedAssertionCount: number;
    nextCursor: number | null;
  };
  evidence: MemoryExploreResult;
}> {
  const database = getDatabase();
  const node = await database.libraryNode.findUnique({
    where: { id: input.nodeId },
    select: {
      id: true,
      kind: true,
      name: true,
      originalRelativePath: true,
      processingProfile: true,
      processingStatus: true,
      blob: { select: { id: true } },
    },
  });
  if (!node || node.kind !== "file" || !node.blob) {
    throw new Error("资料库文件不存在或没有原始 Blob");
  }
  const run = await database.librarySourceProcessingRun.findFirst({
      where: { sourceBlobId: node.blob.id, isCurrent: true },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        publishedAt: true,
        publishedAssertionCount: true,
        publishedObjectCount: true,
      },
    });
  const regions = await database.memorySourceRegion.findMany({
    where: {
      sourceDocument: {
        sourceBlobId: node.blob.id,
      },
    },
    orderBy: [{ sourceNodeId: "asc" }, { id: "asc" }],
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
      assertions: {
        orderBy: [{ sourceClaimId: "asc" }, { id: "asc" }],
        select: {
          id: true,
          kind: true,
          sourceClaimId: true,
          globalStatementTemplateMarkdown: true,
          contextDependent: true,
          sourceBlockLinks: {
            orderBy: { ordinal: "asc" },
            select: {
              ordinal: true,
              sourceBlock: {
                select: { sourceBlockId: true, sourcePages: true },
              },
            },
          },
          objectLinks: {
            select: { globalObjectId: true },
          },
          objectCoverage: {
            select: { globalObjectId: true },
          },
        },
      },
    },
  });
  const allAssertions = regions.flatMap((region) =>
    region.assertions.map((assertion) => ({ region, assertion }))
  );
  const allObjectIds = [...new Set([
    ...allAssertions.flatMap(({ assertion }) =>
      [...assertion.objectLinks, ...assertion.objectCoverage]
        .map((link) => link.globalObjectId)
    ),
  ])];
  const allObjectRows = allObjectIds.length
    ? await database.memoryGlobalObject.findMany({
        where: { id: { in: allObjectIds } },
        select: {
          id: true,
          globalObjectKey: true,
          canonicalName: true,
          higherMemory: {
            select: {
              id: true,
              cognitiveMemory: true,
              operationalIndex: true,
              maintainedAt: true,
            },
          },
        },
    })
    : [];
  const objectById = new Map(allObjectRows.map((object) => [object.id, object]));

  const queryTerms = (input.query ?? "")
    .split(/[\s,，、;；/]+/u)
    .map(searchable)
    .filter(Boolean);
  const rankedAssertions = allAssertions.map((item, index) => {
    const objectNames = [...item.assertion.objectLinks, ...item.assertion.objectCoverage]
      .map((link) => objectById.get(link.globalObjectId)?.canonicalName ?? "");
    const haystack = searchable([
      item.assertion.globalStatementTemplateMarkdown,
      item.assertion.sourceClaimId,
      item.region.label,
      item.region.sourceDocument.title,
      ...objectNames,
    ].join(" "));
    const score = queryTerms.reduce(
      (total, term) => total + (haystack.includes(term) ? Math.max(1, term.length) : 0),
      0,
    );
    return { ...item, index, score };
  });
  const matchedAssertions = queryTerms.length
    ? rankedAssertions
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
    : rankedAssertions;
  const limit = Math.min(Math.max(input.assertionLimit ?? 12, 1), 40);
  const cursor = Math.min(Math.max(input.cursor ?? 0, 0), matchedAssertions.length);
  const selectedAssertions = matchedAssertions.slice(cursor, cursor + limit);
  const selectedObjectIds = [...new Set(selectedAssertions.flatMap(({ assertion }) => [
    ...assertion.objectLinks.map((link) => link.globalObjectId),
    ...assertion.objectCoverage.map((link) => link.globalObjectId),
  ]))];
  const objectRows = selectedObjectIds.flatMap((id) => {
    const object = objectById.get(id);
    return object ? [object] : [];
  });
  const objectRefById = new Map(objectRows.map((object, index) => [object.id, `O${index + 1}`]));
  const assertionRefById = new Map(
    selectedAssertions.map(({ assertion }, index) => [assertion.id, `A${index + 1}`]),
  );
  const assertions = selectedAssertions.map(({ region, assertion }) => {
    const references = assertion.objectLinks.map((link) => {
      const globalObjectId = link.globalObjectId;
      const object = objectById.get(globalObjectId);
      if (!object) throw new Error(`Assertion ${assertion.id} 引用的 Object 不存在`);
      return { globalObjectId, canonicalName: object.canonicalName };
    });
    return {
      ref: assertionRefById.get(assertion.id)!,
      id: assertion.id,
      kind: assertion.kind,
      dereferenceRequired: assertion.kind === "reference",
      sourceNodeId: region.sourceNodeId,
      sourceClaimId: assertion.sourceClaimId,
      renderedStatement: renderResolvedAssertion({
        globalStatementTemplateMarkdown: assertion.globalStatementTemplateMarkdown,
        references,
        assertionKey: assertion.id,
      }),
      contextDependent: assertion.contextDependent,
      sources: assertion.sourceBlockLinks.map((link) => ({
        kind: "document" as const,
        sourceDocumentId: region.sourceDocument.id,
        sourceTitle: region.sourceDocument.title,
        sourceSha256: region.sourceDocument.sourceBlob.sha256,
        sourceNodeId: region.sourceNodeId,
        sourceRegionLabel: region.label,
        sourceBlockId: link.sourceBlock.sourceBlockId,
        ordinal: link.ordinal,
        pages: link.sourceBlock.sourcePages,
      })),
    };
  });
  const assertionsByObjectId = new Map<string, string[]>();
  for (const { assertion } of selectedAssertions) {
    const assertionRef = assertionRefById.get(assertion.id)!;
    const ids = new Set(assertion.objectLinks.map((link) => link.globalObjectId));
    for (const id of ids) {
      const refs = assertionsByObjectId.get(id) ?? [];
      refs.push(assertionRef);
      assertionsByObjectId.set(id, refs);
    }
  }
  const objects = objectRows.map((object) => ({
    ref: objectRefById.get(object.id)!,
    id: object.id,
    globalObjectKey: object.globalObjectKey,
    canonicalName: object.canonicalName,
    surfaceForms: [],
    lexicalMatch: false,
    semanticMatch: true,
  }));
  const connections = input.includeConnections === false
    ? []
    : objectRows.flatMap((object) =>
        (assertionsByObjectId.get(object.id) ?? []).map((assertionRef) => ({
          assertionRef,
          objectRef: objectRefById.get(object.id)!,
        }))
      );
  const higherMemories = input.includeHigherMemory
    ? objectRows.flatMap((object, index) => object.higherMemory
      ? [{
          ref: `H${index + 1}`,
          id: object.higherMemory.id,
          globalObjectId: object.id,
          contentMarkdown: renderCognitiveMemory(
            parseCognitiveMemory(object.higherMemory.cognitiveMemory),
          ),
          operationalIndex: parseOperationalMemoryIndex(object.higherMemory.operationalIndex),
          maintainedAt: object.higherMemory.maintainedAt.toISOString(),
        }]
      : []
    )
    : [];
  const nextCursor = cursor + selectedAssertions.length < matchedAssertions.length
    ? cursor + selectedAssertions.length
    : null;
  const publishedObjectCount = run?.publishedObjectCount ?? allObjectRows.length;
  return {
    artifact: {
      nodeId: node.id,
      name: node.name,
      path: node.originalRelativePath,
      profile: node.processingProfile,
      status: node.processingStatus,
      publishedAt: run?.publishedAt?.toISOString() ?? null,
      publishedAssertionCount: run?.publishedAssertionCount ?? 0,
      publishedObjectCount,
    },
    page: {
      query: input.query?.trim() || null,
      cursor,
      returnedAssertionCount: assertions.length,
      matchedAssertionCount: matchedAssertions.length,
      nextCursor,
    },
    evidence: {
      kind: "artifact-knowledge",
      mode: "object-assertion",
      query: input.query?.trim() || node.name,
      objects,
      ...(higherMemories.length ? { higherMemories } : {}),
      assertions,
      connections,
      counts: {
        objects: objects.length,
        assertions: assertions.length,
        connections: connections.length,
      },
      truncated: {
        objects: publishedObjectCount > objects.length || allObjectRows.length > objects.length,
        assertions: nextCursor !== null,
      },
      coverage: {
        level: !assertions.length
          ? "insufficient"
          : nextCursor !== null
            ? "partial"
            : "complete",
        missingAspects: !assertions.length
          ? [queryTerms.length
              ? "目标文件中没有检索到与当前主题匹配的已发布 Assertion。"
              : "目标文件当前没有可用于回答的已发布 Assertion。"]
          : nextCursor !== null
            ? [`仍有 ${matchedAssertions.length - cursor - assertions.length} 条匹配 Assertion 尚未读取。`]
            : [],
        observationComplete: nextCursor === null,
        contentPresence: assertions.length
          ? "present"
          : nextCursor === null
            ? "absent"
            : "unknown",
      },
      warnings: !allAssertions.length
        ? [run?.publishedAt
            ? "编译记录显示已发布，但当前 Shared Brain 未找到该 Blob 的 SourceRegion。"
            : "该文件当前没有已发布的 Shared Brain 知识。"]
        : queryTerms.length && !matchedAssertions.length
          ? ["该文件已发布知识中没有匹配当前主题的 Assertion；这不代表整个 Shared Brain 没有相关知识。"]
          : [
              ...(publishedObjectCount > objects.length
                ? [`该文件发布了 ${publishedObjectCount} 个 Object，本页只返回与所选 Assertion 相连的 ${objects.length} 个。`]
                : []),
              ...(nextCursor !== null
                ? [`仍有 ${matchedAssertions.length - cursor - assertions.length} 条匹配 Assertion，可使用 nextCursor=${nextCursor} 继续。`]
                : []),
              ...(input.includeHigherMemory
                ? ["Object Higher Memory 可能综合其他来源，只能作为关联背景，不能归因于当前文件。"]
                : []),
            ],
    },
  };
}
