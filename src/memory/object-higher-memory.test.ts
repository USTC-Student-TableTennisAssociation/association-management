import { beforeEach, describe, expect, it, vi } from "vitest";

const aiState = vi.hoisted(() => ({ generateText: vi.fn() }));
const databaseState = vi.hoisted(() => ({ database: undefined as unknown }));
const exploreState = vi.hoisted(() => ({ createToolset: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return { ...original, generateText: aiState.generateText };
});
vi.mock("@/ai/provider", () => ({ getChatModel: () => ({}) }));
vi.mock("@/db", () => ({ getDatabase: () => databaseState.database }));
vi.mock("@/memory/explore-toolset", () => ({
  createMemoryExploreToolset: exploreState.createToolset,
}));

import {
  findExistingHigherMemoryObjectIds,
  maintainObjectHigherMemories,
} from "@/memory/object-higher-memory";
import type { MemoryRetrievalResult } from "@/memory/types";

const compilationId = "00000000-0000-4000-8000-000000000010";
const objectId = "00000000-0000-4000-8000-000000000020";

function retrieval(): MemoryRetrievalResult {
  return {
    query: "测试社团",
    mode: "object-assertion",
    compilationId,
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
  const transaction = {
    memoryCompilation: { findFirst: vi.fn().mockResolvedValue({ id: compilationId }) },
    memoryGlobalObject: { count: vi.fn().mockResolvedValue(1) },
    memoryObjectHigherMemory: { upsert },
  };
  databaseState.database = {
    memoryCompilation: { findFirst: vi.fn().mockResolvedValue({ id: compilationId }) },
    memoryGlobalObject: {
      findMany: vi.fn().mockResolvedValue([{
        id: objectId,
        globalObjectKey: "test-club",
        canonicalName: "测试社团",
        identitySummaryMarkdown: "测试社团 identity",
      }]),
    },
    memoryObjectHigherMemory: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<void>) =>
      callback(transaction)
    ),
    __transaction: transaction,
  };
  exploreState.createToolset.mockReturnValue({
    searchMemory: { description: "search" },
    followObject: { description: "follow" },
  });
  aiState.generateText.mockResolvedValue({
    output: {
      memories: [{
        globalObjectId: objectId,
        contentMarkdown: "## 当前认知\n\n测试社团目前的状态需要结合有效期理解。",
      }],
    },
  });
});

describe("maintainObjectHigherMemories", () => {
  it("stores only the rebuilt cognition document and maintenance metadata", async () => {
    await expect(maintainObjectHigherMemories(input())).resolves.toBe(1);

    expect(exploreState.createToolset).toHaveBeenCalledWith(expect.objectContaining({
      preferHigherMemory: false,
      allowKnownObjectIds: [objectId],
    }));
    const call = aiState.generateText.mock.calls[0][0];
    expect(call.prompt).toContain("main system");
    expect(call.prompt).toContain("这是本轮回答");
    expect(call.prompt).toContain("不需要输出、挑选或维护 Assertion ID");

    const transaction = (databaseState.database as {
      __transaction: { memoryObjectHigherMemory: { upsert: ReturnType<typeof vi.fn> } };
    }).__transaction;
    expect(transaction.memoryObjectHigherMemory.upsert).toHaveBeenCalledWith({
      where: { globalObjectId: objectId },
      create: expect.objectContaining({
        compilationId,
        globalObjectId: objectId,
        contentMarkdown: expect.stringContaining("当前认知"),
        triggerMessageId: "message-current",
        maintenanceReason: "本轮围绕测试社团形成了实质理解",
      }),
      update: expect.objectContaining({
        contentMarkdown: expect.stringContaining("当前认知"),
      }),
    });
    expect(JSON.stringify(transaction.memoryObjectHigherMemory.upsert.mock.calls))
      .not.toContain("AssertionId");
  });

  it("preserves old memory when the agent cannot form useful new cognition", async () => {
    aiState.generateText.mockResolvedValue({ output: { memories: [] } });

    await expect(maintainObjectHigherMemories(input())).resolves.toBe(0);

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
      compilationId,
    })).resolves.toEqual([objectId, otherObjectId]);
  });
});
