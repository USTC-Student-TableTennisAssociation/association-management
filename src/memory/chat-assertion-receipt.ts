import { tool } from "ai";
import { z } from "zod";

import { getDatabase } from "@/db";
import { Prisma } from "@/generated/prisma/client";
import type {
  ChatAssertionCaptureInput,
  ChatAssertionCaptureResult,
  ChatAssertionSemanticContext,
} from "@/memory/chat-assertion";
import type { MemoryRetrievalResult } from "@/memory/types";

export type ChatAssertionReceiptStatus =
  | "queued"
  | "running"
  | "published"
  | "skipped"
  | "failed";

export type ChatAssertionExecution = "background" | "foreground_for_view";

export type ChatAssertionReceiptKey = {
  actorId: string;
  clientMessageId: string;
};

export type ChatAssertionReceiptClaim = ChatAssertionReceiptKey & {
  startedAt: Date;
};

export type ChatAssertionReceipt = ChatAssertionReceiptKey & {
  execution: ChatAssertionExecution;
  queueReason: string;
  status: ChatAssertionReceiptStatus;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  publishedAssertions: number;
  publishedAssertionIds: string[];
  affectedObjectIds: string[];
  affectedObjects: ChatAssertionCaptureResult["affectedObjects"];
  outcomeSummary?: string;
  errorMessage?: string;
  updatedAt: string;
};

type QueueReceiptInput = ChatAssertionReceiptKey & {
  actorDisplayName: string;
  submittedAt: string;
  execution: ChatAssertionExecution;
  queueReason: string;
  conversationId?: string;
  timezone?: string;
  semanticContext?: ChatAssertionSemanticContext;
  retrieval?: MemoryRetrievalResult;
};

const affectedObjectsSchema = z.array(z.object({
  id: z.string(),
  canonicalName: z.string(),
  resolution: z.enum(["existing", "created"]),
}));

const STALE_RECEIPT_AFTER_MS = 10 * 60 * 1_000;

function validDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Assertion 回执提交时间无效");
  return parsed;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 2_000) || "未知错误";
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function persistedPayload(input: QueueReceiptInput) {
  return {
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.semanticContext
      ? { semanticContext: jsonInput(input.semanticContext) }
      : {}),
    ...(input.retrieval ? { retrieval: jsonInput(input.retrieval) } : {}),
  };
}

export async function queueChatAssertionReceipt(input: QueueReceiptInput): Promise<void> {
  const database = getDatabase();
  const submittedAt = validDate(input.submittedAt);
  await database.$transaction(async (transaction) => {
    await transaction.memoryActor.upsert({
      where: { id: input.actorId },
      create: {
        id: input.actorId,
        displayName: input.actorDisplayName,
      },
      update: { displayName: input.actorDisplayName },
    });
    await transaction.memoryChatAssertionReceipt.upsert({
      where: {
        actorId_clientMessageId: {
          actorId: input.actorId,
          clientMessageId: input.clientMessageId,
        },
      },
      create: {
        actorId: input.actorId,
        clientMessageId: input.clientMessageId,
        execution: input.execution,
        queueReason: input.queueReason,
        status: "queued",
        submittedAt,
        ...persistedPayload(input),
      },
      update: {
        execution: input.execution,
        queueReason: input.queueReason,
        status: "queued",
        submittedAt,
        ...persistedPayload(input),
        startedAt: null,
        completedAt: null,
        publishedAssertions: 0,
        publishedAssertionIds: [],
        affectedObjectIds: [],
        affectedObjects: [],
        outcomeSummary: "已登记，等待 Assertion Agent 开始处理。",
        errorMessage: null,
      },
    });
  });
}

