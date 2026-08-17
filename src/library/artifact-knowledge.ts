import { getDatabase } from "@/db";
import type { MemoryExploreResult } from "@/memory/explore";
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
    const score = name === title
      ? 0
      : name.includes(title)
        ? 1
        : path.includes(title)
          ? 2
          : title.includes(name) && name.length >= 6
            ? 3
            : undefined;
    return score === undefined ? [] : [{ row, score }];
  }).sort((left, right) =>
    left.score - right.score || left.row.name.localeCompare(right.row.name, "zh-CN")
  );
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  return {
    queryTitle: input.title,
    matchedCount: matched.length,
    returnedCount: Math.min(matched.length, limit),
    truncated: matched.length > limit,
    items: matched.slice(0, limit).map(({ row }) => {
      const run = row.blob?.processingRuns[0];
      return {
        nodeId: row.id,
        name: row.name,
        path: row.originalRelativePath,
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
  assertionLimit?: number;
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
      blob: { select: { id: true, sha256: true } },
    },
  });
  if (!node || node.kind !== "file" || !node.blob) {
    throw new Error("资料库文件不存在或没有原始 Blob");
  }
  const [compilation, run] = await Promise.all([
    database.memoryCompilation.findFirst({
      orderBy: [{ importedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    }),
    database.librarySourceProcessingRun.findFirst({
      where: { sourceBlobId: node.blob.id, isCurrent: true },
      orderBy: { createdAt: "desc" },
      select: {
        publishedAt: true,
        publishedAssertionCount: true,
        publishedObjectCount: true,
      },
    }),
  ]);
  if (!compilation) throw new Error("Shared Brain 尚无有效 Compilation");
  const regions = await database.memorySourceRegion.findMany({
    where: {
      compilationId: compilation.id,
      sourceSha256: node.blob.sha256,
    },
    orderBy: [{ sourceNodeId: "asc" }, { id: "asc" }],
    select: {
      sourceNodeId: true,
      label: true,
      sourceTitle: true,
      sourceSha256: true,
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
          semanticObjectLinks: {
            select: { globalObjectId: true },
          },
        },
      },
    },
  });
  const allAssertions = regions.flatMap((region) =>
    region.assertions.map((assertion) => ({ region, assertion }))
  );
  const limit = Math.min(Math.max(input.assertionLimit ?? 40, 1), 80);
  const selectedAssertions = allAssertions.slice(0, limit);
  const placeholderObjectIds = selectedAssertions.flatMap(({ assertion }) =>
    [...assertion.globalStatementTemplateMarkdown.matchAll(/\{\{object:([^{}]+)\}\}/g)]
      .map((match) => match[1].trim())
  );
  const objectIds = [...new Set([
    ...placeholderObjectIds,
    ...selectedAssertions.flatMap(({ assertion }) =>
      assertion.semanticObjectLinks.map((link) => link.globalObjectId)
    ),
  ])];
  const objectRows = objectIds.length
    ? await database.memoryGlobalObject.findMany({
        where: { compilationId: compilation.id, id: { in: objectIds } },
        select: {
          id: true,
          globalObjectKey: true,
          canonicalName: true,
          higherMemory: {
            select: { id: true, contentMarkdown: true, maintainedAt: true },
          },
        },
      })
    : [];
  const objectById = new Map(objectRows.map((object) => [object.id, object]));
  const objectRefById = new Map(objectRows.map((object, index) => [object.id, `O${index + 1}`]));
  const assertionRefById = new Map(
    selectedAssertions.map(({ assertion }, index) => [assertion.id, `A${index + 1}`]),
  );
  const assertions = selectedAssertions.map(({ region, assertion }) => {
    const references = [
      ...assertion.globalStatementTemplateMarkdown.matchAll(/\{\{object:([^{}]+)\}\}/g),
    ].map((match) => {
      const globalObjectId = match[1].trim();
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
        sourceTitle: region.sourceTitle ?? node.name,
        sourceSha256: region.sourceSha256 ?? node.blob!.sha256,
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
    const ids = new Set([
      ...[...assertion.globalStatementTemplateMarkdown.matchAll(/\{\{object:([^{}]+)\}\}/g)]
        .map((match) => match[1].trim()),
      ...assertion.semanticObjectLinks.map((link) => link.globalObjectId),
    ]);
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
  const connections = objectRows.flatMap((object) =>
    (assertionsByObjectId.get(object.id) ?? []).map((assertionRef) => ({
      assertionRef,
      objectRef: objectRefById.get(object.id)!,
    }))
  );
  const higherMemories = objectRows.flatMap((object, index) =>
    object.higherMemory
      ? [{
          ref: `H${index + 1}`,
          id: object.higherMemory.id,
          globalObjectId: object.id,
          contentMarkdown: object.higherMemory.contentMarkdown,
          maintainedAt: object.higherMemory.maintainedAt.toISOString(),
        }]
      : []
  );
  return {
    artifact: {
      nodeId: node.id,
      name: node.name,
      path: node.originalRelativePath,
      profile: node.processingProfile,
      status: node.processingStatus,
      publishedAt: run?.publishedAt?.toISOString() ?? null,
      publishedAssertionCount: run?.publishedAssertionCount ?? 0,
      publishedObjectCount: run?.publishedObjectCount ?? 0,
    },
    evidence: {
      kind: "artifact-knowledge",
      mode: "object-assertion",
      compilationId: compilation.id,
      query: node.name,
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
        objects: false,
        assertions: allAssertions.length > selectedAssertions.length,
      },
      warnings: allAssertions.length
        ? []
        : [run?.publishedAt
            ? "编译记录显示已发布，但当前 Shared Brain 未找到该 Blob 的 SourceRegion。"
            : "该文件当前没有已发布的 Shared Brain 知识。"],
    },
  };
}
