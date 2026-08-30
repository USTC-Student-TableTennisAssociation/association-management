import { generateText } from "ai";
import { z } from "zod";

import { getChatModel } from "@/ai/provider";
import {
  requireStructuredSubmission,
  structuredSubmissionTool,
} from "@/ai/structured-submission";
import { getDatabase } from "@/db";
import {
  buildViewChangeContext,
  type ViewChangeContextInput,
} from "@/view-runtime/application/view-change-context";

const viewHigherMemorySubmissionSchema = z.object({
  memory: z.object({
    contentMarkdown: z.string().trim().min(80, "正文不能只包含标题").max(12_000)
      .describe("供后续 AI 进入该 Business View 时直接阅读的高层动态摘要 Markdown"),
  }).nullable().describe("没有足够信息形成有用更新时返回 null，保留旧记忆"),
});

export type ViewHigherMemoryReconciliationInput = Omit<
  ViewChangeContextInput,
  "recentConversation"
>;

function maintenanceReason(input: ViewHigherMemoryReconciliationInput): string {
  const commandLabels = new Map(
    input.viewModule.commands.map((command) => [command.key, command.label]),
  );
  const commands = [...new Set(input.executions.map((execution) =>
    commandLabels.get(execution.commandKey) ?? execution.commandKey
  ))];
  return `正式 ${input.viewModule.manifest.label} 完成 post-commit 对账` +
    (commands.length ? `：${commands.join("、")}` : "");
}

function maintenancePrompt(input: ViewHigherMemoryReconciliationInput, previous: {
  contentMarkdown: string;
  maintainedAt: string;
} | null): string {
  return [
    "你负责维护 Sydaris 的 View Higher Memory。每个 Business View 只有一份这样的高层动态摘要，用于让后续 AI 快速进入这个 View 的业务语境。",
    "它不是 Card、Dimension 或 Slot 的副本，也不是精确当前状态的权威来源。精确事实和执行动作始终必须重新读取正式 Business View。",
    "你可以概括这个 View 的业务边界、稳定结构与运行方式、当前阶段、跨 Card 的重要模式、近期变化的意义、风险和未结方向；不要逐项抄写全部 Card 或字段。",
    "View-local Card 本身就是正式业务内容，不要求存在 Object anchor。即使 relatedObjects 为空，也必须依据权威 View 快照和本轮实际变化判断是否应更新摘要。",
    "Object 只作为跨信息与业务内容的认知锚点。不要把 View 的业务模型提升为全局 Object ontology，也不要在这里创建或推断 Assertion。",
    "authoritativeViewAfterChange 是本轮命令完成后的完整权威 View 快照；commandExecutions 记录实际 Command、差异与事件。previousViewHigherMemory 只用于保持连续性，发生冲突时以当前 View 为准。",
    "保留旧摘要中未被本轮变化推翻的高层理解。如果本轮信息不足以形成更有用的版本，提交 memory: null，数据库会保留旧内容。",
    "正文使用简洁自然的 Markdown，不写生成过程、模型能力、数据库 ID、Card/Object 内部引用或来源列表，也不要声称摘要已经覆盖 View 的全部实时状态。",
    "完成判断后必须调用 submitViewHigherMemory，不要在普通文本中输出 JSON。",
    JSON.stringify({
      maintenanceInstant: new Date().toISOString(),
      maintenanceReason: maintenanceReason(input),
      previousViewHigherMemory: previous,
      authoritativeViewAfterChange: buildViewChangeContext(input),
    }),
  ].join("\n\n");
}

export async function reconcileViewHigherMemoryFromViewChange(
  input: ViewHigherMemoryReconciliationInput,
): Promise<number> {
  const database = getDatabase();
  const previousRow = await database.viewHigherMemory.findUnique({
    where: { viewKey: input.snapshot.viewKey },
    select: { contentMarkdown: true, maintainedAt: true },
  });
  const previous = previousRow
    ? {
        contentMarkdown: previousRow.contentMarkdown,
        maintainedAt: previousRow.maintainedAt.toISOString(),
      }
    : null;
  const result = await generateText({
    model: getChatModel(),
    tools: {
      submitViewHigherMemory: structuredSubmissionTool({
        description: "提交该 Business View 更新后的高层动态摘要",
        schema: viewHigherMemorySubmissionSchema,
      }),
    },
    toolChoice: { type: "tool", toolName: "submitViewHigherMemory" },
    prompt: maintenancePrompt(input, previous),
    temperature: 0.2,
    maxOutputTokens: 8_000,
    timeout: { totalMs: 1_800_000, stepMs: 1_800_000 },
  });
  const submission = requireStructuredSubmission({
    toolCalls: result.toolCalls,
    toolName: "submitViewHigherMemory",
    schema: viewHigherMemorySubmissionSchema,
  });
  const memory = submission.memory;
  if (!memory) return 0;

  const maintainedAt = new Date();
  const reason = maintenanceReason(input);
  await database.$transaction(async (transaction) => {
    const installedView = await transaction.installedView.findUnique({
      where: { viewKey: input.snapshot.viewKey },
      select: { stateVersion: true },
    });
    if (!installedView) {
      throw new Error(`View ${input.snapshot.viewKey} 已不再安装`);
    }
    if (installedView.stateVersion.toString() !== input.snapshot.stateVersion) {
      throw new Error(`View ${input.snapshot.viewKey} 在 Higher Memory 生成期间已改变`);
    }
    await transaction.viewHigherMemory.upsert({
      where: { viewKey: input.snapshot.viewKey },
      create: {
        viewKey: input.snapshot.viewKey,
        contentMarkdown: memory.contentMarkdown,
        maintainedAt,
        maintenanceReason: reason,
      },
      update: {
        contentMarkdown: memory.contentMarkdown,
        maintainedAt,
        maintenanceReason: reason,
      },
    });
  }, { maxWait: 30_000, timeout: 120_000 });
  return 1;
}
