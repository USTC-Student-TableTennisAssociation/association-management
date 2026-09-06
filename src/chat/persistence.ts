import { z } from "zod";
import { randomUUID } from "node:crypto";

import {
  ChatMessageRole,
  Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import { getDatabase } from "@/db";
import type { ClubChatMessage } from "@/ai/types";
import type { ChatStreamStatus } from "@/ai/chat-stream-status";
import { finalStepMessageText } from "@/ai/ui-message-text";

export type ChatHistoryActor = {
  id: string;
  displayName: string;
};

export type ChatConversationSummary = {
  id: string;
  title: string;
  archivedAt: string | null;
  lastMessageAt: string;
  createdAt: string;
};

export type ReservedChatTurn = {
  userPosition: number;
  assistantPosition: number;
};

export class ChatConversationAccessError extends Error {
  constructor(message = "对话不存在或不属于当前用户。") {
    super(message);
    this.name = "ChatConversationAccessError";
  }
}

const storedPartsSchema = z.array(
  z.object({ type: z.string().min(1) }).passthrough(),
);

function databaseRole(role: ClubChatMessage["role"]): ChatMessageRole {
  if (role === "user") return ChatMessageRole.USER;
  if (role === "assistant") return ChatMessageRole.ASSISTANT;
  return ChatMessageRole.SYSTEM;
}

function uiRole(role: ChatMessageRole): ClubChatMessage["role"] {
  if (role === ChatMessageRole.USER) return "user";
  if (role === ChatMessageRole.ASSISTANT) return "assistant";
  return "system";
}

function jsonParts(parts: ClubChatMessage["parts"]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(parts)) as Prisma.InputJsonValue;
}

const repeatingPersistentDataParts = new Set([
  "data-viewCommandProposal",
  "data-objectChangeProposal",
  "data-libraryProposal",
]);

/**
 * Chat history keeps the user-visible answer and lightweight UI state. Raw
 * tool inputs/outputs and repeated retrieval snapshots belong in the debug
 * trace; persisting them here makes stream finalization unnecessarily large.
 */
export function compactChatMessageForPersistence(
  message: ClubChatMessage,
): ClubChatMessage {
  if (message.role !== "assistant") return message;

  const text = finalStepMessageText(message);
  const reasoning = message.parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
  const lastSingletonIndex = new Map<string, number>();
  message.parts.forEach((part, index) => {
    if (part.type.startsWith("data-") && !repeatingPersistentDataParts.has(part.type)) {
      lastSingletonIndex.set(part.type, index);
    }
  });
  const dataParts = message.parts.filter((part, index) =>
    part.type.startsWith("data-") && (
      repeatingPersistentDataParts.has(part.type) ||
      lastSingletonIndex.get(part.type) === index
    )
  );

  return {
    ...message,
    parts: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...(reasoning ? [{ type: "reasoning" as const, text: reasoning }] : []),
      ...dataParts,
    ],
  };
}

export function withTerminalChatState(
  message: ClubChatMessage,
  status: ChatStreamStatus,
): ClubChatMessage {
  if (message.role !== "assistant") return message;
  const hasAnswerLifecycle = message.parts.some(
    (part) => part.type === "data-answerLifecycle" && part.data.phase === "answer_complete",
  );
  return {
    ...message,
    parts: [
      ...message.parts.filter((part) => part.type !== "data-streamStatus"),
      { type: "data-streamStatus", data: status },
      ...(hasAnswerLifecycle
        ? []
        : [{ type: "data-answerLifecycle" as const, data: { phase: "answer_complete" as const } }]),
    ],
  };
}

