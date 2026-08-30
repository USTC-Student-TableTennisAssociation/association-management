import { beforeEach, describe, expect, it, vi } from "vitest";

const aiState = vi.hoisted(() => ({ generateText: vi.fn() }));
const databaseState = vi.hoisted(() => ({ database: undefined as unknown }));
const exploreState = vi.hoisted(() => ({ followObject: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return { ...original, generateText: aiState.generateText };
});
vi.mock("@/ai/provider", () => ({ getChatModel: () => ({}) }));
vi.mock("@/db", () => ({ getDatabase: () => databaseState.database }));
vi.mock("@/memory/explore", () => ({
  followObject: exploreState.followObject,
}));

import {
  findExistingHigherMemoryObjectIds,
  maintainObjectHigherMemories,
} from "@/memory/object-higher-memory";
import type { MemoryRetrievalResult } from "@/memory/types";

const objectId = "00000000-0000-4000-8000-000000000020";

function retrieval(): MemoryRetrievalResult {
  return {
    query: "测试社团",
    mode: "object-assertion",
    seedMap: {
      facets: [],
      objects: [{
        ref: "O1",
        id: objectId,
        globalObjectKey: "test-club",
        canonicalName: "测试社团",
        surfaceForms: ["测试社团"],
        matchedBy: [],
        matchedFacets: [],
        supportingAssertions: [],
        lexicalMatch: true,
        semanticMatch: false,
      }],
      assertions: [],
      connections: [],
    },
  };
}

function input() {
  return {
    clientMessageId: "message-current",
    submittedAt: "2026-08-14T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    semanticContext: {
      conversation: [{
        messageId: "message-current",
        role: "user" as const,
        text: "我们正在讨论测试社团。",
      }],
      systemInstruction: "main system",
      modelCalls: [],
      toolExecutions: [],
      finalAnswer: "这是本轮回答。",
    },
    retrieval: retrieval(),
    queueDecision: {
      objectIds: [objectId],
      reason: "本轮围绕测试社团形成了实质理解",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const upsert = vi.fn().mockResolvedValue({ id: "memory-row" });
  const update = vi.fn().mockResolvedValue({ id: "memory-row" });
  const transaction = {
    memoryGlobalObject: { count: vi.fn().mockResolvedValue(1) },
    memoryObjectHigherMemory: { upsert, update },
  };
  databaseState.database = {
    memoryGlobalObject: {
      findMany: vi.fn().mockResolvedValue([{
        id: objectId,
        globalObjectKey: "test-club",
        canonicalName: "测试社团",
      }]),
    },
    memoryObjectHigherMemory: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<void>) =>
      callback(transaction)
    ),
    __transaction: transaction,
  };
  exploreState.followObject.mockResolvedValue({
    kind: "follow-object",
    mode: "object-assertion",
    globalObjectId: objectId,
    objects: [],
    assertions: [],
    connections: [],
    counts: { objects: 0, assertions: 0, connections: 0 },
    truncated: { objects: false, assertions: false },
    warnings: [],
  });
  aiState.generateText.mockResolvedValue({
    toolCalls: [{
      toolName: "submitObjectHigherMemory",
      input: {
      memories: [{
        globalObjectId: objectId,
        cognitiveMemory: {
          identityAndBoundaries: "测试社团是本轮讨论的长期组织对象。",
          narrativeAndMeaning: "",
          structuralModel: "",
          operatingModel: "团队通过正式业务视图和共享知识持续整理协作方式。",
          currentSituation: "当前资料仍有需要核对的时间边界和状态缺口。",
          openQuestions: ["哪些近期状态已有正式证据确认？"],
        },
        operationalIndex: {
          aspects: [{
            key: "current-state",
            label: "当前状态",
            summary: "通过当前状态与近期进展检索继续核对。",
            coverage: "partial",
            assertionIds: [],
            sourceNodeIds: [],
            sourceTitles: [],
            recommendedQueries: ["测试社团 当前状态 近期进展"],
            unresolvedAspects: ["正式状态尚待核对"],
          }],
        },
      }],
      },
    }],
  });
});

