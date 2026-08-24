import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDatabase } from "@/db";
import {
  followObject,
  memoryExploreLimits,
  searchMemory,
} from "@/memory/explore";
import { getMemoryRetriever } from "@/memory/retriever";
import {
  curateRetrievalAssertions,
  resolveRetrievalTargets,
} from "@/memory/retrieval-curator";

vi.mock("@/db", () => ({ getDatabase: vi.fn() }));
vi.mock("@/memory/retriever", () => ({ getMemoryRetriever: vi.fn() }));
vi.mock("@/memory/retrieval-curator", () => ({
  resolveRetrievalTargets: vi.fn(),
  curateRetrievalAssertions: vi.fn(),
}));

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
    id: `assertion-${index + 1}`,
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

function objectLink(
  id: string,
  canonicalName: string,
) {
  return {
    globalObject: { id, canonicalName },
  };
}

function followAssertionRows(includeSemanticReference = false) {
  const common = {
    kind: "grounded" as const,
    contextDependent: false,
    compilation: { sourceTitle: "Follow test source", sourceSha256: "follow-sha" },
    sourceRegion: { sourceNodeId: "region-1", label: "Follow region" },
    objectCoverage: [],
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
      objectLinks: [objectLink("global-event", "继往开来")],
    },
    {
      ...common,
      id: "assertion-organizer",
      sourceClaimId: "claim-organizer",
      globalStatementTemplateMarkdown:
        "{{object:global-event}}由{{object:global-student-union}}举办。",
      objectLinks: [
        objectLink("global-event", "继往开来"),
        objectLink("global-student-union", "学生会"),
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
      objectLinks: [],
      objectCoverage: [
        objectLink("global-event", "继往开来"),
      ],
    }];
  }
  return assertions;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveRetrievalTargets).mockResolvedValue({
    targetObjectIds: ["global-1"],
    mode: "deterministic",
    reasons: [{ id: "global-1", reason: "exact" }],
    candidateObjectIds: ["global-1"],
  });
  vi.mocked(curateRetrievalAssertions).mockResolvedValue({
    selectedAssertionIds: ["assertion-1"],
    mode: "model",
    coverage: "partial",
    missingAspects: [],
    reasons: [{ id: "assertion-1", reason: "direct" }],
    candidateAssertionIds: ["assertion-1"],
  });
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
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);

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
      warnings: expect.arrayContaining(["vector degraded for test"]),
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

  it("keeps lexical target candidates ahead of Assertion-only related Objects", async () => {
    const seedMap = locatedSeedMap();
    seedMap.objects.forEach((object, index) => {
      object.lexicalMatch = index === 0;
    });
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
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);

    const result = await searchMemory("connected object");

    expect(result.objects[0].id).toBe("global-1");
    expect(result.objects.some((object) => object.id === connectedObject.id)).toBe(true);
    expect(result.connections).toEqual([{
      assertionRef: "A1",
      objectRef: connectedObject.ref,
    }]);
    expect(result.truncated.objects).toBe(false);
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

  it("uses Higher Memory for orientation without hiding query-specific Assertions", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      query: "Global Object 1",
      mode: "object-assertion",
      compilationId: "compilation-current",
      seedMap: locatedSeedMap(),
      trace: { snapshot: { id: "compilation-current" }, warnings: [] },
    });
    vi.mocked(getMemoryRetriever).mockReturnValue({
      mode: "object-assertion",
      retrieve,
    });
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: {
        findMany: vi.fn().mockResolvedValue([{
          id: "higher-memory-1",
          globalObjectId: "global-1",
          cognitiveMemory: {
            identityAndBoundaries: "这是目标对象的高层身份认知。",
            narrativeAndMeaning: "",
            structuralModel: "",
            operatingModel: "",
            currentSituation: "",
            openQuestions: [],
          },
          operationalIndex: { aspects: [] },
          maintainedAt: new Date("2026-08-14T00:00:00.000Z"),
        }]),
      },
      memoryAssertion: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);

    const result = await searchMemory("Global Object 1", {
      curatorContext: {
        conversation: [],
        originalUserMessage: "Global Object 1 的具体事实是什么？",
        currentInstant: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
      },
    });

    expect(result.higherMemories).toEqual([expect.objectContaining({
      ref: "H1",
      globalObjectId: "global-1",
      contentMarkdown: expect.stringContaining("高层身份认知"),
    })]);
    expect(result.assertions.some((assertion) => assertion.ref === "A1")).toBe(true);
    expect(result.connections.length).toBeGreaterThan(0);
    expect(curateRetrievalAssertions).toHaveBeenCalled();
    expect(result.coverage?.level).not.toBe("complete");
    expect(result.warnings).toContainEqual(expect.stringContaining(
      "当前 query 仍独立检索/筛选 Assertions",
    ));
  });

  it("bootstraps Object-linked evidence for a cold synthesis target", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      query: "完整概览、活动和平台",
      mode: "object-assertion",
      compilationId: "compilation-current",
      seedMap: locatedSeedMap(),
      trace: { snapshot: { id: "compilation-current" }, warnings: [] },
    });
    vi.mocked(getMemoryRetriever).mockReturnValue({ mode: "object-assertion", retrieve });
    const bootstrapRows = [
      {
        id: "bootstrap-profile",
        sourceClaimId: "claim-profile",
        kind: "grounded" as const,
        globalStatementTemplateMarkdown: "{{object:global-1}}具有完整的社团身份资料。",
        contextDependent: false,
        compilation: { sourceTitle: "生存手册", sourceSha256: "sha" },
        sourceRegion: {
          sourceNodeId: "manual-profile",
          label: "身份与历史",
          sourceTitle: "生存手册",
          sourceSha256: "sha",
        },
        chatEvidenceLinks: [],
        objectLinks: [objectLink("global-1", "Global Object 1")],
        objectCoverage: [],
        sourceBlockLinks: [{
          ordinal: 0,
          sourceBlock: { sourceBlockId: "manual-block-profile", sourcePages: [2] },
        }],
      },
      {
        id: "bootstrap-reference",
        sourceClaimId: "claim-reference",
        kind: "reference" as const,
        globalStatementTemplateMarkdown: "活动和平台的完整清单记录在生存手册的表格与章节中。",
        contextDependent: true,
        compilation: { sourceTitle: "生存手册", sourceSha256: "sha" },
        sourceRegion: {
          sourceNodeId: "manual-catalog",
          label: "活动与平台",
          sourceTitle: "生存手册",
          sourceSha256: "sha",
        },
        chatEvidenceLinks: [],
        objectLinks: [],
        objectCoverage: [objectLink("global-1", "Global Object 1")],
        sourceBlockLinks: [{
          ordinal: 0,
          sourceBlock: { sourceBlockId: "manual-block-catalog", sourcePages: [3] },
        }],
      },
    ];
    const memoryAssertionFindMany = vi.fn().mockResolvedValue(bootstrapRows);
    const coreFindMany = vi.fn().mockResolvedValue([{ assertionId: "bootstrap-profile" }]);
    const coverageFindMany = vi.fn().mockResolvedValue([{ assertionId: "bootstrap-reference" }]);
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: { findMany: vi.fn().mockResolvedValue([]) },
      memoryAssertionObjectLink: { findMany: coreFindMany },
      memoryAssertionObjectCoverage: { findMany: coverageFindMany },
      memoryAssertion: { findMany: memoryAssertionFindMany },
    } as never);
    vi.mocked(curateRetrievalAssertions).mockResolvedValue({
      selectedAssertionIds: ["bootstrap-profile", "bootstrap-reference"],
      mode: "model",
      coverage: "partial",
      missingAspects: ["当前状态"],
      reasons: [
        { id: "bootstrap-profile", reason: "profile" },
        { id: "bootstrap-reference", reason: "source route" },
      ],
      candidateAssertionIds: ["bootstrap-profile", "bootstrap-reference"],
    });

    const result = await searchMemory({
      query: "完整概览、活动和平台",
      targetHints: ["Global Object 1"],
      taskShape: "synthesis",
    }, {
      curatorContext: {
        conversation: [],
        originalUserMessage: "请整理完整概览、活动和平台",
        currentInstant: "2026-08-24T00:00:00.000Z",
        timezone: "Asia/Shanghai",
      },
    });

    expect(coreFindMany).toHaveBeenCalled();
    expect(coverageFindMany).toHaveBeenCalled();
    expect(result.taskShape).toBe("synthesis");
    expect(result.knowledgeState).toEqual({
      targetObjectId: "global-1",
      higherMemory: "absent",
      coldBootstrapApplied: true,
    });
    expect(result.assertions.map((assertion) => assertion.id).sort()).toEqual([
      "bootstrap-profile",
      "bootstrap-reference",
    ].sort());
    expect(result.warnings).toContainEqual(expect.stringContaining("尚无 Higher Memory"));
    expect(curateRetrievalAssertions).toHaveBeenCalledWith(expect.objectContaining({
      taskShape: "synthesis",
    }));
  });

  it("returns matching Assertions alongside a stale Higher Memory", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      query: "Global Object 1 当前状态",
      mode: "object-assertion",
      compilationId: "compilation-current",
      seedMap: locatedSeedMap(),
      trace: { snapshot: { id: "compilation-current" }, warnings: [] },
    });
    vi.mocked(getMemoryRetriever).mockReturnValue({ mode: "object-assertion", retrieve });
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: {
        findMany: vi.fn().mockResolvedValue([{
          id: "higher-memory-1",
          globalObjectId: "global-1",
          cognitiveMemory: {
            identityAndBoundaries: "这是刷新前的旧高层认知。",
            narrativeAndMeaning: "",
            structuralModel: "",
            operatingModel: "",
            currentSituation: "",
            openQuestions: [],
          },
          operationalIndex: { aspects: [] },
          maintainedAt: new Date("2026-08-14T00:00:00.000Z"),
        }]),
      },
      memoryAssertion: {
        findMany: vi.fn().mockResolvedValue([{
          id: "assertion-1",
          createdAt: new Date("2026-08-14T01:00:00.000Z"),
          objectLinks: [{ globalObjectId: "global-1" }],
        }]),
      },
    } as never);

    const result = await searchMemory("Global Object 1 当前状态");

    expect(result.higherMemories).toHaveLength(1);
    expect(result.assertions).not.toHaveLength(0);
    expect(result.assertions.some((assertion) => assertion.id === "assertion-1")).toBe(true);
    expect(result.warnings).toContainEqual(expect.stringContaining("出现了新的关联 Assertion"));
  });

  it("can explicitly bypass Higher Memory for background fact maintenance", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      query: "Global Object 1",
      mode: "object-assertion",
      compilationId: "compilation-current",
      seedMap: locatedSeedMap(),
      trace: { snapshot: { id: "compilation-current" }, warnings: [] },
    });
    vi.mocked(getMemoryRetriever).mockReturnValue({ mode: "object-assertion", retrieve });
    const findMany = vi.fn();
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: { findMany },
    } as never);

    const result = await searchMemory("Global Object 1", { preferHigherMemory: false });

    expect(findMany).not.toHaveBeenCalled();
    expect(result.higherMemories).toBeUndefined();
    expect(result.assertions.some((assertion) => assertion.ref === "A1")).toBe(true);
  });

  it("queries Higher Memory only for Curator-selected target Objects", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      query: "组织现状",
      mode: "object-assertion",
      compilationId: "compilation-current",
      seedMap: locatedSeedMap(),
      trace: { snapshot: { id: "compilation-current" }, warnings: [] },
    });
    vi.mocked(getMemoryRetriever).mockReturnValue({ mode: "object-assertion", retrieve });
    vi.mocked(resolveRetrievalTargets).mockResolvedValue({
      targetObjectIds: ["global-4"],
      mode: "model",
      reasons: [{ id: "global-4", reason: "conversation target" }],
      candidateObjectIds: ["global-1", "global-4"],
    });
    const findMany = vi.fn().mockResolvedValue([]);
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: { findMany },
    } as never);

    await searchMemory({
      query: "组织现状",
      targetHints: ["乒协组织本身"],
    }, {
      curatorContext: {
        conversation: [],
        originalUserMessage: "乒协现在怎么样",
        currentInstant: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
      },
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ globalObjectId: { in: ["global-4"] } }),
    }));
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({
      query: "组织现状",
      objectFacets: [expect.objectContaining({ text: "乒协组织本身" })],
    }));
    expect(resolveRetrievalTargets).toHaveBeenCalledWith(expect.objectContaining({
      targetHints: ["乒协组织本身"],
    }));
  });

  it("returns the selected target first and only Curator-selected Assertions", async () => {
    const seedMap = locatedSeedMap();
    // Both assertions mention global-4; Curator keeps only assertion-2.
    seedMap.connections.push({ assertionRef: "A1", objectRef: "O4" });
    seedMap.connections.push({ assertionRef: "A2", objectRef: "O4" });
    const retrieve = vi.fn().mockResolvedValue({
      query: "组织现状",
      mode: "object-assertion",
      compilationId: "compilation-current",
      seedMap,
      trace: { snapshot: { id: "compilation-current" }, warnings: [] },
    });
    vi.mocked(getMemoryRetriever).mockReturnValue({ mode: "object-assertion", retrieve });
    vi.mocked(resolveRetrievalTargets).mockResolvedValue({
      targetObjectIds: ["global-4"],
      mode: "model",
      reasons: [{ id: "global-4", reason: "conversation target" }],
      candidateObjectIds: ["global-1", "global-4"],
    });
    vi.mocked(curateRetrievalAssertions).mockResolvedValue({
      selectedAssertionIds: ["assertion-2"],
      mode: "model",
      coverage: "partial",
      missingAspects: [],
      reasons: [{ id: "assertion-2", reason: "direct" }],
      candidateAssertionIds: ["assertion-1", "assertion-2"],
    });
    vi.mocked(getDatabase).mockReturnValue({
      memoryObjectHigherMemory: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);

    const result = await searchMemory({ query: "组织现状", targetHints: ["乒协"] }, {
      curatorContext: {
        conversation: [],
        originalUserMessage: "乒协现在怎么样",
        currentInstant: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
      },
    });

    expect(result.objects[0]).toMatchObject({ ref: "O1", id: "global-4" });
    expect(result.assertions).toEqual([
      expect.objectContaining({ ref: "A1", id: "assertion-2" }),
    ]);
    expect(result.connections).toContainEqual({ assertionRef: "A1", objectRef: "O1" });
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
      memoryAssertionObjectLink: {
        findMany: vi.fn().mockImplementation(async (args: {
          where: { globalObjectId: string };
        }) => {
          if (args.where.globalObjectId === "global-event") return [
              { assertionId: "assertion-definition" },
              { assertionId: "assertion-organizer" },
            ];
          if (args.where.globalObjectId === "global-student-union") {
            return [{ assertionId: "assertion-organizer" }];
          }
          return [];
        }),
      },
      memoryAssertionObjectCoverage: {
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

    expect(database.memoryAssertionObjectLink.findMany)
      .toHaveBeenCalledWith(expect.objectContaining({
        where: {
          globalObjectId: "global-event",
          globalObject: { compilationId: "compilation-current" },
        },
        distinct: ["assertionId"],
        take: memoryExploreLimits.followAssertionScan + 1,
      }));
    expect(database.memoryAssertionObjectCoverage.findMany)
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

  it("follows a GlobalObject through the canonical Assertion link", async () => {
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
    expect(database.memoryAssertionObjectLink.findMany)
      .toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ globalObjectId: "global-student-union" }),
      }));
    expect(database.memoryAssertionObjectCoverage.findMany).toHaveBeenCalledOnce();
  });

  it("reverse-lookups a Reference through retrieval coverage without creating a graph edge", async () => {
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
    const referenceRef = reference?.ref;
    expect(result.connections.some((connection) => connection.assertionRef === referenceRef))
      .toBe(false);
    expect(database.memoryAssertionObjectCoverage.findMany)
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
