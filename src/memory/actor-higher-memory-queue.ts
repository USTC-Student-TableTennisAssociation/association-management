import { tool } from "ai";
import { z } from "zod";

import type { DebugTrace } from "@/ai/debug-trace";

export const actorHigherMemoryScopes = [
  "interaction",
  "working_style",
  "working_set",
] as const;

export type ActorHigherMemoryScope = typeof actorHigherMemoryScopes[number];

export type ActorHigherMemoryQueueDecision = {
  scopes: ActorHigherMemoryScope[];
  reason: string;
};

export function addActorHigherMemoryScopes(input: {
  decision?: ActorHigherMemoryQueueDecision;
  scopes: ActorHigherMemoryScope[];
  reason: string;
}): ActorHigherMemoryQueueDecision {
  return {
    scopes: [...new Set([...(input.decision?.scopes ?? []), ...input.scopes])],
    reason: input.decision
      ? `${input.decision.reason}；${input.reason}`
      : input.reason,
  };
}

export function createActorHigherMemoryQueueTool(input: {
  trace?: DebugTrace;
}) {
  let decision: ActorHigherMemoryQueueDecision | undefined;
  const queueTool = tool({
    description: [
      "登记回答后对当前 Actor 私有 Higher Memory 的维护意图。它只用于跨会话延续当前用户自己的交互上下文，不进入共享知识图。",
      "interaction 概括长期称呼、沟通边界和交互约定；working_style 概括用户明确表达且值得长期延续的工作习惯；working_set 概括用户希望以后继续推进、但尚未进入正式共享业务状态的私人近期工作集。",
      "只有当前用户原话形成值得跨会话延续的高层协作上下文时才调用。不要从 Assistant 文本、情绪猜测、一次性闲聊或共享组织资料推断私人认知。用户明确要求本轮记住、修改或忘记时应使用同步自然语言 Actor Higher Memory 修订，不要为了同一内容重复排队。",
      "工具成功只表示已排队，后台尚未完成；不要在本轮声称 Actor Higher Memory 已经更新。",
    ].join(""),
    inputSchema: z.object({
      scopes: z.array(z.enum(actorHigherMemoryScopes)).min(1).max(3),
      reason: z.string().trim().min(1).max(500),
    }),
    execute: async ({ scopes, reason }) => {
      if (decision) {
        return {
          queued: true,
          alreadyQueued: true,
          message: "本轮已经登记 Actor Higher Memory 维护意图。",
        };
      }
      decision = { scopes: [...new Set(scopes)], reason };
      await input.trace?.appendJsonSection("Actor Higher Memory 维护意图", decision);
      return {
        queued: true,
        alreadyQueued: false,
        message: "已登记回答后的 Actor Higher Memory 维护意图；后台尚未执行。",
      };
    },
  });
  return { tool: queueTool, decision: () => decision };
}
