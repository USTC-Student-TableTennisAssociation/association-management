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

export type ViewChangeAttentionDecision = {
  action: "silent" | "inform" | "request_confirmation";
  message: string;
  reason: string;
};

function decisionSchemaFor(
  attentionPolicy: ViewChangeContextInput["attentionPolicy"],
): z.ZodType<ViewChangeAttentionDecision> {
  const actionSchema: z.ZodType<ViewChangeAttentionDecision["action"]> = attentionPolicy === "always"
    ? z.enum(["inform", "request_confirmation"])
    : z.enum(["silent", "inform", "request_confirmation"]);
  return z.object({
    action: actionSchema,
    message: z.string().trim().max(800)
      .describe("silent 时必须为空字符串；其他决定必须填写一条用户可见的中文消息"),
    reason: z.string().trim().min(1).max(500),
  }).superRefine((decision, context) => {
    if (decision.action !== "silent" && !decision.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "可见审查决定必须提供用户可见消息",
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
}

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
  const reviewInstruction = input.attentionPolicy === "always"
    ? "本批修改的 View 策略要求始终给出可见审查结果，不允许选择 silent。没有需要用户决定的冲突时选择 inform；确实需要用户判断时才选择 request_confirmation。"
    : "本批修改的 View 策略允许静默评估。默认选择 silent；有值得用户知道但无需决策的影响时选择 inform，存在真实歧义或后续动作需要用户判断时选择 request_confirmation。";
  return [
    "你是 Sydaris 的后台 View Change Observer。用户刚刚亲自在正式 Business View 中完成了修改。你只判断是否值得主动打扰用户，不执行任何写入，也不把操作日志当作新的知识证据。",
    reviewInstruction,
    "上下文中的 changes 是 Runtime 在事务前后自动记录的权威差异。判断时必须同时使用字段或关系的自然语言 definition、before、after 和 policy，不要仅凭 Command 名称猜测修改内容。",
    "用户已经完成保存，不要再询问‘是否要保存/修改’。但保存行为不等于对事实真实性的确认：正式评级、身份关系、在任状态等重要字段与修改前知识冲突或缺少支持时，应选择 request_confirmation，询问事实依据或正式口径。措辞润色、错别字、合理补空和纯展示排序应保持 silent。不要只说‘我注意到你修改了……’。",
    "正式 View 引起的 Object Higher Memory 对账由独立后台链路并行完成。relatedObjects 只包含本次修改之前已存在的认知；不得把本次修改所生成的派生知识当作支持该修改的旧证据。不要提醒用户手工同步能够自动处理的认知变化。",
    "用户可见消息应自然、简短、具体，使用中文，最多一个问题或建议。形成判断后必须调用 submitViewAttentionDecision。",
    JSON.stringify(buildViewChangeContext({ ...input, recentConversation })),
  ].join("\n\n");
}

export async function observeViewChanges(
  input: ViewChangeObserverInput,
): Promise<ViewChangeAttentionDecision> {
  const submissionSchema = decisionSchemaFor(input.attentionPolicy);
  const result = await generateText({
    model: getChatModel(),
    tools: {
      submitViewAttentionDecision: structuredSubmissionTool({
        description: "提交是否应就本批人工 View 修改主动联系用户的最终决定",
        schema: submissionSchema,
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
    schema: submissionSchema,
  });
  if (!decision) throw new Error("View Change Observer 没有提交结构化决定");
  return decision;
}