function summary(row: {
  id: string;
  title: string;
  archivedAt: Date | null;
  lastMessageAt: Date;
  createdAt: Date;
}): ChatConversationSummary {
  return {
    id: row.id,
    title: row.title,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireOwnedConversation(
  database: Prisma.TransactionClient,
  actorId: string,
  conversationId: string,
) {
  const conversation = await database.chatConversation.findFirst({
    where: { id: conversationId, actorId },
    select: {
      id: true,
      title: true,
      archivedAt: true,
      lastMessageAt: true,
      createdAt: true,
    },
  });
  if (!conversation) throw new ChatConversationAccessError();
  return conversation;
}

export async function createChatConversation(
  actor: ChatHistoryActor,
  title = "新对话",
  database: PrismaClient = getDatabase(),
): Promise<ChatConversationSummary> {
  const cleanTitle = title.trim().slice(0, 120) || "新对话";
  const row = await database.chatConversation.create({
    data: { actorId: actor.id, title: cleanTitle },
    select: {
      id: true,
      title: true,
      archivedAt: true,
      lastMessageAt: true,
      createdAt: true,
    },
  });
  return summary(row);
}

export async function listChatConversations(
  actor: ChatHistoryActor,
  database: PrismaClient = getDatabase(),
): Promise<ChatConversationSummary[]> {
  const rows = await database.chatConversation.findMany({
    where: { actorId: actor.id, archivedAt: null },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      archivedAt: true,
      lastMessageAt: true,
      createdAt: true,
    },
  });
  return rows.map(summary);
}

export async function updateChatConversation(input: {
  actor: ChatHistoryActor;
  conversationId: string;
  title?: string;
  archived?: boolean;
}, database: PrismaClient = getDatabase()): Promise<ChatConversationSummary> {
  return database.$transaction(async (transaction) => {
    await requireOwnedConversation(transaction, input.actor.id, input.conversationId);
    const title = input.title === undefined
      ? undefined
      : input.title.trim().slice(0, 120);
    if (input.title !== undefined && !title) {
      throw new Error("对话标题不能为空。");
    }
    const row = await transaction.chatConversation.update({
      where: { id: input.conversationId },
      data: {
        ...(title ? { title } : {}),
        ...(input.archived === undefined
          ? {}
          : { archivedAt: input.archived ? new Date() : null }),
      },
      select: {
        id: true,
        title: true,
        archivedAt: true,
        lastMessageAt: true,
        createdAt: true,
      },
    });
    return summary(row);
  });
}

function firstMessageTitle(message: ClubChatMessage): string | undefined {
  if (message.role !== "user") return undefined;
  const text = message.parts
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

export function hasPersistableChatContent(message: ClubChatMessage): boolean {
  if (message.role !== "assistant") return true;
  return message.parts.some((part) =>
    (part.type === "text" && part.text.trim().length > 0) ||
    (part.type === "reasoning" && part.text.trim().length > 0) ||
    part.type.startsWith("data-")
  );
}

export async function saveChatMessage(input: {
  actor: ChatHistoryActor;
  conversationId: string;
  message: ClubChatMessage;
  position: number;
}, database: PrismaClient = getDatabase()): Promise<void> {
  const message = compactChatMessageForPersistence(input.message);
  if (!hasPersistableChatContent(message)) return;
  await database.$transaction(async (transaction) => {
    const conversation = await requireOwnedConversation(
      transaction,
      input.actor.id,
      input.conversationId,
    );
    await transaction.chatMessage.upsert({
      where: {
        conversationId_clientMessageId: {
          conversationId: conversation.id,
          clientMessageId: message.id,
        },
      },
      update: {
        role: databaseRole(message.role),
        parts: jsonParts(message.parts),
      },
      create: {
        conversationId: conversation.id,
        clientMessageId: message.id,
        role: databaseRole(message.role),
        parts: jsonParts(message.parts),
        position: input.position,
      },
    });
    const suggestedTitle = conversation.title === "新对话"
      ? firstMessageTitle(message)
      : undefined;
    await transaction.chatConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        ...(suggestedTitle ? { title: suggestedTitle } : {}),
      },
    });
  });
}

/**
 * Atomically reserves a user/assistant pair in the durable conversation
 * timeline. Client array indexes are deliberately ignored: deletions,
 * compaction, reloads, and another browser must never be able to reuse an old
 * position.
 */
