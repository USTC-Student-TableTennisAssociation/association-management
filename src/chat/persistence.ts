import { z } from "zod";

import {
  ChatMessageRole,
  Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import { getDatabase } from "@/db";
import type { ClubChatMessage } from "@/ai/types";

export type ChatHistoryActor = {
  id: string;
  displayName: string;
};

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

async function ensureConversation(
  database: Prisma.TransactionClient,
  actor: ChatHistoryActor,
) {
  await database.memoryActor.upsert({
    where: { id: actor.id },
    update: { displayName: actor.displayName },
    create: { id: actor.id, displayName: actor.displayName },
  });
  return database.chatConversation.upsert({
    where: { actorId: actor.id },
    update: {},
    create: { actorId: actor.id },
    select: { id: true },
  });
}

export async function saveChatMessage(input: {
  actor: ChatHistoryActor;
  message: ClubChatMessage;
  position: number;
}, database: PrismaClient = getDatabase()): Promise<void> {
  await database.$transaction(async (transaction) => {
    const conversation = await ensureConversation(transaction, input.actor);
    await transaction.chatMessage.upsert({
      where: {
        conversationId_clientMessageId: {
          conversationId: conversation.id,
          clientMessageId: input.message.id,
        },
      },
      update: {
        role: databaseRole(input.message.role),
        parts: jsonParts(input.message.parts),
        position: input.position,
      },
      create: {
        conversationId: conversation.id,
        clientMessageId: input.message.id,
        role: databaseRole(input.message.role),
        parts: jsonParts(input.message.parts),
        position: input.position,
      },
    });
    await transaction.chatConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });
  });
}

export async function loadChatMessages(
  actor: ChatHistoryActor,
  database: PrismaClient = getDatabase(),
): Promise<ClubChatMessage[]> {
  return database.$transaction(async (transaction) => {
    const conversation = await ensureConversation(transaction, actor);
    const rows = await transaction.chatMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: {
        clientMessageId: true,
        role: true,
        parts: true,
      },
    });
    return rows.map((row) => ({
      id: row.clientMessageId,
      role: uiRole(row.role),
      parts: storedPartsSchema.parse(row.parts) as ClubChatMessage["parts"],
    }));
  });
}
