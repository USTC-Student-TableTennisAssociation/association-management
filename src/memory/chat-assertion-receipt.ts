import { tool } from "ai";
import { z } from "zod";

import { getDatabase } from "@/db";
import { Prisma } from "@/generated/prisma/client";
import type { ChatAssertionCaptureResult } from "@/memory/chat-assertion";

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
};

const affectedObjectsSchema = z.array(z.object({
  id: z.string(),
  canonicalName: z.string(),
  resolution: z.enum(["existing", "created"]),
}));

function validDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Assertion 回执提交时间无效");
  return parsed;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 2_000) || "未知错误";
}

export async function queueChatAssertionReceipt(input: QueueReceiptInput): Promise<void> {
  const database = getDatabase();
  const submittedAt = validDate(input.submittedAt);
  await database.$transaction(async (transaction) => {
    const compilation = await transaction.memoryCompilation.findFirst({
      orderBy: [{ importedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (!compilation) throw new Error("当前没有可记录 Assertion 回执的 Compilation");

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
        compilationId: compilation.id,
        actorId: input.actorId,
        clientMessageId: input.clientMessageId,
        execution: input.execution,
        queueReason: input.queueReason,
        status: "queued",
        submittedAt,
      },
      update: {
        compilationId: compilation.id,
        execution: input.execution,
        queueReason: input.queueReason,
        status: "queued",
        submittedAt,
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

export async function markChatAssertionReceiptRunning(
  key: ChatAssertionReceiptKey,
): Promise<void> {
  const database = getDatabase();
  await database.memoryChatAssertionReceipt.updateMany({
    where: {
      actorId: key.actorId,
      clientMessageId: key.clientMessageId,
      status: { not: "published" },
    },
    data: {
      status: "running",
      startedAt: new Date(),
      completedAt: null,
      outcomeSummary: "Assertion Agent 正在提取、搜索与执行确定性校验。",
      errorMessage: null,
    },
  });
}

export async function completeChatAssertionReceipt(
  key: ChatAssertionReceiptKey,
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
    where: key,
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
  key: ChatAssertionReceiptKey,
  error: unknown,
): Promise<void> {
  const database = getDatabase();
  const detail = errorMessage(error);
  await database.memoryChatAssertionReceipt.updateMany({
    where: {
      actorId: key.actorId,
      clientMessageId: key.clientMessageId,
      status: { not: "published" },
    },
    data: {
      status: "failed",
      completedAt: new Date(),
      outcomeSummary: "Assertion 处理失败，没有确认新的发布结果。",
      errorMessage: detail,
    },
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
    "以下是系统持久化的操作状态，只用于回答‘刚才是否进入记忆/处理到哪一步’；它不是组织事实、不是 Evidence，也不能替代搜索。",
    "published 才表示 Assertion 已实际存在；queued/running 尚未完成；skipped 表示处理完成但未写入；failed 表示失败。",
    ...lines,
    "如需精确 Assertion ID、Object ID 或最新轮询结果，调用 readMemoryWriteStatus；不要把‘已排队’表述成‘已经写入’。",
  ].join("\n");
}

export function createMemoryWriteStatusTool(input: {
  actorId: string;
  conversationMessageIds: string[];
}) {
  const allowedIds = [...new Set(input.conversationMessageIds.filter(Boolean))];
  return tool({
    description: [
      "读取当前对话历史中 Chat → Assertion 的真实处理回执。",
      "用户询问‘刚才的信息有没有记住、Assertion 是否写入、后台处理到哪一步’时使用；",
      "它读取操作状态，不搜索组织知识，也不会创建 Evidence、Assertion、Object 或 Higher Memory。",
      "published 才代表已写入；queued/running/skipped/failed 都不能声称已发布。",
    ].join(""),
    inputSchema: z.object({
      messageId: z.string().trim().min(1).max(500).optional()
        .describe("可选：自动回执中给出的用户消息 ID；省略则返回当前对话最近的回执"),
    }),
    execute: async ({ messageId }) => {
      const messageIds = messageId
        ? allowedIds.includes(messageId) ? [messageId] : []
        : allowedIds;
      if (!messageIds.length) {
        return {
          receipts: [],
          message: messageId
            ? "该消息不属于当前对话，不能读取其记忆处理状态。"
            : "当前对话没有可查询的用户消息。",
        };
      }
      const receipts = await listChatAssertionReceipts({
        actorId: input.actorId,
        clientMessageIds: messageIds,
        limit: messageId ? 1 : 5,
      });
      return {
        receipts,
        message: receipts.length
          ? "已返回真实持久化回执；请严格按 status 解释，回执本身不是组织事实 Evidence。"
          : "当前对话中没有 Chat → Assertion 处理回执；这表示没有登记记录，不能推断已经写入。",
      };
    },
  });
}
