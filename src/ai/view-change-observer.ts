import { generateText } from "ai";
import { z } from "zod";

import { getChatModel } from "@/ai/provider";
import {
  readStructuredSubmission,
  structuredSubmissionTool,
} from "@/ai/structured-submission";
import { modelHistoryMessageText } from "@/ai/ui-message-text";
import type { ClubChatMessage } from "@/ai/types";
import {
  buildViewChangeContext,
  type ViewChangeContextInput,
} from "@/view-runtime/application/view-change-context";

const decisionSchema = z.object({
  action: z.enum(["silent", "respond"]),
  message: z.string().trim().max(800)
    .describe("silent 时必须为空字符串；respond 时必须填写一条用户可见的中文消息"),
  reason: z.string().trim().min(1).max(500),
}).superRefine((decision, context) => {
  if (decision.action !== "silent" && !decision.message) {
    context.addIssue({
      code: "custom",
      path: ["message"],
      message: "respond 决定必须提供用户可见消息",
    });
  }
  if (decision.action === "silent" && decision.message) {
    context.addIssue({
      code: "custom",
      path: ["message"],
      message: "silent 决定不能附带用户可见消息",
    });
  }
});

export type ViewChangeAttentionDecision = z.output<typeof decisionSchema>;

export type ViewChangeObserverInput = Omit<
  ViewChangeContextInput,
  "recentConversation"
> & {
  conversation: readonly ClubChatMessage[];
};

export function buildViewChangeObserverPrompt(input: ViewChangeObserverInput): string {
  const recentConversation = input.conversation.slice(-8).flatMap((message) => {
    const text = modelHistoryMessageText(message).trim();
    return text ? [{ role: message.role, text }] : [];
  });
  return [
    "你是 Echo 的后台 View Change Observer。用户刚刚亲自在正式 Business View 中完成了修改。你只判断是否值得主动打扰用户，不执行任何写入，也不把操作日志当作新的知识证据。",
    "默认选择 silent。只有变化与现有认知明显冲突、可能遗漏重要联动、产生真实歧义，或你能提出具体且有价值的下一步时，才选择 respond。respond 的内容可以是信息、问题或建议，不需要给它们继续分类。",
    "用户已经明确完成的修改不需要再次确认。措辞润色、错别字、合理补空和纯展示排序应保持 silent。不要只说‘我注意到你修改了……’，也不要为了显得主动而制造建议。",
    "正式 View 引起的 Object Higher Memory 对账由独立后台链路自动完成。不要提醒用户手工同步已经能够自动处理的认知变化；只有自动对账后仍存在真实歧义、遗漏或需要用户判断时才回应。",
    "用户可见消息应自然、简短、具体，使用中文，最多一个问题或建议。形成判断后必须调用 submitViewAttentionDecision。",
    JSON.stringify(buildViewChangeContext({ ...input, recentConversation })),
  ].join("\n\n");
}

export async function observeViewChanges(
  input: ViewChangeObserverInput,
): Promise<ViewChangeAttentionDecision> {
  const result = await generateText({
    model: getChatModel(),
    tools: {
      submitViewAttentionDecision: structuredSubmissionTool({
        description: "提交是否应就本批人工 View 修改主动联系用户的最终决定",
        schema: decisionSchema,
      }),
    },
    toolChoice: { type: "tool", toolName: "submitViewAttentionDecision" },
    prompt: buildViewChangeObserverPrompt(input),
    temperature: 0.2,
    maxOutputTokens: 2_000,
    timeout: { totalMs: 1_800_000, stepMs: 1_800_000 },
  });
  const decision = readStructuredSubmission({
    toolCalls: result.toolCalls,
    toolName: "submitViewAttentionDecision",
    schema: decisionSchema,
  });
  if (!decision) throw new Error("View Change Observer 没有提交结构化决定");
  return decision;
}