export async function reserveChatTurn(input: {
  actor: ChatHistoryActor;
  conversationId: string;
  userMessage: ClubChatMessage;
}, database: PrismaClient = getDatabase()): Promise<ReservedChatTurn> {
  if (input.userMessage.role !== "user") {
    throw new Error("只有用户消息可以开始新的对话轮次。");
  }
  const message = input.userMessage;
  return database.$transaction(async (transaction) => {
    const conversation = await requireOwnedConversation(
      transaction,
      input.actor.id,
      input.conversationId,
    );
    const existing = await transaction.chatMessage.findUnique({
      where: {
        conversationId_clientMessageId: {
          conversationId: conversation.id,
          clientMessageId: message.id,
        },
      },
      select: { position: true },
    });
    if (existing) {
      await transaction.chatMessage.update({
        where: {
          conversationId_clientMessageId: {
            conversationId: conversation.id,
            clientMessageId: message.id,
          },
        },
        data: {
          role: databaseRole(message.role),
          parts: jsonParts(message.parts),
        },
      });
      return {
        userPosition: existing.position,
        assistantPosition: existing.position + 1,
      };
    }

    const reserved = await transaction.chatConversation.update({
      where: { id: conversation.id },
      data: { nextMessagePosition: { increment: 2 } },
      select: { nextMessagePosition: true },
    });
    const userPosition = reserved.nextMessagePosition - 2;
    await transaction.chatMessage.create({
      data: {
        conversationId: conversation.id,
        clientMessageId: message.id,
        role: databaseRole(message.role),
        parts: jsonParts(message.parts),
        position: userPosition,
      },
    });
    const suggestedTitle = conversation.title === "新对话"
      ? firstMessageTitle(message)
      : undefined;
    await transaction.chatConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        ...(suggestedTitle ? { title: suggestedTitle } : {}),
      },
    });
    return { userPosition, assistantPosition: userPosition + 1 };
  });
}

export async function appendAssistantTextMessage(input: {
  actor: ChatHistoryActor;
  conversationId: string;
  text: string;
  messageId?: string;
}, database: PrismaClient = getDatabase()): Promise<ClubChatMessage> {
  const cleanText = input.text.trim();
  if (!cleanText) throw new Error("主动消息不能为空。");
  const message: ClubChatMessage = {
    id: input.messageId ?? `view-attention-${randomUUID()}`,
    role: "assistant",
    parts: [{ type: "text", text: cleanText }],
  };
  await database.$transaction(async (transaction) => {
    const conversation = await requireOwnedConversation(
      transaction,
      input.actor.id,
      input.conversationId,
    );
    if (input.messageId) {
      const existing = await transaction.chatMessage.findUnique({
        where: {
          conversationId_clientMessageId: {
            conversationId: conversation.id,
            clientMessageId: input.messageId,
          },
        },
        select: { id: true },
      });
      if (existing) return;
    }
    const reserved = await transaction.chatConversation.update({
      where: { id: conversation.id },
      data: { nextMessagePosition: { increment: 1 } },
      select: { nextMessagePosition: true },
    });
    await transaction.chatMessage.create({
      data: {
        conversationId: conversation.id,
        clientMessageId: message.id,
        role: ChatMessageRole.ASSISTANT,
        parts: jsonParts(message.parts),
        position: reserved.nextMessagePosition - 1,
      },
    });
    await transaction.chatConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
  });
  return message;
}

export async function loadChatMessages(
  actor: ChatHistoryActor,
  conversationId: string,
  database: PrismaClient = getDatabase(),
): Promise<ClubChatMessage[]> {
  return database.$transaction(async (transaction) => {
    const conversation = await requireOwnedConversation(
      transaction,
      actor.id,
      conversationId,
    );
    const rows = await transaction.chatMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: {
        clientMessageId: true,
        role: true,
        parts: true,
      },
    });
    return rows.flatMap((row) => {
      const message: ClubChatMessage = {
        id: row.clientMessageId,
        role: uiRole(row.role),
        parts: storedPartsSchema.parse(row.parts) as ClubChatMessage["parts"],
      };
      return hasPersistableChatContent(message) ? [message] : [];
    });
  });
}
