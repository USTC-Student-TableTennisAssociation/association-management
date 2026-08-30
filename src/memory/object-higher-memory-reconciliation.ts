import { maintainHigherMemories } from "@/memory/higher-memory-maintenance";
import {
  buildViewChangeContext,
  type ViewChangeContextInput,
} from "@/view-runtime/application/view-change-context";

export type ObjectHigherMemoryReconciliationInput = Omit<
  ViewChangeContextInput,
  "recentConversation"
>;

function runtimeTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export async function reconcileObjectHigherMemoryFromViewChange(
  input: ObjectHigherMemoryReconciliationInput,
): Promise<number> {
  const existingTargets = input.objects
    .filter((object) => object.cognitiveMemory !== undefined)
    .slice(0, 6);
  if (!existingTargets.length) return 0;

  const submittedAt = new Date().toISOString();
  const latestExecution = input.executions.at(-1);
  const context = buildViewChangeContext(input);
  const result = await maintainHigherMemories({
    clientMessageId: `view-change:${latestExecution?.id ?? submittedAt}`,
    submittedAt,
    timezone: runtimeTimezone(),
    semanticContext: {
      conversation: [],
      systemInstruction:
        "这是正式 Business View Command 执行后的认知对账，不是聊天事实提取。工具输出是本轮实际读取的权威 View 状态；不得据此创建 Assertion。",
      pageContext: {
        activeViewKey: input.snapshot.viewKey,
        activePresentation: "work",
      },
      modelCalls: [],
      toolExecutions: [{
        toolCallId: `view-change:${latestExecution?.id ?? "batch"}`,
        toolName: "readAuthoritativeBusinessViewAfterCommand",
        input: { viewKey: input.snapshot.viewKey },
        output: context,
        success: true,
      }],
      finalAnswer: "本次没有对话回答；Command 已经写入正式 Business View。",
    },
    retrieval: {
      query: `${input.viewModule.manifest.label}正式修改后的 Object Higher Memory 对账`,
      mode: "object-assertion",
      seedMap: { facets: [], objects: [], assertions: [], connections: [] },
    },
    queueDecision: {
      targets: existingTargets.map((object) => ({
        scope: "object" as const,
        globalObjectId: object.id,
      })),
      reason:
        `正式 ${input.viewModule.manifest.label} Command 改变了关联 Card；` +
        "请依据本轮权威 View 状态刷新当前认知，同时保留未被推翻的历史叙事、结构和运行模型。",
    },
    existingObjectMemoriesOnly: true,
  });
  return result.objectMemories;
}