describe("maintainObjectHigherMemories", () => {
  it("stores only the rebuilt cognition document and maintenance metadata", async () => {
    await expect(maintainObjectHigherMemories(input())).resolves.toBe(1);

    expect(exploreState.followObject).toHaveBeenCalledWith(
      objectId,
      "本轮围绕测试社团形成了实质理解",
      expect.objectContaining({ preferHigherMemory: false }),
    );
    const call = aiState.generateText.mock.calls[0][0];
    expect(call.prompt).toContain("main system");
    expect(call.prompt).toContain("这是本轮回答");
    expect(call.prompt).toContain("Operational Memory Index");
    expect(call.prompt).toContain("Operating Model 不是第二套 Work View");
    expect(call.tools).toHaveProperty("submitObjectHigherMemory");
    expect(call.tools).not.toHaveProperty("searchMemory");
    expect(call.tools).not.toHaveProperty("followObject");
    expect(call.toolChoice).toEqual({
      type: "tool",
      toolName: "submitObjectHigherMemory",
    });

    const transaction = (databaseState.database as {
      __transaction: { memoryObjectHigherMemory: { upsert: ReturnType<typeof vi.fn> } };
    }).__transaction;
    expect(transaction.memoryObjectHigherMemory.upsert).toHaveBeenCalledWith({
      where: { globalObjectId: objectId },
      create: expect.objectContaining({
        globalObjectId: objectId,
        cognitiveMemory: expect.objectContaining({
          identityAndBoundaries: expect.stringContaining("测试社团"),
        }),
        operationalIndex: expect.objectContaining({
          aspects: expect.any(Array),
        }),
        triggerMessageId: "message-current",
        maintenanceReason: "本轮围绕测试社团形成了实质理解",
      }),
      update: expect.objectContaining({
        cognitiveMemory: expect.any(Object),
        operationalIndex: expect.any(Object),
      }),
    });
    expect(JSON.stringify(transaction.memoryObjectHigherMemory.upsert.mock.calls))
      .not.toContain("AssertionId");
  });

  it("preserves old memory when the agent cannot form useful new cognition", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitObjectHigherMemory",
        input: { memories: [] },
      }],
    });

    await expect(maintainObjectHigherMemories(input())).resolves.toBe(0);

    const database = databaseState.database as { $transaction: ReturnType<typeof vi.fn> };
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("never creates a missing Higher Memory in existing-only mode", async () => {
    await expect(maintainObjectHigherMemories({
      ...input(),
      existingOnly: true,
    })).resolves.toBe(0);

    expect(aiState.generateText).not.toHaveBeenCalled();
    expect(exploreState.followObject).not.toHaveBeenCalled();
    const database = databaseState.database as { $transaction: ReturnType<typeof vi.fn> };
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("uses update instead of upsert in existing-only mode", async () => {
    const database = databaseState.database as {
      memoryObjectHigherMemory: { findMany: ReturnType<typeof vi.fn> };
      __transaction: {
        memoryObjectHigherMemory: {
          update: ReturnType<typeof vi.fn>;
          upsert: ReturnType<typeof vi.fn>;
        };
      };
    };
    database.memoryObjectHigherMemory.findMany.mockResolvedValue([{
      globalObjectId: objectId,
      cognitiveMemory: {
        identityAndBoundaries: "测试社团",
        narrativeAndMeaning: "",
        structuralModel: "",
        operatingModel: "",
        currentSituation: "旧状态",
        openQuestions: [],
      },
      operationalIndex: { aspects: [] },
      maintainedAt: new Date("2026-08-01T00:00:00.000Z"),
    }]);

    await expect(maintainObjectHigherMemories({
      ...input(),
      existingOnly: true,
    })).resolves.toBe(1);

    expect(database.__transaction.memoryObjectHigherMemory.update)
      .toHaveBeenCalledWith(expect.objectContaining({
        where: { globalObjectId: objectId },
      }));
    expect(database.__transaction.memoryObjectHigherMemory.upsert).not.toHaveBeenCalled();
  });

  it("rejects a structurally empty cognition document", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitObjectHigherMemory",
        input: {
          memories: [{
            globalObjectId: objectId,
            cognitiveMemory: {
              identityAndBoundaries: "",
              narrativeAndMeaning: "",
              structuralModel: "",
              operatingModel: "",
              currentSituation: "",
              openQuestions: [],
            },
            operationalIndex: { aspects: [] },
          }],
        },
      }],
    });

    await expect(maintainObjectHigherMemories(input())).rejects.toThrow("identityAndBoundaries");

    const database = databaseState.database as { $transaction: ReturnType<typeof vi.fn> };
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});

describe("findExistingHigherMemoryObjectIds", () => {
  it("keeps input order and only returns Objects that already have Higher Memory", async () => {
    const otherObjectId = "00000000-0000-4000-8000-000000000021";
    const database = databaseState.database as {
      memoryObjectHigherMemory: { findMany: ReturnType<typeof vi.fn> };
    };
    database.memoryObjectHigherMemory.findMany.mockResolvedValue([
      { globalObjectId: otherObjectId },
      { globalObjectId: objectId },
    ]);

    await expect(findExistingHigherMemoryObjectIds({
      objectIds: [objectId, otherObjectId, "00000000-0000-4000-8000-000000000022"],
    })).resolves.toEqual([objectId, otherObjectId]);
  });
});
