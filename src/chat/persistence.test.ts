import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadChatMessages, saveChatMessage } from "@/chat/persistence";

const actor = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "开发用户",
};

function databaseFixture(rows: unknown[] = []) {
  const transaction = {
    memoryActor: {
      upsert: vi.fn().mockResolvedValue(undefined),
    },
    chatConversation: {
      upsert: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000002",
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

    await saveChatMessage({ actor, message, position: 2 }, database as never);

    expect(transaction.memoryActor.upsert).toHaveBeenCalledWith({
      where: { id: actor.id },
      update: { displayName: actor.displayName },
      create: actor,
    });
    expect(transaction.chatMessage.upsert).toHaveBeenCalledWith({
      where: {
        conversationId_clientMessageId: {
          conversationId: "00000000-0000-4000-8000-000000000002",
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

    const messages = await loadChatMessages(actor, database as never);

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
});
