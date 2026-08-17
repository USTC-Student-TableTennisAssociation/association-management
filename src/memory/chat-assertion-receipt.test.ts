import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("@/db", () => ({
  getDatabase: () => databaseState.database,
}));

import {
  buildChatAssertionReceiptInstruction,
  completeChatAssertionReceipt,
  createMemoryWriteStatusTool,
  listChatAssertionReceipts,
  loadChatAssertionWritebackJob,
  queueChatAssertionReceipt,
} from "@/memory/chat-assertion-receipt";

const executionOptions = {
  toolCallId: "tool-call-1",
  messages: [],
  abortSignal: undefined,
  context: {},
};

function receiptRow() {
  return {
    actorId: "00000000-0000-4000-8000-000000000001",
    clientMessageId: "message-previous",
    execution: "background",
    queueReason: "用户提供了新任会长信息",
    status: "published" as const,
    submittedAt: new Date("2026-08-14T01:00:00.000Z"),
    startedAt: new Date("2026-08-14T01:00:01.000Z"),
    completedAt: new Date("2026-08-14T01:00:03.000Z"),
    publishedAssertions: 1,
    publishedAssertionIds: ["assertion-1"],
    affectedObjectIds: ["object-1"],
    affectedObjects: [{
      id: "object-1",
      canonicalName: "雷岳鑫",
      resolution: "created",
    }],
    outcomeSummary: "成功发布 1 条 Assertion，关联 1 个 Object。",
    errorMessage: null,
    updatedAt: new Date("2026-08-14T01:00:03.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const transaction = {
    memoryCompilation: {
      findFirst: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000020",
      }),
    },
    memoryActor: { upsert: vi.fn().mockResolvedValue(undefined) },
    memoryChatAssertionReceipt: { upsert: vi.fn().mockResolvedValue(undefined) },
  };
  databaseState.database = {
    $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
      callback(transaction)),
    memoryChatAssertionReceipt: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([receiptRow()]),
      findUnique: vi.fn().mockResolvedValue({
        actor: {
          id: "00000000-0000-4000-8000-000000000001",
          displayName: "开发用户",
        },
        conversationId: "00000000-0000-4000-8000-000000000081",
        clientMessageId: "message-current",
        execution: "background",
        queueReason: "用户提供了新任会长信息",
        status: "queued",
        submittedAt: new Date("2026-08-14T01:00:00.000Z"),
        timezone: "Asia/Shanghai",
        semanticContext: {
          conversation: [],
          systemInstruction: "system",
          modelCalls: [],
          toolExecutions: [],
          finalAnswer: "answer",
        },
        retrieval: {
          query: "query",
          mode: "fixture",
          seedMap: { facets: [], objects: [], assertions: [], connections: [] },
        },
      }),
    },
    transaction,
  };
});

