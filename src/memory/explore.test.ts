import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDatabase } from "@/db";
import {
  followObject,
  memoryExploreLimits,
  searchMemory,
} from "@/memory/explore";
import { getMemoryRetriever } from "@/memory/retriever";

vi.mock("@/db", () => ({ getDatabase: vi.fn() }));
vi.mock("@/memory/retriever", () => ({ getMemoryRetriever: vi.fn() }));

function locatedSeedMap() {
  const objects = Array.from({ length: 18 }, (_, index) => ({
    ref: `O${index + 1}`,
    id: `global-${index + 1}`,
    globalObjectKey: `global-key-${index + 1}`,
    canonicalName: `Global Object ${index + 1}`,
    surfaceForms: Array.from({ length: 10 }, (__, surfaceIndex) =>
      `surface-${index + 1}-${surfaceIndex + 1}`
    ),
    matchedBy: [],
    matchedFacets: ["facet-0"],
    supportingAssertions: index < 14 ? [`A${index + 1}`] : [],
    lexicalMatch: true,
    semanticMatch: index < 14,
  }));
  const assertions = Array.from({ length: 14 }, (_, index) => ({
    ref: `A${index + 1}`,
    id: `assertion-${index + 1}`,
    kind: "grounded" as const,
    dereferenceRequired: false,
    sourceNodeId: `source-node-${index + 1}`,
    sourceClaimId: `source-claim-${index + 1}`,
    renderedStatement: `Global Object ${index + 1} 有一条可检索 Assertion。`,
    contextDependent: false,
    matchedBy: [],
    matchedFacets: ["facet-0"],
    sources: [{
      sourceTitle: "Test source",
      sourceSha256: "sha",
      sourceNodeId: `source-node-${index + 1}`,
      sourceRegionLabel: "Test region",
      sourceBlockId: `block-${index + 1}`,
      ordinal: 0,
      pages: [1],
      excerpt: "SOURCEBLOCK_MARKDOWN_MUST_NOT_LEAVE_SEARCH",
    }],
  }));
  return {
    facets: [{ id: "facet-0", text: "query", source: "query" as const }],
    objects,
    assertions,
    connections: assertions.map((assertion, index) => ({
      assertionRef: assertion.ref,
      objectRef: objects[index].ref,
    })),
  };
}

function globalObject(
  id: string,
  globalObjectKey: string,
  canonicalName: string,
  surfaces: string[],
) {
  return {
    id,
    globalObjectKey,
    canonicalName,
    surfaceMemberships: surfaces.map((_, index) => ({
      surfaceFormOrdinal: index,
      objectFragment: { surfaceForms: surfaces },
    })),
    chatMentions: [],
  };
}

function objectLink(id: string, canonicalName: string) {
  return { globalObject: { id, canonicalName } };
}

function assertionRow(input: {
  id: string;
  kind?: "grounded" | "reference";
  statement: string;
  objectLinks?: ReturnType<typeof objectLink>[];
  objectCoverage?: ReturnType<typeof objectLink>[];
}) {
  return {
    id: input.id,
    sourceClaimId: `claim-${input.id}`,
    kind: input.kind ?? "grounded",
    globalStatementTemplateMarkdown: input.statement,
    contextDependent: input.kind === "reference",
    compilation: { sourceTitle: "生存手册", sourceSha256: "sha" },
    sourceRegion: {
      sourceNodeId: `region-${input.id}`,
      label: "来源章节",
      sourceTitle: "生存手册",
      sourceSha256: "sha",
    },
    chatEvidenceLinks: [],
    objectLinks: input.objectLinks ?? [],
    objectCoverage: input.objectCoverage ?? [],
    sourceBlockLinks: [{
      ordinal: 0,
      sourceBlock: { sourceBlockId: `block-${input.id}`, sourcePages: [3] },
    }],
  };
}

beforeEach(() => vi.clearAllMocks());

