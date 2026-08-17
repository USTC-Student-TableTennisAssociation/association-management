import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChatConversationAccessError,
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
  it("upserts complete UI message parts by stable client message id", async () => {
    const { database, transaction } = databaseFixture();
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      parts: [
        { type: "text" as const, text: "完整回答" },
        {
          type: "data-viewProposal" as const,
          data: {
            id: "00000000-0000-4000-8000-000000000099",
            viewKey: "society_information" as const,
            status: "pending" as const,
            reason: "测试",
            createdAt: "2026-08-15T00:00:00.000Z",
            changes: [],
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

  it("restores messages in persisted order without flattening structured parts", async () => {
    const { database, transaction } = databaseFixture([{
      clientMessageId: "user-1",
      role: "USER",
      parts: [{ type: "text", text: "采购怎么报销？" }],
    }, {
      clientMessageId: "assistant-1",
      role: "ASSISTANT",
      parts: [{ type: "data-viewReferences", data: { references: [] } }],
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
      parts: [{ type: "data-viewReferences", data: { references: [] } }],
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