/** Load the durable work payload owned by this receipt. */
export async function loadChatAssertionReceiptInput(
  claim: ChatAssertionReceiptClaim,
): Promise<ChatAssertionCaptureInput> {
  const database = getDatabase();
  const row = await database.memoryChatAssertionReceipt.findUnique({
    where: {
      actorId_clientMessageId: {
        actorId: claim.actorId,
        clientMessageId: claim.clientMessageId,
      },
    },
    select: {
      actor: { select: { id: true, displayName: true } },
      conversationId: true,
      clientMessageId: true,
      execution: true,
      queueReason: true,
      status: true,
      startedAt: true,
      submittedAt: true,
      timezone: true,
      semanticContext: true,
      retrieval: true,
    },
  });
  if (!row) throw new Error("找不到持久化的 Assertion 回执");
  if (row.execution !== "background") {
    throw new Error("前台 Assertion 回执不能作为后台写回输入执行");
  }
  if (
    row.status !== "running" ||
    row.startedAt?.getTime() !== claim.startedAt.getTime()
  ) {
    throw new Error("Assertion 回执已不属于当前处理者");
  }
  if (!row.timezone || !row.semanticContext || !row.retrieval) {
    throw new Error("Assertion 回执缺少可恢复的完整输入");
  }
  return {
    actor: row.actor,
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    clientMessageId: row.clientMessageId,
    submittedAt: row.submittedAt.toISOString(),
    timezone: row.timezone,
    semanticContext: row.semanticContext as unknown as ChatAssertionSemanticContext,
    retrieval: row.retrieval as unknown as MemoryRetrievalResult,
    queueDecision: { reason: row.queueReason },
  };
}

export async function claimChatAssertionReceipt(
  key: ChatAssertionReceiptKey,
): Promise<ChatAssertionReceiptClaim | undefined> {
  const database = getDatabase();
  const startedAt = new Date();
  const claimed = await database.memoryChatAssertionReceipt.updateMany({
    where: {
      actorId: key.actorId,
      clientMessageId: key.clientMessageId,
      status: "queued",
    },
    data: {
      status: "running",
      startedAt,
      completedAt: null,
      outcomeSummary: "Assertion Agent 正在提取、搜索与执行确定性校验。",
      errorMessage: null,
    },
  });
  return claimed.count === 1 ? { ...key, startedAt } : undefined;
}

export async function completeChatAssertionReceipt(
  claim: ChatAssertionReceiptClaim,
  result: ChatAssertionCaptureResult,
): Promise<void> {
  const database = getDatabase();
  const status: ChatAssertionReceiptStatus = result.publishedAssertions > 0
    ? "published"
    : "skipped";
  const outcomeSummary = status === "published"
    ? `成功发布 ${result.publishedAssertions} 条 Assertion，关联 ${result.affectedObjects.length} 个 Object。`
    : "处理完成，但没有候选通过提取与确定性校验，因此未写入 Assertion、Evidence 或新 Object。";
  await database.memoryChatAssertionReceipt.updateMany({
    where: {
      actorId: claim.actorId,
      clientMessageId: claim.clientMessageId,
      status: "running",
      startedAt: claim.startedAt,
    },
    data: {
      status,
      completedAt: new Date(),
      publishedAssertions: result.publishedAssertions,
      publishedAssertionIds: result.publishedAssertionIds,
      affectedObjectIds: result.affectedObjectIds,
      affectedObjects: result.affectedObjects as unknown as Prisma.InputJsonValue,
      outcomeSummary,
      errorMessage: null,
    },
  });
}

export async function failChatAssertionReceipt(
  claim: ChatAssertionReceiptClaim,
  error: unknown,
): Promise<void> {
  const database = getDatabase();
  const detail = errorMessage(error);
  await database.memoryChatAssertionReceipt.updateMany({
    where: {
      actorId: claim.actorId,
      clientMessageId: claim.clientMessageId,
      status: "running",
      startedAt: claim.startedAt,
    },
    data: {
      status: "failed",
      completedAt: new Date(),
      outcomeSummary: "Assertion 处理失败，没有确认新的发布结果。",
      errorMessage: detail,
    },
  });
}

/**
 * Requeue interrupted background work and return a small batch for request-time recovery.
 * Atomic claiming still decides which process may actually execute each receipt.
 */
