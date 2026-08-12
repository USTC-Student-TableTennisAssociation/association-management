import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDatabase } from "@/db";
import { embedMemoryQueries } from "@/memory/embedding-client";
import { locateObjectAssertions } from "@/memory/database-locate";
import { ResolvedAssertionIntegrityError } from "@/memory/resolved-assertion";

vi.mock("@/db", () => ({ getDatabase: vi.fn() }));
vi.mock("@/memory/embedding-client", () => ({ embedMemoryQueries: vi.fn() }));

const originalVectorRequired = process.env.MEMORY_VECTOR_REQUIRED;
const originalMinimumLexicalScore = process.env.MEMORY_MIN_LEXICAL_SCORE;

type MockDatabase = {
  memoryCompilation: { findFirst: ReturnType<typeof vi.fn> };
  memorySourceBlock: { findMany: ReturnType<typeof vi.fn> };
  memoryGlobalObject: { findMany: ReturnType<typeof vi.fn> };
  memoryAssertion: { findMany: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
};

function snapshot(globalObjectCount: number, assertionCount: number) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sourceTitle: "GlobalObject test source",
    sourceSha256: "test-sha256",
    sourceTimeText: null,
    sourceTimeSupportingBlockIds: [],
    compiledAt: new Date("2026-08-10T00:00:00.000Z"),
    objectFragmentCount: 4,
    surfaceFormCount: 6,
    fragmentReferenceCount: 6,
    assertionEmbeddingIndex: null,
    _count: { globalObjects: globalObjectCount, assertions: assertionCount },
  };
}

function globalObjects() {
  return [
    {
      id: "global-event",
      globalObjectKey: "global-object-event",
      canonicalName: "继往开来",
      identitySummaryMarkdown: "持续存在的校园活动。",
      surfaceMemberships: [
        {
          surfaceFormOrdinal: 0,
          objectFragment: {
            sourceFragmentId: "fragment-event-1",
            surfaceForms: ["继往开来", "继往开来杯"],
          },
        },
        {
          surfaceFormOrdinal: 1,
          objectFragment: {
            sourceFragmentId: "fragment-event-2",
            surfaceForms: ["该活动", "传承活动"],
          },
        },
      ],
    },
    {
      id: "global-student-union",
      globalObjectKey: "global-object-student-union",
      canonicalName: "学生会",
      identitySummaryMarkdown: "学生组织。",
      surfaceMemberships: [
        {
          surfaceFormOrdinal: 0,
          objectFragment: {
            sourceFragmentId: "fragment-student-union",
            surfaceForms: ["学生会"],
          },
        },
      ],
    },
    {
      id: "global-club",
      globalObjectKey: "global-object-club",
      canonicalName: "社团",
      identitySummaryMarkdown: "学生社团。",
      surfaceMemberships: [
        {
          surfaceFormOrdinal: 0,
          objectFragment: {
            sourceFragmentId: "fragment-club",
            surfaceForms: ["社团"],
          },
        },
      ],
    },
  ];
}

function resolution(
  ordinal: number,
  sourceFragmentId: string,
  object: { id: string; globalObjectKey: string; canonicalName: string },
) {
  return {
    ordinal,
    objectFragment: { sourceFragmentId },
    globalResolutions: [{ globalObject: object }],
  };
}

function literalReference(object: {
  id: string;
  globalObjectKey: string;
  canonicalName: string;
}) {
  return { globalObject: object };
}

function assertions() {
  const event = {
    id: "global-event",
    globalObjectKey: "global-object-event",
    canonicalName: "继往开来",
  };
  const studentUnion = {
    id: "global-student-union",
    globalObjectKey: "global-object-student-union",
    canonicalName: "学生会",
  };
  const club = {
    id: "global-club",
    globalObjectKey: "global-object-club",
    canonicalName: "社团",
  };
  return [
    {
      id: "assertion-1",
      sourceClaimId: "claim-1",
      kind: "grounded",
      globalStatementTemplateMarkdown: "{{object:global-event}}是校园文化活动。",
      contextDependent: true,
      sourceRegion: { sourceNodeId: "region-1", label: "活动定义" },
      fragmentReferences: [resolution(0, "fragment-event-1", event)],
      literalGlobalReferences: [],
      semanticObjectLinks: [],
    },
    {
      id: "assertion-2",
      sourceClaimId: "claim-2",
      kind: "grounded",
      globalStatementTemplateMarkdown:
        "{{object:global-event}}由{{object:global-student-union}}与{{object:global-club}}联合举办。",
      contextDependent: false,
      sourceRegion: { sourceNodeId: "region-1", label: "活动组织" },
      fragmentReferences: [resolution(0, "fragment-event-2", event)],
      literalGlobalReferences: [
        literalReference(studentUnion),
        literalReference(club),
      ],
      semanticObjectLinks: [],
    },
    {
      id: "assertion-3",
      sourceClaimId: "claim-3",
      kind: "grounded",
      globalStatementTemplateMarkdown:
        "{{object:global-event}}与{{object:global-event}}都强调传承。",
      contextDependent: false,
      sourceRegion: { sourceNodeId: "region-1", label: "活动理念" },
      fragmentReferences: [
        resolution(0, "fragment-event-1", event),
        resolution(1, "fragment-event-1", event),
      ],
      literalGlobalReferences: [],
      semanticObjectLinks: [],
    },
  ];
}