describe("searchMemory", () => {
  function useLocate(seedMap = locatedSeedMap()) {
    const retrieve = vi.fn().mockResolvedValue({
      query: "query",
      mode: "object-assertion",
      compilationId: "compilation-current",
      seedMap,
      trace: {
        snapshot: { id: "compilation-current" },
        warnings: ["vector degraded for test"],
      },
    });
    vi.mocked(getMemoryRetriever).mockReturnValue({ mode: "object-assertion", retrieve });
    return retrieve;
  }

  it("reuses Locate while bounding output and stripping SourceBlock excerpts", async () => {
    const retrieve = useLocate();
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);

    const onLocate = vi.fn();
    const result = await searchMemory("  继往开来  ", { onLocate });

    expect(retrieve).toHaveBeenCalledWith({ query: "继往开来", signal: undefined });
    expect(onLocate).toHaveBeenCalledOnce();
    expect(result.counts).toEqual({ objects: 16, assertions: 12, connections: 12 });
    expect(result.truncated).toEqual({ objects: true, assertions: true });
    expect(result.objects.every(
      (object) => object.surfaceForms.length === memoryExploreLimits.surfaceFormsPerObject,
    )).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SOURCEBLOCK_MARKDOWN");
  });

  it("resolves one exact target deterministically and keeps only its related Assertions", async () => {
    const retrieve = useLocate();
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);

    const result = await searchMemory({
      query: "组织现状",
      targetHints: ["Global Object 4"],
      taskShape: "fact",
    });

    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({
      objectFacets: [expect.objectContaining({ text: "Global Object 4" })],
    }));
    expect(result.objects[0]).toMatchObject({ id: "global-4", ref: "O1" });
    expect(result.assertions).toEqual([
      expect.objectContaining({ id: "assertion-4", ref: "A1" }),
    ]);
    expect(result.connections).toEqual([{ assertionRef: "A1", objectRef: "O1" }]);
  });

  it("returns Object candidates but no facts when a target hint is ambiguous", async () => {
    const seedMap = locatedSeedMap();
    seedMap.objects[0].surfaceForms = ["同名对象"];
    seedMap.objects[1].surfaceForms = ["同名对象"];
    useLocate(seedMap);
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);

    const result = await searchMemory({
      query: "当前状态",
      targetHints: ["同名对象"],
      taskShape: "fact",
    });

    expect(result.objects.length).toBeGreaterThan(1);
    expect(result.assertions).toEqual([]);
    expect(result.warnings).toContainEqual(expect.stringContaining("精确匹配多个 Object"));
  });

  it("loads only Assertions directly related to the target during synthesis", async () => {
    const seedMap = locatedSeedMap();
    seedMap.objects = seedMap.objects.slice(0, 1);
    seedMap.assertions = [];
    seedMap.connections = [];
    useLocate(seedMap);
    const profile = assertionRow({
      id: "profile",
      statement: "{{object:global-1}}具有正式社团资料。",
      objectLinks: [objectLink("global-1", "Global Object 1")],
    });
    const catalog = assertionRow({
      id: "catalog",
      kind: "reference",
      statement: "完整活动清单记录在来源章节中。",
      objectCoverage: [objectLink("global-1", "Global Object 1")],
    });
    const assertionFindMany = vi.fn().mockResolvedValue([profile, catalog]);
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: { findMany: vi.fn().mockResolvedValue([]) },
      memoryAssertionObjectLink: {
        findMany: vi.fn().mockResolvedValue([{ assertionId: "profile" }]),
      },
      memoryAssertionObjectCoverage: {
        findMany: vi.fn().mockResolvedValue([{ assertionId: "catalog" }]),
      },
      memoryAssertion: { findMany: assertionFindMany },
    } as never);

    const result = await searchMemory({
      query: "完整概览、活动和平台",
      targetHints: ["Global Object 1"],
      taskShape: "synthesis",
    });

    expect(result.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "profile", kind: "grounded" }),
      expect.objectContaining({ id: "catalog", kind: "reference" }),
    ]));
    expect(result.knowledgeState).toEqual({
      targetObjectId: "global-1",
      higherMemory: "absent",
      coldBootstrapApplied: true,
    });
    expect(result.coverage).toMatchObject({ level: "partial", observationComplete: false });
    expect(assertionFindMany).toHaveBeenCalled();
  });

  it("rejects an oversized query before invoking Locate", async () => {
    const retrieve = vi.fn();
    vi.mocked(getMemoryRetriever).mockReturnValue({ mode: "object-assertion", retrieve });
    await expect(searchMemory("x".repeat(memoryExploreLimits.queryChars + 1)))
      .rejects.toThrow("不能超过");
    expect(retrieve).not.toHaveBeenCalled();
  });
});

