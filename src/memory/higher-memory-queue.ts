import { tool } from "ai";
import { z } from "zod";

import type { DebugTrace } from "@/ai/debug-trace";

export const ambientHigherMemoryScopes = ["identity", "narrative", "working_set"] as const;

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
  z.object({ scope: z.literal("identity") }),
  z.object({ scope: z.literal("narrative") }),
  z.object({ scope: z.literal("working_set") }),
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
  trace?: DebugTrace;
  hasObject?: (globalObjectId: string) => boolean;
  canQueueAmbient?: () => boolean;
}) {
  let decision: HigherMemoryQueueDecision | undefined;

  const queueTool = tool({
    description: [
      "仅当本轮真实互动使 Sydaris 对环境身份、组织叙事、共同工作集或少数重要 GlobalObject 形成了值得延续的高层理解时调用。",
      "identity 表示已被证据确认的环境类型、边界与 Sydaris 的长期职责；narrative 表示跨短期任务仍成立的使命、历史脉络、文化和共同意义；working_set 表示近期共同工作的阶段、重点、风险和未结方向。",
      "具体 Object 的事实属于 Object–Assertion 图及相应 Object Higher Memory，不得仅因本轮提及就提升为 ambient scope。",
      "object 目标必须原样使用本轮工具实际返回的 GlobalObject database id。",
      "这只登记静默维护意图；后台会在 Chat Assertion 阶段完整结束后取得主对话的完整语义上下文并开始维护。",
      "普通检索命中、顺带提及、问候、一次性细节或没有形成新的高层理解时不要调用。",
      "Sydaris 的昵称、语气、亲密称呼和单个用户的私人偏好不属于共享 Ambient scope；不要用本工具伪造 Actor 私有记忆或改变产品品牌。",
      "首次实质性讨论可以创建缺失的 identity/narrative/working_set Higher Memory。每轮至多调用一次，不要向用户宣称维护已经完成。",
    ].join(""),
    inputSchema: z.object({
      targets: z.array(targetSchema).min(1).max(8)
        .describe("本轮值得维护的 identity、narrative、working_set 或少数 object 目标"),
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
      const ambientTargets = uniqueTargets.filter((target) => target.scope !== "object");
      if (ambientTargets.length && input.canQueueAmbient && !input.canQueueAmbient()) {
        return {
          queued: false,
          alreadyQueued: false,
          message:
            "本轮尚未读取足以支持 Ambient Higher Memory 的正式 View、Grounded Assertion、Source 或既有 Higher Memory；请先取得真实证据，证据仍不足时不要为了填空而维护。",
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
        message: "已登记回答后的 Higher Memory 维护意图；后台尚未执行，不能向用户声称已经更新。请继续完成正常回答。",
      };
    },
  });

  return {
    tool: queueTool,
    decision: () => decision,
  };
}
