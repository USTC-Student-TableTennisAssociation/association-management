import { tool } from "ai";
import { z } from "zod";

import type { EchoDebugTrace } from "@/ai/debug-trace";

export type ObjectHigherMemoryQueueDecision = {
  objectIds: string[];
  reason: string;
};

export function createObjectHigherMemoryQueueTool(input: {
  trace?: EchoDebugTrace;
  hasObject?: (globalObjectId: string) => boolean;
}) {
  let decision: ObjectHigherMemoryQueueDecision | undefined;

  const queueTool = tool({
    description: [
      "仅当本轮对话围绕少数重要 GlobalObject 进行了实质讨论，值得在回答后维护其长期高层认知时调用。",
      "这是静默维护意图，不读取或写入记忆；后台会在本轮 Chat Assertion 提取完成后，",
      "获得主对话的完整语义上下文，并基于数据库中实际存在的 Assertion 重建 Higher Memory。",
      "objectIds 必须原样来自本轮工具实际返回的 GlobalObject database id。",
      "普通检索命中、顺带提及、问候、一次性细节或没有围绕 Object 形成实质理解时不要调用。",
      "本轮即使不需要提取新 Assertion，也可以维护已经讨论的重要 Object。每轮至多调用一次；",
      "不要复制对话、Higher Memory 或 Assertion 到参数中，也不要向用户宣称维护已经完成。",
    ].join(""),
    inputSchema: z.object({
      objectIds: z.array(z.string().uuid()).min(1).max(6)
        .describe("本轮实质讨论且值得维护的少数 GlobalObject database ids"),
      reason: z.string().trim().min(1).max(500)
        .describe("为什么这些 Object 在本轮对话中重要到值得维护 Higher Memory"),
    }),
    execute: async ({ objectIds, reason }) => {
      if (decision) {
        return {
          queued: true,
          alreadyQueued: true,
          message: "本轮已经登记 Higher Memory 维护意图；请继续完成正常回答。",
        };
      }
      const uniqueObjectIds = [...new Set(objectIds)];
      const unknownObjectIds = input.hasObject
        ? uniqueObjectIds.filter((id) => !input.hasObject!(id))
        : [];
      if (unknownObjectIds.length) {
        return {
          queued: false,
          alreadyQueued: false,
          message:
            "这些 Object 尚未出现在本轮检索结果中，请先用 searchMemory 或 followObject 定位：" +
            unknownObjectIds.join(", "),
        };
      }
      decision = { objectIds: uniqueObjectIds, reason };
      await input.trace?.appendSection(
        "Higher Memory 入口判断",
        [
          "结果：主回答模型调用了 `queueHigherMemoryMaintenance`。",
          "",
          `- 目标 Object：${decision.objectIds.map((id) => `\`${id}\``).join("、")}`,
          `- 原因：${decision.reason}`,
          "- 这里只登记对话维护意图；没有把对话内容复制到工具参数。",
          "- 后端将在 Chat Assertion 阶段结束后附上本轮完整语义上下文并开始维护。",
          "- 此时尚未创建或修改 Higher Memory。",
        ].join("\n"),
      );
      return {
        queued: true,
        alreadyQueued: false,
        message: "已登记回答后的 Higher Memory 维护意图；请继续完成正常回答。",
      };
    },
  });

  return {
    tool: queueTool,
    decision: () => decision,
  };
}
