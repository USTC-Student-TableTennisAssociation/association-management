import { tool } from "ai";
import { z } from "zod";

import type { EchoDebugTrace } from "@/ai/debug-trace";

export type ChatAssertionQueueDecision = {
  reason: string;
};

export function createChatAssertionQueueTool(input: {
  trace?: EchoDebugTrace;
}) {
  let decision: ChatAssertionQueueDecision | undefined;

  const queueTool = tool({
    description: [
      "当且仅当当前用户消息自身陈述了值得后续检索的新 Echo 组织事实时，",
      "把本轮排入后台 Chat → Assertion 提取。该工具只登记意图，不查询数据库、不创建 Assertion，",
      "也不保证最终会写入；后端仍会进行 Object 关联、Evidence、Embedding 与事务校验。",
      "纯问候、闲聊、问题、假设、头脑风暴、改写/查询/记录等操作指令本身，以及仅由 Assistant 历史提供的事实，",
      "都不要调用。若操作指令同时包含用户明确陈述的组织事实，只针对其中的事实触发。",
      "不需要在这里摘录 Evidence 或挑选上下文；后台会收到主对话实际使用的完整语义上下文，并自行选择用户 Evidence、",
      "复用已有检索结果或继续搜索 Object。每轮至多调用一次，调用后继续正常回答，不要向用户宣称已经写入记忆。",
    ].join(""),
    inputSchema: z.object({
      reason: z.string().trim().min(1).max(500)
        .describe("为什么当前用户原话包含值得后台尝试提取的新组织事实"),
    }),
    execute: async ({ reason }) => {
      if (decision) {
        return {
          queued: true,
          alreadyQueued: true,
          message: "本轮已经排入后台提取；请继续完成正常回答。",
        };
      }
      decision = { reason };
      await input.trace?.appendSection(
        "Assertion 入口判断",
        [
          "结果：主回答模型调用了 `queueChatAssertionCapture`，本轮将在回答完成后进入后台提取。",
          "",
          `- 原因：${decision.reason}`,
          "- queue 只表达“值得尝试”；没有圈定 Evidence，也没有要求后台必须产出。",
          "- 后台将接收主对话完整语义转录，并可复用或继续执行 Shared Brain 搜索。",
          "- 此时尚未由后台确认 Object，也尚未写入 Evidence 或 Assertion。",
        ].join("\n"),
      );
      return {
        queued: true,
        alreadyQueued: false,
        message: "已排入回答后的可信提取与校验；这不代表一定会写入 Assertion。请继续完成正常回答。",
      };
    },
  });

  return {
    tool: queueTool,
    decision: () => decision,
  };
}