function sourceRows() {
  return ["assertion-1", "assertion-2", "assertion-3"].map((id, index) => ({
    id,
    compilation: {
      sourceTitle: "GlobalObject test source",
      sourceSha256: "test-sha256",
    },
    sourceRegion: { sourceNodeId: "region-1", label: `区域 ${index + 1}` },
    sourceBlockLinks: [
      {
        ordinal: 0,
        sourceBlock: {
          sourceBlockId: `source-block-${index + 1}`,
          sourcePages: [index + 1],
          markdown: "SOURCEBLOCK_MARKDOWN_MUST_NOT_ENTER_LOCATE",
        },
      },
    ],
  }));
}

function useMockDatabase(input: {
  objects: unknown[];
  assertions: unknown[];
  sources?: unknown[];
}): MockDatabase {
  const database: MockDatabase = {
    memoryCompilation: { findFirst: vi.fn().mockResolvedValue(snapshot(input.objects.length, input.assertions.length)) },
    memorySourceBlock: { findMany: vi.fn().mockResolvedValue([]) },
    memoryGlobalObject: { findMany: vi.fn().mockResolvedValue(input.objects) },
    memoryAssertion: {
      findMany: vi.fn().mockImplementation(async (args: {
        select?: { globalStatementTemplateMarkdown?: boolean; sourceBlockLinks?: unknown };
      }) => {
        if (args.select?.globalStatementTemplateMarkdown) return input.assertions;
        if (args.select?.sourceBlockLinks) return input.sources ?? [];
        throw new Error("测试收到了未预期的 Assertion query");
      }),
    },
    $queryRaw: vi.fn(),
  };
  vi.mocked(getDatabase).mockReturnValue(database as never);
  return database;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MEMORY_VECTOR_REQUIRED = "false";
  process.env.MEMORY_MIN_LEXICAL_SCORE = "0.18";
});

afterEach(() => {
  if (originalVectorRequired === undefined) delete process.env.MEMORY_VECTOR_REQUIRED;
  else process.env.MEMORY_VECTOR_REQUIRED = originalVectorRequired;
  if (originalMinimumLexicalScore === undefined) delete process.env.MEMORY_MIN_LEXICAL_SCORE;
  else process.env.MEMORY_MIN_LEXICAL_SCORE = originalMinimumLexicalScore;
});

