import { tool } from "ai";
import { z } from "zod";

import type { DebugTrace } from "@/ai/debug-trace";
import type { ChatAssertionCaptureResult } from "@/memory/chat-assertion";

export type ChatAssertionQueueDecision = {
  reason: string;
};

export type ChatAssertionQueueExecution = "background" | "foreground_for_view";

export function createChatAssertionQueueTool(input: {
  trace?: DebugTrace;
  captureForeground?: (
    decision: ChatAssertionQueueDecision,
  ) => Promise<ChatAssertionCaptureResult>;
  onQueued?: (
    decision: ChatAssertionQueueDecision,
    execution: ChatAssertionQueueExecution,
  ) => Promise<void>;
  onForegroundResult?: (result: ChatAssertionCaptureResult) => void;
}) {
  let decision: ChatAssertionQueueDecision | undefined;
  let foregroundDecision: ChatAssertionQueueDecision | undefined;
  let foregroundResult: ChatAssertionCaptureResult | undefined;
  let handled = false;

  const queueTool = tool({
    description: [
      "当且仅当当前用户消息自身陈述了值得后续检索的新事实时，",
      "选择普通后台提取，或在该用户原话同时提供正式 View 所需缺失实体及其新事实时选择前台提取。",
      "两种模式都复用同一个 Assertion Agent，并执行 Object 搜索、逐字 Evidence、查重、Embedding 与原子事务校验；",
      "若用户 Evidence 逐字提供稳定专名，且搜索后没有重复或歧义，线路可以创建被成功 Assertion 使用的新 Object。",
      "execution=foreground_for_view 只用于：当前用户原话逐字提供了必要实体及其新事实、现有知识中确实没有该 Object，且主模型需要在本轮随后调用 runViewCommand。它不能发布只来自资料原文或 Assistant 历史的实体。",
      "若当前消息同时包含事实确认和正式 View 修改请求，必须先读取 View、完成必要搜索并判断 Object 是否缺失，再选择执行模式；不要提前选 background 导致本轮 Proposal 继续被缺失 Object 阻塞。",
      "其他事实一律使用 execution=background，在回答完成后静默处理。",
      "也不会自动更新正式 Business View。不要向用户承诺稍后会自动建档或更新正式状态。",
      "纯问候、闲聊、问题、假设、头脑风暴、改写/查询/记录等操作指令本身，以及仅由 Assistant 历史提供的事实，",
      "都不要调用。若操作指令同时包含用户明确陈述的事实，只针对其中的事实触发。",
      "不需要在这里摘录 Evidence 或挑选上下文；后台会收到主对话实际使用的完整语义上下文，并自行选择用户 Evidence、",
      "复用已有检索结果或继续搜索 Object。每轮至多调用一次，调用后继续正常回答，不要向用户宣称已经写入记忆。",
    ].join(""),
    inputSchema: z.object({
      reason: z.string().trim().min(1).max(500)
        .describe("为什么当前用户原话包含值得后台尝试提取的新事实"),
      execution: z.enum(["background", "foreground_for_view"]).default("background")
        .describe("普通事实选 background；仅当当前用户原话提供了 View 所需的新实体事实时选 foreground_for_view"),
    }),
    execute: async ({ reason, execution = "background" }) => {
      if (handled) {
        return {
          queued: Boolean(decision),
          completed: Boolean(foregroundResult),
          alreadyQueued: true,
          message: foregroundResult
            ? "本轮已经完成前台 Assertion/Object 发布；请使用先前返回的 IDs 继续正式 View Proposal。"
            : "本轮已经排入后台提取；请继续完成正常回答。",
        };
      }
      handled = true;
      const requestedDecision = { reason };
      await input.onQueued?.(requestedDecision, execution);
      if (execution === "foreground_for_view") {
        if (!input.captureForeground) {
          throw new Error("当前 Chat 环境没有配置前台 Assertion 捕获");
        }
        foregroundDecision = requestedDecision;
        await input.trace?.appendSection(
          "Assertion 入口判断",
          [
            "结果：主回答模型要求在正式 View Proposal 前完成 Chat → Assertion。",
            `- 原因：${reason}`,
            "- 将同步运行同一个 Assertion Agent；只有成功 Assertion 才能原子创建新 Object。",
            "- 前台发布不会自动修改 Business View，返回的 IDs 只授权本轮随后提出 Proposal。",
          ].join("\n"),
        );
        foregroundResult = await input.captureForeground(requestedDecision);
        input.onForegroundResult?.(foregroundResult);
        await input.trace?.appendSection(
          "Assertion 前台处理结果",
          [
            `- 发布 Assertion：${foregroundResult.publishedAssertions} 条`,
            `- 新建 Object：${foregroundResult.affectedObjects.filter((object) => object.resolution === "created").length} 个`,
            foregroundResult.affectedObjects.length
              ? `- 可供本轮 Proposal 使用：${foregroundResult.affectedObjects.map((object) => `${object.canonicalName}（\`${object.id}\`，${object.resolution}）`).join("、")}`
              : "- 没有可供 Proposal 使用的新发布 Object。",
          ].join("\n"),
        );
        return {
          queued: false,
          completed: true,
          alreadyQueued: false,
          publishedAssertions: foregroundResult.publishedAssertions,
          publishedAssertionIds: foregroundResult.publishedAssertionIds,
          objects: foregroundResult.affectedObjects,
          message: foregroundResult.publishedAssertions
            ? "Assertion/Object 已在本轮前台完成发布；可使用返回的 IDs 继续 runViewCommand。"
            : "当前用户原话没有发布新的 Assertion/Object；本轮先前检索到的 O#、别名和唯一 canonical name 仍然有效，请继续提交所有可绑定的 View Proposal。",
        };
      }

      decision = requestedDecision;
      await input.trace?.appendSection(
        "Assertion 入口判断",
        [
          "结果：主回答模型调用了 `queueChatAssertionCapture`，本轮将在回答完成后进入后台提取。",
          "",
          `- 原因：${decision.reason}`,
          "- queue 只表达“值得尝试”；没有圈定 Evidence，也没有要求后台必须产出。",
          "- 后台将接收主对话完整语义转录，并可复用或继续执行 Shared Brain 搜索。",
          "- 此时尚未由后台确认 Object，也尚未写入 Evidence 或 Assertion。",
          "- 若成功 Assertion 的逐字 Evidence 提供稳定专名，后台可受约束地创建其实际使用的新 GlobalObject。",
          "- 该线路不会自动更新 Business View。",
        ].join("\n"),
      );
      return {
        queued: true,
        alreadyQueued: false,
        message: "已排入回答后的可信提取与校验；这不代表一定会写入 Assertion/Object，也不会自动更新 Business View。请继续完成正常回答。",
      };
    },
  });

  return {
    tool: queueTool,
    decision: () => decision,
    foregroundDecision: () => foregroundDecision,
    foregroundResult: () => foregroundResult,
  };
}
