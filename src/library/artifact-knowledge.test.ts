import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({
  libraryNodeFindUnique: vi.fn(),
  processingRunFindFirst: vi.fn(),
  sourceRegionFindMany: vi.fn(),
  globalObjectFindMany: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDatabase: () => ({
    libraryNode: { findUnique: databaseState.libraryNodeFindUnique },
    librarySourceProcessingRun: { findFirst: databaseState.processingRunFindFirst },
    memorySourceRegion: { findMany: databaseState.sourceRegionFindMany },
    memoryGlobalObject: { findMany: databaseState.globalObjectFindMany },
  }),
}));

import { getArtifactPublishedKnowledge } from "@/library/artifact-knowledge";

function assertion(id: string, objectId: string, statement: string) {
  return {
    id,
    kind: "grounded",
    sourceClaimId: `claim-${id}`,
    globalStatementTemplateMarkdown: `{{object:${objectId}}}${statement}`,
    contextDependent: false,
    sourceBlockLinks: [{
      ordinal: 0,
      sourceBlock: { sourceBlockId: `block-${id}`, sourcePages: [8] },
    }],
    objectLinks: [{ globalObjectId: objectId }],
    objectCoverage: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  databaseState.libraryNodeFindUnique.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000001",
    kind: "file",
    name: "生存手册.pdf",
    originalRelativePath: "手册/生存手册.pdf",
    processingProfile: "deep",
    processingStatus: "ready",
    blob: { id: "blob-1", sha256: "sha-1" },
  });
  databaseState.processingRunFindFirst.mockResolvedValue({
    id: "run-1",
    publishedAt: new Date("2026-08-18T00:00:00.000Z"),
    publishedAssertionCount: 3,
    publishedObjectCount: 5,
  });
  databaseState.sourceRegionFindMany.mockResolvedValue([{
    sourceNodeId: "region-1",
    label: "活动行政",
    sourceDocument: {
      id: "document-1",
      title: "生存手册",
      sourceBlob: { sha256: "sha-1" },
    },
    assertions: [
      assertion("a1", "o1", "需要提前申请体育馆并提交场地材料。"),
      assertion("a2", "o2", "负责赛事宣传和新闻稿。"),
      assertion("a3", "o3", "申请物资时需要保留票据。"),
    ],
  }]);
  databaseState.globalObjectFindMany.mockResolvedValue([
    {
      id: "o1",
      globalObjectKey: "venue-application",
      canonicalName: "校内场地申请",
      higherMemory: {
        id: "h1",
        contentMarkdown: "这段 Higher Memory 还综合了其他文件，默认不应返回。",
        maintainedAt: new Date("2026-08-18T00:00:00.000Z"),
      },
    },
    { id: "o2", globalObjectKey: "publicity", canonicalName: "赛事宣传", higherMemory: null },
    { id: "o3", globalObjectKey: "supplies", canonicalName: "物资申请", higherMemory: null },
  ]);
});

describe("getArtifactPublishedKnowledge", () => {
  it("filters by topic and excludes cross-source Higher Memory by default", async () => {
    const result = await getArtifactPublishedKnowledge({
      nodeId: "00000000-0000-4000-8000-000000000001",
      query: "体育馆 场地申请",
      assertionLimit: 12,
      includeConnections: false,
    });

    expect(result.page).toEqual({
      query: "体育馆 场地申请",
      cursor: 0,
      returnedAssertionCount: 1,
      matchedAssertionCount: 1,
      nextCursor: null,
    });
    expect(result.evidence.assertions[0].renderedStatement).toContain("体育馆");
    expect(result.evidence.higherMemories).toBeUndefined();
    expect(result.evidence.connections).toEqual([]);
    expect(result.evidence.truncated.objects).toBe(true);
    expect(result.evidence.warnings.join(" ")).toContain("发布了 5 个 Object");
  });

  it("returns a stable continuation cursor for bounded browsing", async () => {
    const first = await getArtifactPublishedKnowledge({
      nodeId: "00000000-0000-4000-8000-000000000001",
      assertionLimit: 1,
      cursor: 0,
    });
    const second = await getArtifactPublishedKnowledge({
      nodeId: "00000000-0000-4000-8000-000000000001",
      assertionLimit: 1,
      cursor: first.page.nextCursor ?? 0,
    });

    expect(first.page.nextCursor).toBe(1);
    expect(first.evidence.assertions[0].id).toBe("a1");
    expect(second.page.cursor).toBe(1);
    expect(second.evidence.assertions[0].id).toBe("a2");
  });
});
