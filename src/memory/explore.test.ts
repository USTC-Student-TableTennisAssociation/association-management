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
      `surface-${index + 1}-${surfaceIndex + 1}`,
    ),
    matchedBy: [],
    matchedFacets: ["facet-0"],
    supportingAssertions: index < 14 ? [`A${index + 1}`] : [],
    lexicalMatch: true,
    semanticMatch: index < 14,
  }));
  const assertions = Array.from({ length: 14 }, (_, index) => ({
    ref: `A${index + 1}`,
    kind: "grounded" as const,
    dereferenceRequired: false,
    sourceNodeId: `source-node-${index + 1}`,
    sourceClaimId: `source-claim-${index + 1}`,
    renderedStatement: `Global Object ${index + 1} 有一条可检索 Assertion。`,
    contextDependent: false,
    matchedBy: [],
    matchedFacets: ["facet-0"],
    sources: [
      {
        sourceTitle: "Test source",
        sourceSha256: "sha",
        sourceNodeId: `source-node-${index + 1}`,
        sourceRegionLabel: "Test region",
        sourceBlockId: `block-${index + 1}`,
        ordinal: 0,
        pages: [1],
        excerpt: "SOURCEBLOCK_MARKDOWN_MUST_NOT_LEAVE_SEARCH",
      },
    ],
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
    surfaceMemberships: surfaces.map((surface, index) => ({
      surfaceFormOrdinal: index,
      objectFragment: {
        surfaceForms: surfaces,
        sourceFragmentId: `FRAGMENT_MUST_NOT_LEAVE_${id}`,
      },
    })),
  };
}

function resolution(
  ordinal: number,
  sourceFragmentId: string,
  id: string,
  canonicalName: string,
) {
  return {
    ordinal,
    objectFragment: { sourceFragmentId },
    globalResolutions: [{ globalObject: { id, canonicalName } }],
  };
}

function followAssertionRows(includeSemanticReference = false) {
  const common = {
    kind: "grounded" as const,
    contextDependent: false,
    compilation: { sourceTitle: "Follow test source", sourceSha256: "follow-sha" },
    sourceRegion: { sourceNodeId: "region-1", label: "Follow region" },
    semanticObjectLinks: [],
    sourceBlockLinks: [
      {
        ordinal: 0,
        sourceBlock: {
          sourceBlockId: "block-1",
          sourcePages: [2],
          markdown: "SOURCEBLOCK_MARKDOWN_MUST_NOT_LEAVE_FOLLOW",
        },
      },
    ],
  };
  const assertions = [
    {
      ...common,
      id: "assertion-definition",
      sourceClaimId: "claim-definition",
      globalStatementTemplateMarkdown:
        "{{object:global-event}}与{{object:global-event}}都是同一项活动。",
      fragmentReferences: [
        resolution(0, "event-1", "global-event", "继往开来"),
        resolution(1, "event-1", "global-event", "继往开来"),
      ],
      literalGlobalReferences: [],
    },
    {
      ...common,
      id: "assertion-organizer",
      sourceClaimId: "claim-organizer",
      globalStatementTemplateMarkdown:
        "{{object:global-event}}由{{object:global-student-union}}举办。",
      fragmentReferences: [resolution(0, "event-2", "global-event", "继往开来")],
      literalGlobalReferences: [
        { globalObject: { id: "global-student-union", canonicalName: "学生会" } },
      ],
    },
  ];
  if (includeSemanticReference) {
    return [...assertions, {
      ...common,
      id: "assertion-reference",
      sourceClaimId: "claim-reference",
      kind: "reference",
      globalStatementTemplateMarkdown:
        "乒协主要品牌赛事的名称、比赛形式和基本定位集中记录于“品牌活动”表格。",
      fragmentReferences: [],
      literalGlobalReferences: [],
      semanticObjectLinks: [
        { globalObject: { id: "global-event", canonicalName: "继往开来" } },
      ],
    }];
  }
  return assertions;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("searchMemory", () => {
  it("reuses Locate while bounding output and stripping SourceBlock excerpts", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      query: "继往开来",
      mode: "object-assertion",
      seedMap: locatedSeedMap(),
      trace: {
        snapshot: { id: "compilation-current" },
        warnings: ["vector degraded for test"],
      },
    });
    vi.mocked(getMemoryRetriever).mockReturnValue({
      mode: "object-assertion",
      retrieve,
    });

    const onLocate = vi.fn();
    const result = await searchMemory("  继往开来  ", { onLocate });

    expect(retrieve).toHaveBeenCalledWith({ query: "继往开来", signal: undefined });
    expect(onLocate).toHaveBeenCalledWith(expect.objectContaining({
      query: "继往开来",
      mode: "object-assertion",
    }));
    expect(result).toMatchObject({
      kind: "search-memory",
      mode: "object-assertion",
      compilationId: "compilation-current",
      query: "继往开来",
      counts: { objects: 16, assertions: 12, connections: 12 },
      truncated: { objects: true, assertions: true },
      warnings: ["vector degraded for test"],
    });
    expect(result.objects.every(
      (object) => object.surfaceForms.length === memoryExploreLimits.surfaceFormsPerObject,
    )).toBe(true);
    expect(result.assertions.map((assertion) =>
      `${assertion.sourceNodeId}\u0000${assertion.sourceClaimId}`,
    )).toHaveLength(12);
    expect(JSON.stringify(result)).not.toContain("SOURCEBLOCK_MARKDOWN");
    expect(result.assertions.flatMap((assertion) => assertion.sources)
      .every((source) => source.excerpt === undefined)).toBe(true);
  });

  it("rejects an oversized tool query before invoking Locate", async () => {
    const retrieve = vi.fn();
    vi.mocked(getMemoryRetriever).mockReturnValue({ mode: "object-assertion", retrieve });

    await expect(searchMemory("x".repeat(memoryExploreLimits.queryChars + 1)))
      .rejects.toThrow("不能超过");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("keeps Assertion-connected GlobalObjects ahead of lexical-only hits", async () => {
    const seedMap = locatedSeedMap();
    const connectedObject = seedMap.objects[17];
    seedMap.assertions = seedMap.assertions.slice(0, 1);
    seedMap.connections = [{
      assertionRef: seedMap.assertions[0].ref,
      objectRef: connectedObject.ref,
    }];
    const retrieve = vi.fn().mockResolvedValue({
      query: "connected object",
      mode: "object-assertion",
      seedMap,
      trace: { snapshot: { id: "compilation-current" }, warnings: [] },
    });
    vi.mocked(getMemoryRetriever).mockReturnValue({
      mode: "object-assertion",
      retrieve,
    });

    const result = await searchMemory("connected object");

    expect(result.objects[0].id).toBe(connectedObject.id);
    expect(result.connections).toEqual([{
      assertionRef: "A1",
      objectRef: connectedObject.ref,
    }]);
    expect(result.truncated.objects).toBe(true);
  });

  it("does not invoke Locate after the request has been aborted", async () => {
    const retrieve = vi.fn();
    vi.mocked(getMemoryRetriever).mockReturnValue({ mode: "object-assertion", retrieve });
    const controller = new AbortController();
    controller.abort(new Error("client stopped"));

    await expect(searchMemory("query", { signal: controller.signal }))
      .rejects.toThrow("client stopped");
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe("followObject", () => {
  function useFollowDatabase(input: {
    includeTarget?: boolean;
    includeSemanticReference?: boolean;
  } = {}) {
    const allObjects = [
      globalObject("global-event", "event-key", "继往开来", ["继往开来", "该活动"]),
      globalObject("global-student-union", "student-union-key", "学生会", ["学生会"]),
    ];
    const memoryGlobalObjectFindMany = vi.fn().mockImplementation(async (args: {
      where: { id: { in: string[] } };
    }) => allObjects.filter((object) =>
      (input.includeTarget !== false || object.id !== "global-event") &&
      args.where.id.in.includes(object.id),
    ));
    const database = {
      memoryCompilation: {
        findFirst: vi.fn().mockResolvedValue({
          id: "compilation-current",
          sourceTitle: "Follow test source",
          sourceSha256: "follow-sha",
          sourceTimeText: null,
          sourceTimeSupportingBlockIds: [],
        }),
      },
      memorySourceBlock: { findMany: vi.fn().mockResolvedValue([]) },
      memoryGlobalObject: { findMany: memoryGlobalObjectFindMany },
      memoryGlobalAssertionReferenceResolution: {
        findMany: vi.fn().mockImplementation(async (args: {
          where: { globalObjectId: string };
        }) => args.where.globalObjectId === "global-event"
          ? [
              { assertionId: "assertion-definition" },
              { assertionId: "assertion-organizer" },
            ]
          : []),
      },
      memoryGlobalAssertionLiteralReference: {
        findMany: vi.fn().mockImplementation(async (args: {
          where: { globalObjectId: string };
        }) => args.where.globalObjectId === "global-student-union"
          ? [{ assertionId: "assertion-organizer" }]
          : []),
      },
      memoryAssertionSemanticObjectLink: {
        findMany: vi.fn().mockImplementation(async (args: {
          where: { globalObjectId: string };
        }) => input.includeSemanticReference && args.where.globalObjectId === "global-event"
          ? [{ assertionId: "assertion-reference" }]
          : []),
      },
      memoryAssertion: {
        findMany: vi.fn().mockImplementation(async (args: {
          where: { id: { in: string[] } };
        }) => followAssertionRows(input.includeSemanticReference).filter((assertion) =>
          args.where.id.in.includes(assertion.id),
        )),
      },
    };
    vi.mocked(getDatabase).mockReturnValue(database as never);
    return database;
  }

  it("follows resolved GlobalObject relations, ranks by focus, and deduplicates connections", async () => {
    const database = useFollowDatabase();

    const result = await followObject(" global-event ", " 学生会 ");

    expect(result).toMatchObject({
      kind: "follow-object",
      mode: "object-assertion",
      compilationId: "compilation-current",
      globalObjectId: "global-event",
      focus: "学生会",
      counts: { objects: 2, assertions: 2, connections: 3 },
      truncated: { objects: false, assertions: false },
    });
    expect(result.objects[0]).toMatchObject({
      ref: "O1",
      id: "global-event",
      canonicalName: "继往开来",
    });
    expect(result.assertions[0]).toMatchObject({
      ref: "A1",
      sourceNodeId: "region-1",
      sourceClaimId: "claim-organizer",
      renderedStatement: "继往开来由学生会举办。",
    });
    expect(result.assertions[1].renderedStatement).toBe(
      "继往开来与继往开来都是同一项活动。",
    );
    expect(result.connections.filter((connection) =>
      connection.assertionRef === "A2" && connection.objectRef === "O1",
    )).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("sourceFragmentId");
    expect(JSON.stringify(result)).not.toContain("SOURCEBLOCK_MARKDOWN");
    expect(result.assertions.flatMap((assertion) => assertion.sources)
      .every((source) => source.excerpt === undefined)).toBe(true);

    expect(database.memoryGlobalAssertionReferenceResolution.findMany)
      .toHaveBeenCalledWith(expect.objectContaining({
        where: {
          globalObjectId: "global-event",
          globalObject: { compilationId: "compilation-current" },
        },
        distinct: ["assertionId"],
        take: memoryExploreLimits.followAssertionScan + 1,
      }));
    expect(database.memoryGlobalAssertionLiteralReference.findMany)
      .toHaveBeenCalledWith(expect.objectContaining({
        where: {
          globalObjectId: "global-event",
          globalObject: { compilationId: "compilation-current" },
        },
      }));
    const assertionQuery = database.memoryAssertion.findMany.mock.calls[0][0];
    expect(assertionQuery.select.sourceBlockLinks.select.sourceBlock.select).toEqual({
      sourceBlockId: true,
      sourcePages: true,
    });
  });

  it("follows a GlobalObject referenced by a finalized literal reference atom", async () => {
    const database = useFollowDatabase();

    const result = await followObject("global-student-union");

    expect(result.counts).toEqual({ objects: 2, assertions: 1, connections: 2 });
    expect(result.assertions[0]).toMatchObject({
      sourceClaimId: "claim-organizer",
      renderedStatement: "继往开来由学生会举办。",
    });
    expect(result.objects.map((object) => object.id)).toEqual([
      "global-student-union",
      "global-event",
    ]);
    expect(database.memoryGlobalAssertionReferenceResolution.findMany)
      .toHaveBeenCalledOnce();
    expect(database.memoryGlobalAssertionLiteralReference.findMany)
      .toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ globalObjectId: "global-student-union" }),
      }));
  });

  it("case E reverse-lookups a Reference through its semantic Object link", async () => {
    const database = useFollowDatabase({ includeSemanticReference: true });

    const result = await followObject("global-event", "品牌活动");
    const reference = result.assertions.find(
      (assertion) => assertion.sourceClaimId === "claim-reference",
    );

    expect(reference).toMatchObject({
      kind: "reference",
      dereferenceRequired: true,
      renderedStatement:
        "乒协主要品牌赛事的名称、比赛形式和基本定位集中记录于“品牌活动”表格。",
    });
    expect(reference?.sources[0]).toMatchObject({
      sourceNodeId: "region-1",
      sourceBlockId: "block-1",
    });
    expect(database.memoryAssertionSemanticObjectLink.findMany)
      .toHaveBeenCalledWith(expect.objectContaining({
        where: {
          globalObjectId: "global-event",
          globalObject: { compilationId: "compilation-current" },
        },
      }));
  });

  it("returns a recoverable empty result for an Object outside the current Compilation", async () => {
    const database = useFollowDatabase({ includeTarget: false });

    const result = await followObject("global-event");

    expect(result.counts).toEqual({ objects: 0, assertions: 0, connections: 0 });
    expect(result.warnings).toEqual([
      expect.stringContaining("不存在于当前 Compilation"),
    ]);
    expect(database.memoryAssertion.findMany).not.toHaveBeenCalled();
  });

  it("honors cancellation before returning an empty missing-Object result", async () => {
    const database = useFollowDatabase({ includeTarget: false });
    const controller = new AbortController();
    database.memoryGlobalObject.findMany.mockImplementationOnce(async () => {
      controller.abort(new Error("client stopped"));
      return [];
    });

    await expect(followObject("global-event", undefined, {
      signal: controller.signal,
    })).rejects.toThrow("client stopped");
    expect(database.memoryAssertion.findMany).not.toHaveBeenCalled();
  });
});
