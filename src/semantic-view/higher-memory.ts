import { generateText } from "ai";
import { z } from "zod";

import { getChatModel } from "@/ai/provider";
import {
  readStructuredSubmission,
  structuredSubmissionTool,
} from "@/ai/structured-submission";
import { getDatabase } from "@/db";
import { businessViewDefinitions } from "@/semantic-view/card-types";
import { getSemanticView } from "@/semantic-view/service";
import type { BusinessViewKey } from "@/semantic-view/types";

const viewHigherMemorySchema = z.object({
  contentMarkdown: z.string().trim().min(40).max(800),
});

export function viewHigherMemoryQualityIssue(contentMarkdown: string): string | undefined {
  const parsed = viewHigherMemorySchema.shape.contentMarkdown.safeParse(contentMarkdown);
  if (!parsed.success) return "正文长度或格式不符合 View Higher Memory 约束";

  const repeatedLines = new Map<string, number>();
  for (const line of contentMarkdown.split(/\r?\n/)) {
    const normalized = line.replace(/^#+\s*/, "").replace(/\s+/g, "").trim();
    if (normalized.length < 8) continue;
    const count = (repeatedLines.get(normalized) ?? 0) + 1;
    if (count >= 3) return "正文包含重复段落";
    repeatedLines.set(normalized, count);
  }

  const compact = contentMarkdown.replace(/\s+/g, "");
  const windows = new Map<string, number>();
  for (let index = 0; index + 16 <= compact.length; index += 4) {
    const window = compact.slice(index, index + 16);
    const count = (windows.get(window) ?? 0) + 1;
    if (count >= 4) return "正文包含异常重复片段";
    windows.set(window, count);
  }
  return undefined;
}

export type ViewHigherMemorySnapshot = {
  viewKey: BusinessViewKey;
  contentMarkdown: string;
  maintainedAt: string;
};

export async function loadViewHigherMemory(
  viewKey: BusinessViewKey,
): Promise<ViewHigherMemorySnapshot | undefined> {
  const row = await getDatabase().semanticViewHigherMemory.findUnique({
    where: { viewKey },
    select: { viewKey: true, contentMarkdown: true, maintainedAt: true },
  });
  if (!row || viewHigherMemoryQualityIssue(row.contentMarkdown)) return undefined;
  return {
    viewKey,
    contentMarkdown: row.contentMarkdown,
    maintainedAt: row.maintainedAt.toISOString(),
  };
}

export function buildViewOrientationContext(): string {
  const views = Object.values(businessViewDefinitions).map((view) =>
    `- ${view.key}（${view.label}）：${view.retrievalDescription}`
  );
  return [
    "Business View Compass：只用于选择理解问题的业务视角，不是当前状态证据。",
    ...views,
    "需要某个 View 的当前状态时调用 openBusinessContext；届时才读取其 Higher Memory、相关 Cards 和 Object Higher Memory。",
  ].join("\n");
}

export async function maintainViewHigherMemory(
  viewKey: BusinessViewKey,
  reason: string,
): Promise<void> {
  const view = await getSemanticView(viewKey);
  const definition = businessViewDefinitions[viewKey];
  const prompt = [
    `你负责重建 ${viewKey} 的 View Higher Memory。`,
    "它是打开对应 Business Context 后提供的精简当前状态。",
    "只能综合输入中已经批准的 View 状态，不得创作事实，不得把空槽位写成现实中不存在。",
    "只写 3 部分：已有正式内容、对当前工作有影响的明显空白、必要时间边界。不得列举 Card Types、Slot Schema、关系合同、View 定位或建议的下一步。",
    "全文尽量控制在 500 个中文字内；不要写数据库 ID、V#/A#/H# 或生成过程。必须调用 submitViewHigherMemory。",
    JSON.stringify({
      frame: {
        meaning: definition.meaning,
        retrievalDescription: definition.retrievalDescription,
      },
      approvedViewState: view,
    }),
  ].join("\n\n");
  const result = await generateText({
    model: getChatModel(),
    tools: {
      submitViewHigherMemory: structuredSubmissionTool({
        description: "提交重建后的 View Higher Memory",
        schema: viewHigherMemorySchema,
      }),
    },
    toolChoice: { type: "tool", toolName: "submitViewHigherMemory" },
    prompt,
    temperature: 0.15,
    maxOutputTokens: 2_000,
    timeout: { totalMs: 180_000, stepMs: 180_000 },
  });
  const output = readStructuredSubmission({
    toolCalls: result.toolCalls,
    toolName: "submitViewHigherMemory",
    schema: viewHigherMemorySchema,
  });
  if (!output) throw new Error(`View Higher Memory 未提交：${viewKey}`);
  const qualityIssue = viewHigherMemoryQualityIssue(output.contentMarkdown);
  if (qualityIssue) {
    throw new Error(`View Higher Memory 质量校验失败：${qualityIssue}`);
  }
  await getDatabase().semanticViewHigherMemory.upsert({
    where: { viewKey },
    create: {
      viewKey,
      contentMarkdown: output.contentMarkdown,
      maintainedAt: new Date(),
      maintenanceReason: reason,
    },
    update: {
      contentMarkdown: output.contentMarkdown,
      maintainedAt: new Date(),
      maintenanceReason: reason,
    },
  });
}
