import { z } from "zod";

import { getChatModel } from "@/ai/provider";
import {
  generateStructuredResult,
  StructuredSubmissionError,
} from "@/ai/structured-submission";
import { modelHistoryMessageText } from "@/ai/ui-message-text";
import type { ClubChatMessage } from "@/ai/types";
import {
  buildViewChangeContext,
  type ViewChangeContextInput,
} from "@/view-runtime/application/view-change-context";

export type ViewChangeAttentionDecision = {
  evidenceStatus: "consistent" | "conflict" | "insufficient" | "not_applicable";
  usedEvidenceRefs: string[];
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
    evidenceStatus: z.enum(["consistent", "conflict", "insufficient", "not_applicable"])
      .describe("本次修改与修改前证据的关系；不能把修改后的 View 自己当作支持证据"),
    usedEvidenceRefs: z.array(z.string().regex(/^E\d+$/)).max(8)
      .describe("实际用于判断的 Evidence Envelope 引用；没有可用证据时为空数组"),
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
    if (decision.evidenceStatus === "conflict" && decision.action === "silent") {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "存在证据冲突时不能静默",
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
    "你是 Sydaris 的后台 View Change Observer。用户刚刚亲自在正式 Business View 中完成了修改。你只核对这次修改，不执行写入。",
    reviewInstruction,
    "changes 给出权威 before/after 与字段定义；evidence 是 Runtime 按关联 Object 和被修改字段检索出的修改前 grounded Assertions。只用 evidence 判断既有知识，不能把修改后的 View、Command 日志或 Higher Memory 当作支持证据。",
    "先明确 evidenceStatus：证据支持新值为 consistent；证据给出不同当前事实为 conflict；没有足够相关证据为 insufficient；纯措辞、排序等无需事实核对时为 not_applicable。正式评级、身份关系、在任状态等重要事实出现 conflict 或 insufficient 时请求确认；纯展示修改保持 silent。",
    "用户已经保存，不要再询问是否保存。冲突时指出旧口径和新值；证据不足时只询问依据或正式口径。不要提醒用户手工同步后台认知。",
    "用户可见消息应自然、简短、具体，使用中文，最多一个问题或建议。直接提交结构化判断。",
    JSON.stringify(buildViewChangeContext({ ...input, recentConversation })),
  ].join("\n\n");
}

export async function observeViewChanges(
  input: ViewChangeObserverInput,
): Promise<ViewChangeAttentionDecision> {
  const submissionSchema = decisionSchemaFor(input.attentionPolicy);
  const decision = await generateStructuredResult({
    model: getChatModel(),
    schema: submissionSchema,
    name: "view_change_attention_decision",
    description: "提交是否应就本批人工 View 修改主动联系用户的最终决定",
    prompt: buildViewChangeObserverPrompt(input),
    temperature: 0.2,
    timeout: { totalMs: 1_800_000, stepMs: 1_800_000 },
  });
  const availableRefs = new Set(input.evidence?.assertions.map((item) => item.ref) ?? []);
  const unknownRefs = decision.usedEvidenceRefs.filter((ref) => !availableRefs.has(ref));
  if (unknownRefs.length) {
    throw new StructuredSubmissionError(
      `View Change Observer 引用了不存在的证据：${unknownRefs.join("、")}`,
    );
  }
  return decision;
}