function followAssertionRows(includeReference = false) {
  const common = {
    kind: "grounded" as const,
    contextDependent: false,
    compilation: { sourceTitle: "Follow test source", sourceSha256: "follow-sha" },
    sourceRegion: { sourceNodeId: "region-1", label: "Follow region" },
    objectCoverage: [],
    chatEvidenceLinks: [],
    sourceBlockLinks: [{
      ordinal: 0,
      sourceBlock: { sourceBlockId: "block-1", sourcePages: [2] },
    }],
  };
  const assertions = [{
    ...common,
    id: "assertion-definition",
    sourceClaimId: "claim-definition",
    globalStatementTemplateMarkdown: "{{object:global-event}}与{{object:global-event}}都是同一项活动。",
    objectLinks: [objectLink("global-event", "继往开来")],
  }, {
    ...common,
    id: "assertion-organizer",
    sourceClaimId: "claim-organizer",
    globalStatementTemplateMarkdown: "{{object:global-event}}由{{object:global-student-union}}举办。",
    objectLinks: [
      objectLink("global-event", "继往开来"),
      objectLink("global-student-union", "学生会"),
    ],
  }];
  return includeReference ? [...assertions, {
    ...common,
    id: "assertion-reference",
    sourceClaimId: "claim-reference",
    kind: "reference" as const,
    globalStatementTemplateMarkdown: "完整品牌赛事清单记录于“品牌活动”表格。",
    objectLinks: [],
    objectCoverage: [objectLink("global-event", "继往开来")],
  }] : assertions;
}

describe("followObject", () => {
  function useFollowDatabase(input: { includeTarget?: boolean; includeReference?: boolean } = {}) {
    const allObjects = [
      globalObject("global-event", "event-key", "继往开来", ["继往开来", "该活动"]),
      globalObject("global-student-union", "student-union-key", "学生会", ["学生会"]),
    ];
    const database = {
      memoryCompilation: { findFirst: vi.fn().mockResolvedValue({
        id: "compilation-current",
        sourceTitle: "Follow test source",
        sourceSha256: "follow-sha",
        sourceTimeText: null,
        sourceTimeSupportingBlockIds: [],
      }) },
      memorySourceBlock: { findMany: vi.fn().mockResolvedValue([]) },
      memoryGlobalObject: { findMany: vi.fn().mockImplementation(async (args: {
        where: { id: { in: string[] } };
      }) => allObjects.filter((object) =>
        (input.includeTarget !== false || object.id !== "global-event") &&
        args.where.id.in.includes(object.id)
      )) },
      memoryAssertionObjectLink: { findMany: vi.fn().mockImplementation(async (args: {
        where: { globalObjectId: string };
      }) => args.where.globalObjectId === "global-event"
        ? [{ assertionId: "assertion-definition" }, { assertionId: "assertion-organizer" }]
        : [{ assertionId: "assertion-organizer" }]
      ) },
      memoryAssertionObjectCoverage: { findMany: vi.fn().mockImplementation(async (args: {
        where: { globalObjectId: string };
      }) => input.includeReference && args.where.globalObjectId === "global-event"
        ? [{ assertionId: "assertion-reference" }]
        : []
      ) },
      memoryAssertion: { findMany: vi.fn().mockImplementation(async (args: {
        where: { id: { in: string[] } };
      }) => followAssertionRows(input.includeReference).filter((assertion) =>
        args.where.id.in.includes(assertion.id)
      )) },
    };
    vi.mocked(getDatabase).mockReturnValue(database as never);
    return database;
  }

  it("follows resolved Object relations and ranks by focus", async () => {
    const database = useFollowDatabase();
    const result = await followObject(" global-event ", " 学生会 ");

    expect(result.counts).toEqual({ objects: 2, assertions: 2, connections: 3 });
    expect(result.objects[0]).toMatchObject({ id: "global-event", canonicalName: "继往开来" });
    expect(result.assertions[0].renderedStatement).toBe("继往开来由学生会举办。");
    expect(JSON.stringify(result)).not.toContain("SOURCEBLOCK_MARKDOWN");
    expect(database.memoryAssertionObjectLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: memoryExploreLimits.followAssertionScan + 1 }),
    );
  });

  it("finds a Reference through retrieval coverage without inventing a graph edge", async () => {
    useFollowDatabase({ includeReference: true });
    const result = await followObject("global-event", "品牌活动");
    const reference = result.assertions.find((assertion) => assertion.kind === "reference");

    expect(reference).toMatchObject({
      dereferenceRequired: true,
      renderedStatement: "完整品牌赛事清单记录于“品牌活动”表格。",
    });
    expect(result.connections.some((connection) => connection.assertionRef === reference?.ref))
      .toBe(false);
  });

  it("returns an empty result for an Object outside the current Compilation", async () => {
    const database = useFollowDatabase({ includeTarget: false });
    const result = await followObject("global-event");

    expect(result.counts).toEqual({ objects: 0, assertions: 0, connections: 0 });
    expect(result.warnings).toEqual([expect.stringContaining("不存在于当前 Compilation")]);
    expect(database.memoryAssertion.findMany).not.toHaveBeenCalled();
  });
});
