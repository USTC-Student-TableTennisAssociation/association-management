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
    toolCalls: [{
      toolName: "submitObjectHigherMemory",
      input: {
      memories: [{
        globalObjectId: objectId,
        contentMarkdown: "## 当前认知\n\n测试社团目前的状态需要结合相关 Assertion 的有效期理解。现有记录表明团队正在逐步整理工作方式，但这些记录没有证明所有状态截至当前仍然有效；后续协作应继续核对最新进展、明确仍未解决的事项，并保留记录之间可能存在的时间差异与资料缺口。",
      }],
      },
    }],
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
    expect(call.tools).toHaveProperty("submitObjectHigherMemory");
    expect(call.toolChoice).toBe("required");

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

  it("rejects a title-only cognition document", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitObjectHigherMemory",
        input: {
          memories: [{
            globalObjectId: objectId,
            contentMarkdown: "# 测试社团",
          }],
        },
      }],
    });

    await expect(maintainObjectHigherMemories(input())).rejects.toThrow("正文不能只包含标题");

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