describe("Chat Assertion processing receipts", () => {
  it("persists a queued operational receipt without creating Evidence or Assertions", async () => {
    await queueChatAssertionReceipt({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorDisplayName: "开发用户",
      clientMessageId: "message-current",
      submittedAt: "2026-08-14T01:00:00.000Z",
      execution: "background",
      queueReason: "用户提供了新任会长信息",
    });

    const database = databaseState.database as {
      transaction: {
        memoryActor: { upsert: ReturnType<typeof vi.fn> };
        memoryChatAssertionReceipt: { upsert: ReturnType<typeof vi.fn> };
      };
    };
    expect(database.transaction.memoryActor.upsert).toHaveBeenCalledOnce();
    expect(database.transaction.memoryChatAssertionReceipt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          clientMessageId: "message-current",
          status: "queued",
        }),
      }),
    );
  });

  it("persists and reloads the complete recoverable background work payload", async () => {
    const semanticContext = {
      conversation: [],
      systemInstruction: "system",
      modelCalls: [],
      toolExecutions: [],
      finalAnswer: "answer",
    };
    const retrieval = {
      query: "query",
      mode: "fixture",
      seedMap: { facets: [], objects: [], assertions: [], connections: [] },
    };
    await queueChatAssertionReceipt({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorDisplayName: "开发用户",
      conversationId: "00000000-0000-4000-8000-000000000081",
      clientMessageId: "message-current",
      submittedAt: "2026-08-14T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      execution: "background",
      queueReason: "用户提供了新任会长信息",
      semanticContext,
      retrieval: retrieval as never,
    });

    const database = databaseState.database as {
      transaction: {
        memoryChatAssertionReceipt: { upsert: ReturnType<typeof vi.fn> };
      };
    };
    expect(database.transaction.memoryChatAssertionReceipt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          conversationId: "00000000-0000-4000-8000-000000000081",
          timezone: "Asia/Shanghai",
          semanticContext,
          retrieval,
        }),
      }),
    );

    await expect(loadChatAssertionWritebackJob({
      actorId: "00000000-0000-4000-8000-000000000001",
      clientMessageId: "message-current",
    })).resolves.toEqual(expect.objectContaining({
      actor: expect.objectContaining({ displayName: "开发用户" }),
      conversationId: "00000000-0000-4000-8000-000000000081",
      timezone: "Asia/Shanghai",
      semanticContext,
      retrieval,
      queueDecision: { reason: "用户提供了新任会长信息" },
    }));
  });

  it("records actual published Assertion and Object IDs", async () => {
    await completeChatAssertionReceipt({
      actorId: "00000000-0000-4000-8000-000000000001",
      clientMessageId: "message-current",
    }, {
      publishedAssertions: 1,
      publishedAssertionIds: ["assertion-1"],
      affectedObjectIds: ["object-1"],
      higherMemoryObjectIds: ["object-1"],
      affectedObjects: [{
        id: "object-1",
        canonicalName: "雷岳鑫",
        resolution: "created",
      }],
    });

    const database = databaseState.database as {
      memoryChatAssertionReceipt: { updateMany: ReturnType<typeof vi.fn> };
    };
    expect(database.memoryChatAssertionReceipt.updateMany).toHaveBeenCalledWith({
      where: {
        actorId: "00000000-0000-4000-8000-000000000001",
        clientMessageId: "message-current",
      },
      data: expect.objectContaining({
        status: "published",
        publishedAssertions: 1,
        publishedAssertionIds: ["assertion-1"],
        affectedObjectIds: ["object-1"],
      }),
    });
  });

  it("builds a compact next-turn instruction that preserves the Evidence boundary", async () => {
    const receipts = await listChatAssertionReceipts({
      actorId: "00000000-0000-4000-8000-000000000001",
      clientMessageIds: ["message-previous"],
    });
    const instruction = buildChatAssertionReceiptInstruction({
      receipts,
      messageTextById: new Map([[
        "message-previous",
        "我问了一下魏汉东，他说26-27会长是雷岳鑫",
      ]]),
    });

    expect(instruction).toContain("状态：已发布");
    expect(instruction).toContain("关联 Object：雷岳鑫");
    expect(instruction).toContain("不是组织事实、不是 Evidence");
    expect(instruction).toContain("published 才表示 Assertion 已实际存在");
  });

  it("only lets the status tool inspect messages in the current conversation", async () => {
    const toolset = createMemoryWriteStatusTool({
      actorId: "00000000-0000-4000-8000-000000000001",
      conversationMessageIds: ["message-previous"],
    });

    await expect(toolset.execute!(
      { messageId: "message-from-another-chat" },
      executionOptions,
    )).resolves.toEqual(expect.objectContaining({ receipts: [] }));

    const database = databaseState.database as {
      memoryChatAssertionReceipt: { findMany: ReturnType<typeof vi.fn> };
    };
    expect(database.memoryChatAssertionReceipt.findMany).not.toHaveBeenCalled();
  });
});