describe("GlobalObject-backed Locate", () => {
  it("collapses source fragments into GlobalObject seeds and preserves resolved connections", async () => {
    const database = useMockDatabase({
      objects: globalObjects(),
      assertions: assertions(),
      sources: sourceRows(),
    });

    const result = await locateObjectAssertions({
      query: "继往开来是什么活动？",
      facets: [
        { id: "facet-object", text: "继往开来", source: "query" },
        { id: "facet-definition", text: "继往开来是校园文化活动。", source: "ai" },
        { id: "facet-organizer", text: "继往开来由学生会与社团联合举办。", source: "ai" },
        { id: "facet-repeat", text: "继往开来与继往开来都强调传承。", source: "ai" },
      ],
    });

    const eventSeeds = result.seedMap.objects.filter(
      (object) => object.canonicalName === "继往开来",
    );
    expect(eventSeeds).toHaveLength(1);
    expect(eventSeeds[0]).toMatchObject({
      id: "global-event",
      globalObjectKey: "global-object-event",
      lexicalMatch: true,
      semanticMatch: true,
    });
    expect(new Set(eventSeeds[0].surfaceForms)).toEqual(
      new Set(["继往开来", "传承活动"]),
    );

    const assertionByClaim = new Map(
      result.seedMap.assertions.map((assertion) => [assertion.sourceClaimId, assertion]),
    );
    expect(assertionByClaim.get("claim-1")).toMatchObject({
      renderedStatement: "继往开来是校园文化活动。",
      contextDependent: true,
    });
    expect(assertionByClaim.get("claim-2")?.renderedStatement).toBe(
      "继往开来由学生会与社团联合举办。",
    );
    expect(assertionByClaim.get("claim-3")?.renderedStatement).toBe(
      "继往开来与继往开来都强调传承。",
    );

    const eventRef = eventSeeds[0].ref;
    const assertionRefByClaim = new Map(
      result.seedMap.assertions.map((assertion) => [assertion.sourceClaimId, assertion.ref]),
    );
    const eventConnections = result.seedMap.connections.filter(
      (connection) => connection.objectRef === eventRef,
    );
    expect(new Set(eventConnections.map((connection) => connection.assertionRef))).toEqual(
      new Set([
        assertionRefByClaim.get("claim-1"),
        assertionRefByClaim.get("claim-2"),
        assertionRefByClaim.get("claim-3"),
      ]),
    );
    expect(eventConnections.filter(
      (connection) => connection.assertionRef === assertionRefByClaim.get("claim-3"),
    )).toHaveLength(1);

    const multiObjectAssertionRef = assertionRefByClaim.get("claim-2");
    expect(result.seedMap.connections.filter(
      (connection) => connection.assertionRef === multiObjectAssertionRef,
    )).toHaveLength(3);
    expect(result.seedMap.connections).toHaveLength(5);

    expect(result.seedMap.assertions.flatMap((assertion) => assertion.sources)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: "GlobalObject test source",
          sourceBlockId: "source-block-1",
          pages: [1],
        }),
      ]),
    );
    expect(JSON.stringify(result.seedMap)).not.toContain("SOURCEBLOCK_MARKDOWN_MUST_NOT_ENTER_LOCATE");
    expect(result.seedMap.assertions.flatMap((assertion) => assertion.sources)
      .every((source) => source.excerpt === undefined)).toBe(true);
    expect(result.trace?.warnings).toEqual([
      expect.stringContaining("Assertion vector 通道不可用"),
    ]);
    expect(database.$queryRaw).not.toHaveBeenCalled();
    expect(embedMemoryQueries).not.toHaveBeenCalled();
  });

  it("case F returns a Reference from the Assertion vector retrieval path", async () => {
    const referenceAssertion = {
      id: "assertion-reference",
      sourceClaimId: "claim-reference",
      kind: "reference",
      globalStatementTemplateMarkdown:
        "负责人、裁判、宣传、签到和器材岗位安排记录于“人员分工”部分。",
      contextDependent: false,
      sourceRegion: { sourceNodeId: "region-reference", label: "人员分工" },
      fragmentReferences: [],
      literalGlobalReferences: [],
      semanticObjectLinks: [{
        globalObject: { id: "global-event", canonicalName: "继往开来" },
      }],
    };
    const database = useMockDatabase({
      objects: globalObjects(),
      assertions: [referenceAssertion],
      sources: [{
        id: "assertion-reference",
        compilation: {
          sourceTitle: "GlobalObject test source",
          sourceSha256: "test-sha256",
        },
        sourceRegion: { sourceNodeId: "region-reference", label: "人员分工" },
        sourceBlockLinks: [{
          ordinal: 0,
          sourceBlock: { sourceBlockId: "table-personnel", sourcePages: [6] },
        }],
      }],
    });
    database.memoryCompilation.findFirst.mockResolvedValue({
      ...snapshot(globalObjects().length, 1),
      assertionEmbeddingIndex: {
        modelKey: "test-embedding",
        modelRevision: "v1",
        dimension: 3,
        indexedAssertionCount: 1,
      },
    });
    vi.mocked(embedMemoryQueries).mockResolvedValue({
      model: "test-embedding",
      modelRevision: "v1",
      dimension: 3,
      vectors: [[0.1, 0.2, 0.3]],
    });
    database.$queryRaw.mockResolvedValue([
      { assertionId: "assertion-reference", distance: 0.05, score: 0.95 },
    ]);

    const result = await locateObjectAssertions({ query: "谁负责签到？" });

    expect(result.seedMap.assertions).toEqual([
      expect.objectContaining({
        kind: "reference",
        dereferenceRequired: true,
        sourceClaimId: "claim-reference",
        matchedBy: expect.arrayContaining([
          expect.objectContaining({ channel: "assertion-vector", method: "vector" }),
        ]),
        sources: [expect.objectContaining({ sourceBlockId: "table-personnel" })],
      }),
    ]);
    const referenceRef = result.seedMap.assertions[0].ref;
    const eventRef = result.seedMap.objects.find((item) => item.id === "global-event")?.ref;
    expect(result.seedMap.connections).toContainEqual({
      assertionRef: referenceRef,
      objectRef: eventRef,
    });
    expect(embedMemoryQueries).toHaveBeenCalledWith(["谁负责签到？"], {
      signal: undefined,
    });
  });

  it.each([
    { name: "missing", resolutions: [] },
    {
      name: "multiple",
      resolutions: [
        {
          globalObject: {
            id: "global-event",
            globalObjectKey: "global-object-event",
            canonicalName: "继往开来",
          },
        },
        {
          globalObject: {
            id: "global-other",
            globalObjectKey: "global-object-other",
            canonicalName: "另一个对象",
          },
        },
      ],
    },
  ])("fails fast for $name GlobalObject resolution", async ({ resolutions }) => {
    useMockDatabase({
      objects: globalObjects(),
      assertions: [
        {
          id: "assertion-invalid",
          sourceClaimId: "claim-invalid",
          kind: "grounded",
          globalStatementTemplateMarkdown: "{{object:global-event}}是活动。",
          contextDependent: false,
          sourceRegion: { sourceNodeId: "region-1", label: "测试区域" },
          fragmentReferences: [
            {
              ordinal: 0,
              objectFragment: { sourceFragmentId: "fragment-event-1" },
              globalResolutions: resolutions,
            },
          ],
          literalGlobalReferences: [],
          semanticObjectLinks: [],
        },
      ],
    });

    await expect(locateObjectAssertions({ query: "继往开来" }))
      .rejects.toThrow(ResolvedAssertionIntegrityError);
  });
});
