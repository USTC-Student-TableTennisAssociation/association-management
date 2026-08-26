import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUIMessageStream, readUIMessageStream } from "ai";

import type { ClubChatMessage } from "@/ai/types";
import {
  appendAssistantTextMessage,
  ChatConversationAccessError,
  hasPersistableChatContent,
  loadChatMessages,
  saveChatMessage,
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
      update: vi.fn().mockResolvedValue(undefined),
    },
    chatMessage: {
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
        position: 2,
      }),
      create: expect.objectContaining({
        clientMessageId: "assistant-1",
        role: "ASSISTANT",
        parts: message.parts,
        position: 2,
      }),
    });
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
