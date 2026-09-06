import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUIMessageStream, readUIMessageStream } from "ai";

import type { ClubChatMessage } from "@/ai/types";
import {
  appendAssistantTextMessage,
  ChatConversationAccessError,
  compactChatMessageForPersistence,
  hasPersistableChatContent,
  loadChatMessages,
  reserveChatTurn,
  saveChatMessage,
  withTerminalChatState,
} from "@/chat/persistence";

const actor = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "开发用户",
};
const conversationId = "00000000-0000-4000-8000-000000000002";

function databaseFixture(rows: unknown[] = []) {
  const transaction = {
    chatConversation: {
      findFirst: vi.fn().mockResolvedValue({
        id: conversationId,
        title: "新对话",
        archivedAt: null,
        lastMessageAt: new Date("2026-08-16T00:00:00.000Z"),
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
      }),
      update: vi.fn().mockImplementation((input: { select?: { nextMessagePosition?: boolean } }) =>
        input.select?.nextMessagePosition
          ? Promise.resolve({ nextMessagePosition: 6 })
          : Promise.resolve(undefined)),
    },
    chatMessage: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
      aggregate: vi.fn().mockResolvedValue({ _max: { position: 4 } }),
      create: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
      findMany: vi.fn().mockResolvedValue(rows),
    },
  };
  const database = {
    $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
      callback(transaction)),
  };
  return { database, transaction };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chat persistence", () => {
  it("drops raw tool payloads and repeated snapshots before saving assistant history", () => {
    const message = {
      id: "assistant-large",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "dynamic-tool",
          toolName: "readSourceDocument",
          toolCallId: "tool-1",
          state: "output-available",
          input: { mode: "full" },
          output: { blocks: [{ markdown: "不应进入聊天历史的大段正文" }] },
        },
        {
          type: "data-memorySearch",
          data: { mode: "structured", seedMap: { assertions: [{ renderedStatement: "旧快照" }] } },
        },
        { type: "step-start" },
        { type: "text", text: "最终回答" },
        {
          type: "data-memorySearch",
          data: { mode: "structured", seedMap: { assertions: [{ renderedStatement: "最终快照" }] } },
        },
        {
          type: "data-answerLifecycle",
          data: { phase: "answer_complete" },
        },
      ],
    } as unknown as ClubChatMessage;

    const compacted = compactChatMessageForPersistence(message);
    const serialized = JSON.stringify(compacted);

    expect(serialized).not.toContain("不应进入聊天历史的大段正文");
    expect(serialized).not.toContain("旧快照");
    expect(serialized).toContain("最终回答");
    expect(serialized).toContain("最终快照");
    expect(compacted.parts).toContainEqual({
      type: "data-answerLifecycle",
      data: { phase: "answer_complete" },
    });
  });

  it("keeps reasoning-only and stream-status-only assistant diagnostics", () => {
    expect(hasPersistableChatContent({
      id: "assistant-reasoning",
      role: "assistant",
      parts: [{ type: "reasoning", text: "正在检查检索结果" }],
    })).toBe(true);
    expect(hasPersistableChatContent({
      id: "assistant-status",
      role: "assistant",
      parts: [{
        type: "data-streamStatus",
        data: {
          status: "failed",
          completionKind: "error",
          reasoningChars: 0,
          contentChars: 0,
          toolCallCount: 0,
          modelCallCount: 1,
          retryCount: 0,
          partial: true,
        },
      }],
    })).toBe(true);
  });

  it("adds terminal lifecycle and the authoritative final stream status before persistence", () => {
    const message = {
      id: "assistant-partial",
      role: "assistant",
      parts: [{ type: "text", text: "局部结果" }],
    } as ClubChatMessage;
    const status = {
      status: "incomplete" as const,
      completionKind: "tool_call" as const,
      finishReason: "tool-calls",
      reasoningChars: 10,
      contentChars: 4,
      toolCallCount: 2,
      modelCallCount: 3,
      retryCount: 0,
      partial: true,
    };

    expect(withTerminalChatState(message, status).parts).toEqual([
      { type: "text", text: "局部结果" },
      { type: "data-streamStatus", data: status },
      { type: "data-answerLifecycle", data: { phase: "answer_complete" } },
    ]);
  });

  it("upserts complete UI message parts by stable client message id", async () => {
    const { database, transaction } = databaseFixture();
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      parts: [
        { type: "text" as const, text: "完整回答" },
        {
          type: "data-viewCommandProposal" as const,
          data: {
            proposalId: "00000000-0000-4000-8000-000000000099",
            viewKey: "society_information",
            commandKey: "society.update_profile",
            commandVersion: "1",
            stateVersion: "0",
            input: { cardId: "00000000-0000-4000-8000-000000000091", rating: "三星" },
          },
        },
      ],
    };

    await saveChatMessage({ actor, conversationId, message, position: 2 }, database as never);

    expect(transaction.chatConversation.findFirst).toHaveBeenCalledWith({
      where: { id: conversationId, actorId: actor.id },
      select: expect.any(Object),
    });
    expect(transaction.chatMessage.upsert).toHaveBeenCalledWith({
      where: {
        conversationId_clientMessageId: {
          conversationId,
          clientMessageId: "assistant-1",
        },
      },
      update: expect.objectContaining({
        role: "ASSISTANT",
        parts: message.parts,
      }),
      create: expect.objectContaining({
        clientMessageId: "assistant-1",
        role: "ASSISTANT",
        parts: message.parts,
        position: 2,
      }),
    });
  });

  it("reserves durable user and assistant positions from the server counter", async () => {
    const { database, transaction } = databaseFixture();
    transaction.chatConversation.update
      .mockResolvedValueOnce({ nextMessagePosition: 18 })
      .mockResolvedValueOnce(undefined);

    const positions = await reserveChatTurn({
      actor,
      conversationId,
      userMessage: {
        id: "user-after-gap",
        role: "user",
        parts: [{ type: "text", text: "继续" }],
      },
    }, database as never);

    expect(positions).toEqual({ userPosition: 16, assistantPosition: 17 });
    expect(transaction.chatConversation.update).toHaveBeenNthCalledWith(1, {
      where: { id: conversationId },
      data: { nextMessagePosition: { increment: 2 } },
      select: { nextMessagePosition: true },
    });
    expect(transaction.chatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientMessageId: "user-after-gap",
        position: 16,
      }),
    });
    expect(transaction.chatMessage.aggregate).not.toHaveBeenCalled();
  });

  it("keeps the original durable position when the same user message is retried", async () => {
    const { database, transaction } = databaseFixture();
    transaction.chatMessage.findUnique.mockResolvedValue({ position: 12 });

    const positions = await reserveChatTurn({
      actor,
      conversationId,
      userMessage: {
        id: "user-retry",
        role: "user",
        parts: [{ type: "text", text: "重试" }],
      },
    }, database as never);

    expect(positions).toEqual({ userPosition: 12, assistantPosition: 13 });
    expect(transaction.chatMessage.update).toHaveBeenCalledWith({
      where: {
        conversationId_clientMessageId: {
          conversationId,
          clientMessageId: "user-retry",
        },
      },
      data: expect.objectContaining({ parts: [{ type: "text", text: "重试" }] }),
    });
    expect(transaction.chatConversation.update).not.toHaveBeenCalled();
    expect(transaction.chatMessage.create).not.toHaveBeenCalled();
  });

  it("appends proactive assistant text after the latest persisted position", async () => {
    const { database, transaction } = databaseFixture();

    const message = await appendAssistantTextMessage({
      actor,
      conversationId,
      text: "需要我同步检查相关知识吗？",
    }, database as never);

    expect(message).toEqual(expect.objectContaining({
      role: "assistant",
      parts: [{ type: "text", text: "需要我同步检查相关知识吗？" }],
    }));
    expect(message.id).toMatch(/^view-attention-/);
    expect(transaction.chatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId,
        role: "ASSISTANT",
        position: 5,
      }),
    });
  });

  it("does not append the same proactive notice twice", async () => {
    const { database, transaction } = databaseFixture();
    transaction.chatMessage.findUnique.mockResolvedValue({ id: "stored-message" });

    const message = await appendAssistantTextMessage({
      actor,
      conversationId,
      text: "请确认当前正式口径。",
      messageId: "view-reaction-reaction-1",
    }, database as never);

    expect(message.id).toBe("view-reaction-reaction-1");
    expect(transaction.chatMessage.create).not.toHaveBeenCalled();
  });

  it("persists partial text, reasoning, and failure status from an interrupted UI stream", async () => {
    const stream = createUIMessageStream<ClubChatMessage>({
      generateId: () => "assistant-interrupted",
      execute: ({ writer }) => {
        writer.write({ type: "reasoning-start", id: "reasoning" });
        writer.write({
          type: "reasoning-delta",
          id: "reasoning",
          delta: "正在核对证据",
        });
        writer.write({ type: "reasoning-end", id: "reasoning" });
        writer.write({ type: "text-start", id: "answer" });
        writer.write({ type: "text-delta", id: "answer", delta: "已生成的部分正文" });
        writer.write({ type: "text-end", id: "answer" });
        writer.write({
          type: "data-streamStatus",
          data: {
            status: "failed",
            completionKind: "error",
            failureCode: "timeout",
            reasoningChars: 6,
            contentChars: 8,
            toolCallCount: 0,
            modelCallCount: 2,
            retryCount: 1,
            partial: true,
            error: {
              name: "TimeoutError",
              message: "Chunk timeout of 180000ms exceeded",
            },
          },
        });
      },
    });
    let responseMessage: ClubChatMessage | undefined;
    for await (const message of readUIMessageStream<ClubChatMessage>({ stream })) {
      responseMessage = message;
    }
    expect(responseMessage).toBeDefined();

    const { database, transaction } = databaseFixture();
    await saveChatMessage({
      actor,
      conversationId,
      message: responseMessage!,
      position: 2,
    }, database as never);

    expect(transaction.chatMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({ type: "reasoning", text: "正在核对证据" }),
            expect.objectContaining({ type: "text", text: "已生成的部分正文" }),
            expect.objectContaining({
              type: "data-streamStatus",
              data: expect.objectContaining({
                status: "failed",
                failureCode: "timeout",
                retryCount: 1,
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("filters structured-only assistant placeholders while restoring history", async () => {
    const { database, transaction } = databaseFixture([{
      clientMessageId: "user-1",
      role: "USER",
      parts: [{ type: "text", text: "采购怎么报销？" }],
    }, {
      clientMessageId: "assistant-1",
      role: "ASSISTANT",
      parts: [
        { type: "text", text: "请查看 View。" },
        { type: "data-viewReferences", data: { references: [] } },
      ],
    }]);

    const messages = await loadChatMessages(actor, conversationId, database as never);

    expect(transaction.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      }),
    );
    expect(messages).toEqual([{
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "采购怎么报销？" }],
    }, {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "text", text: "请查看 View。" },
        { type: "data-viewReferences", data: { references: [] } },
      ],
    }]);
  });

  it("rejects a conversation id that does not belong to the current actor", async () => {
    const { database, transaction } = databaseFixture();
    transaction.chatConversation.findFirst.mockResolvedValue(null);

    await expect(loadChatMessages(actor, conversationId, database as never))
      .rejects.toBeInstanceOf(ChatConversationAccessError);
    expect(transaction.chatMessage.findMany).not.toHaveBeenCalled();
  });
});