export async function recoverPendingChatAssertionReceipts(input: {
  actorId: string;
  limit?: number;
}): Promise<ChatAssertionReceiptKey[]> {
  const database = getDatabase();
  const staleBefore = new Date(Date.now() - STALE_RECEIPT_AFTER_MS);
  await database.memoryChatAssertionReceipt.updateMany({
    where: {
      actorId: input.actorId,
      execution: "background",
      status: "running",
      OR: [
        { startedAt: null },
        { startedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: "queued",
      startedAt: null,
      completedAt: null,
      outcomeSummary: "上一次处理已中断，等待 Assertion Agent 重新处理。",
      errorMessage: null,
    },
  });
  return database.memoryChatAssertionReceipt.findMany({
    where: {
      actorId: input.actorId,
      execution: "background",
      status: "queued",
    },
    orderBy: { submittedAt: "asc" },
    take: Math.max(1, Math.min(input.limit ?? 5, 20)),
    select: { actorId: true, clientMessageId: true },
  });
}

export async function listChatAssertionReceipts(input: {
  actorId: string;
  clientMessageIds: string[];
  limit?: number;
}): Promise<ChatAssertionReceipt[]> {
  const clientMessageIds = [...new Set(input.clientMessageIds.filter(Boolean))].slice(-50);
  if (!clientMessageIds.length) return [];
  const database = getDatabase();
  const rows = await database.memoryChatAssertionReceipt.findMany({
    where: {
      actorId: input.actorId,
      clientMessageId: { in: clientMessageIds },
    },
    orderBy: [{ submittedAt: "desc" }, { updatedAt: "desc" }],
    take: Math.max(1, Math.min(input.limit ?? 3, 20)),
    select: {
      actorId: true,
      clientMessageId: true,
      execution: true,
      queueReason: true,
      status: true,
      submittedAt: true,
      startedAt: true,
      completedAt: true,
      publishedAssertions: true,
      publishedAssertionIds: true,
      affectedObjectIds: true,
      affectedObjects: true,
      outcomeSummary: true,
      errorMessage: true,
      updatedAt: true,
    },
  });
  return rows.map((row) => ({
    actorId: row.actorId,
    clientMessageId: row.clientMessageId,
    execution: row.execution === "foreground_for_view" ? "foreground_for_view" : "background",
    queueReason: row.queueReason,
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    publishedAssertions: row.publishedAssertions,
    publishedAssertionIds: row.publishedAssertionIds,
    affectedObjectIds: row.affectedObjectIds,
    affectedObjects: affectedObjectsSchema.safeParse(row.affectedObjects).data ?? [],
    ...(row.outcomeSummary ? { outcomeSummary: row.outcomeSummary } : {}),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

const statusLabel: Record<ChatAssertionReceiptStatus, string> = {
  queued: "已排队",
  running: "处理中",
  published: "已发布",
  skipped: "已跳过（未写入）",
  failed: "处理失败",
};

export function buildChatAssertionReceiptInstruction(input: {
  receipts: ChatAssertionReceipt[];
  messageTextById: ReadonlyMap<string, string>;
}): string {
  if (!input.receipts.length) return "";
  const lines = input.receipts.map((receipt) => {
    const text = input.messageTextById.get(receipt.clientMessageId)
      ?.replace(/\s+/g, " ").trim().slice(0, 160);
    const objects = receipt.affectedObjects.map((object) => object.canonicalName).join("、");
    return [
      `- 用户消息${text ? `“${text}”` : ` ${receipt.clientMessageId}`}`,
      `状态：${statusLabel[receipt.status]}`,
      `发布 Assertion：${receipt.publishedAssertions} 条`,
      objects ? `关联 Object：${objects}` : "关联 Object：无",
      receipt.outcomeSummary ? `说明：${receipt.outcomeSummary}` : undefined,
    ].filter(Boolean).join("；");
  });
  return [
    "【此前对话的 Chat → Assertion 处理回执】",
    "以下是系统持久化的操作状态，只用于回答‘刚才是否进入记忆/处理到哪一步’；它不是业务事实、不是 Evidence，也不能替代搜索。",
    "published 才表示 Assertion 已实际存在；queued/running 尚未完成；skipped 表示处理完成但未写入；failed 表示失败。",
    ...lines,
    "如需精确 Assertion ID、Object ID 或最新轮询结果，调用 readMemoryWriteStatus；不要把‘已排队’表述成‘已经写入’。",
  ].join("\n");
}

export function createMemoryWriteStatusTool(input: {
  actorId: string;
  conversationMessages: Array<{
    messageId: string;
    text: string;
  }>;
  currentMessageId: string;
}) {
  const conversationMessages = [...new Map(
    input.conversationMessages
      .filter((message) => message.messageId)
      .map((message) => [message.messageId, {
        messageId: message.messageId,
        text: message.text.replace(/\s+/g, " ").trim(),
      }]),
  ).values()];
  const currentMessage = conversationMessages.find(
    (message) => message.messageId === input.currentMessageId,
  );
  const allowedMessages = conversationMessages
    .filter((message) => message.messageId !== input.currentMessageId)
    .slice(-20);
  const allowedMessagesById = new Map(
    allowedMessages.map((message) => [message.messageId, message]),
  );
  const targetChoices = allowedMessages
    .slice(-20)
    .map((message) =>
      `${JSON.stringify(message.messageId)}：${message.text.slice(0, 160) || "（空消息）"}`
    )
    .join("\n");
  return tool({
    description: [
      "读取当前对话历史中 Chat → Assertion 的真实处理回执。",
      "用户询问‘刚才的信息有没有记住、Assertion 是否写入、后台处理到哪一步’时使用；",
      "它读取操作状态，不搜索组织知识，也不会创建 Evidence、Assertion、Object 或 Higher Memory。",
      "published 才代表已写入；queued/running/skipped/failed 都不能声称已发布。",
      "必须根据用户所指的原话，从下列先前用户消息中选择并显式传入 messageId；",
      "禁止省略 messageId、禁止用当前状态查询消息代替目标消息，也禁止把返回结果解释为其他消息的状态。",
      targetChoices ? `可查询消息：\n${targetChoices}` : "当前没有可查询的先前用户消息。",
    ].join("\n"),
    inputSchema: z.object({
      messageId: z.string().trim().min(1).max(500)
        .describe("必填：用户实际询问的那条先前用户消息 ID，必须从工具描述列出的可查询消息中选择"),
    }),
    execute: async ({ messageId }) => {
      const targetMessage = allowedMessagesById.get(messageId);
      if (!targetMessage) {
        return {
          currentMessage: currentMessage
            ? {
                clientMessageId: currentMessage.messageId,
                text: currentMessage.text,
              }
            : null,
          targetMessage: null,
          targetIsCurrentMessage: false,
          receipts: [],
          message:
            "该消息不是当前对话中可查询的先前用户消息，不能读取或推断其记忆处理状态。",
        };
      }
      const receipts = await listChatAssertionReceipts({
        actorId: input.actorId,
        clientMessageIds: [targetMessage.messageId],
        limit: 1,
      });
      return {
        currentMessage: currentMessage
          ? {
              clientMessageId: currentMessage.messageId,
              text: currentMessage.text,
            }
          : null,
        targetMessage: {
          clientMessageId: targetMessage.messageId,
          text: targetMessage.text,
        },
        targetIsCurrentMessage: targetMessage.messageId === input.currentMessageId,
        receipts,
        message: receipts.length
          ? "已返回且仅返回 targetMessage 对应的真实持久化回执；只能解释为该目标原话的状态。currentMessage 是本轮用户原话，不得把目标回执套用于 currentMessage 或其他消息。"
          : "targetMessage 没有 Chat → Assertion 处理回执；这只表示该目标消息没有登记记录，不能推断已经写入，也不能用于判断 currentMessage 或其他消息。",
      };
    },
  });
}
