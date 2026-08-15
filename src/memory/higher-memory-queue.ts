import { tool } from "ai";
import { z } from "zod";

import type { EchoDebugTrace } from "@/ai/debug-trace";

export const ambientHigherMemoryScopes = ["workspace", "recent"] as const;

export type AmbientHigherMemoryScope = typeof ambientHigherMemoryScopes[number];

export type HigherMemoryQueueTarget =
  | { scope: AmbientHigherMemoryScope }
  | { scope: "object"; globalObjectId: string };

export type HigherMemoryQueueDecision = {
  targets: HigherMemoryQueueTarget[];
  reason: string;
};

export type ObjectHigherMemoryQueueDecision = {
  objectIds: string[];
  reason: string;
};

const targetSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace") }),
  z.object({ scope: z.literal("recent") }),
  z.object({
    scope: z.literal("object"),
    globalObjectId: z.string().uuid()
      .describe("必须原样来自本轮实际读取过的 GlobalObject database id"),
  }),
]);

function targetKey(target: HigherMemoryQueueTarget): string {
  return target.scope === "object"
    ? `object:${target.globalObjectId}`
    : target.scope;
}

export function objectHigherMemoryQueueDecision(
  decision: HigherMemoryQueueDecision | undefined,
): ObjectHigherMemoryQueueDecision | undefined {
  if (!decision) return undefined;
  const objectIds = decision.targets.flatMap((target) =>
    target.scope === "object" ? [target.globalObjectId] : []
  );
  return objectIds.length ? { objectIds, reason: decision.reason } : undefined;
}

export function ambientScopesFromQueueDecision(
  decision: HigherMemoryQueueDecision | undefined,
): AmbientHigherMemoryScope[] {
  if (!decision) return [];
  return decision.targets.flatMap((target) =>
    target.scope === "object" ? [] : [target.scope]
  );
}

export function addObjectTargetsToQueueDecision(input: {
  decision?: HigherMemoryQueueDecision;
  objectIds: string[];
  reason: string;
}): HigherMemoryQueueDecision {
  const existing = input.decision?.targets ?? [];
  const targets = [...existing];
  const keys = new Set(existing.map(targetKey));
  for (const globalObjectId of input.objectIds) {
    const target = { scope: "object" as const, globalObjectId };
    if (!keys.has(targetKey(target))) {
      targets.push(target);
      keys.add(targetKey(target));
    }
  }
  return {
    targets,
    reason: input.decision ? `${input.decision.reason}；${input.reason}` : input.reason,
  };
}

export function createHigherMemoryQueueTool(input: {
  trace?: EchoDebugTrace;
  hasObject?: (globalObjectId: string) => boolean;
}) {
  let decision: HigherMemoryQueueDecision | undefined;

  const queueTool = tool({
    description: [
      "仅当本轮真实互动使 Echo 对工作环境、近期焦点或少数重要 GlobalObject 形成了值得延续的高层理解时调用。",
      "workspace 表示当前环境是什么、长期在做什么、Echo 在其中通常承担什么作用；recent 表示近期的共同工作、阶段性焦点、风险和未结方向。",
      "与某个成员有关的经历、角色、偏好或工作认知应维护在该 Person GlobalObject 的 Object Higher Memory，不得放入 workspace 或 recent。",
      "object 目标必须原样使用本轮工具实际返回的 GlobalObject database id。",
      "这只登记静默维护意图；后台会在 Chat Assertion 阶段完整结束后取得主对话的完整语义上下文并开始维护。",
      "普通检索命中、顺带提及、问候、一次性细节或没有形成新的高层理解时不要调用。",
      "首次实质性讨论可以创建缺失的 workspace/recent Higher Memory。每轮至多调用一次，不要向用户宣称维护已经完成。",
    ].join(""),
    inputSchema: z.object({
      targets: z.array(targetSchema).min(1).max(8)
        .describe("本轮值得维护的 workspace、recent 或少数 object 目标"),
      reason: z.string().trim().min(1).max(500)
        .describe("为什么本轮形成的理解值得维护为 Higher Memory"),
    }),
    execute: async ({ targets, reason }) => {
      if (decision) {
        return {
          queued: true,
          alreadyQueued: true,
          message: "本轮已经登记 Higher Memory 维护意图；请继续完成正常回答。",
        };
      }
      const uniqueTargets = targets.filter((target, index, all) =>
        all.findIndex((candidate) => targetKey(candidate) === targetKey(target)) === index
      );
      const unknownObjectIds = input.hasObject
        ? uniqueTargets.flatMap((target) =>
            target.scope === "object" && !input.hasObject!(target.globalObjectId)
              ? [target.globalObjectId]
              : []
          )
        : [];
      if (unknownObjectIds.length) {
        return {
          queued: false,
          alreadyQueued: false,
          message:
            "这些 Object 尚未出现在本轮已读取上下文中，请先定位：" +
            unknownObjectIds.join(", "),
        };
      }
      decision = { targets: uniqueTargets, reason };
      const labels = decision.targets.map((target) =>
        target.scope === "object"
          ? `object:\`${target.globalObjectId}\``
          : target.scope
      );
      await input.trace?.appendSection(
        "Higher Memory 入口判断",
        [
          "结果：主回答模型调用了 `queueHigherMemoryMaintenance`。",
          "",
          `- 维护目标：${labels.join("、")}`,
          `- 原因：${decision.reason}`,
          "- 这里只登记维护意图；没有把对话内容复制到工具参数。",
          "- 后端将在 Chat Assertion 阶段结束后附上完整语义上下文。",
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
