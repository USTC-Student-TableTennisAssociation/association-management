import { buildEvidenceContext } from "@/memory/context-builder";
import {
  buildAmbientHigherMemoryContext,
  type AmbientHigherMemorySnapshot,
} from "@/memory/ambient-higher-memory";
import {
  buildActorPrivateMemoryContext,
  emptyActorPrivateMemory,
  type ActorPrivateMemorySnapshot,
} from "@/memory/actor-higher-memory";
import type { MemoryRetrievalResult } from "@/memory/types";

export const BASE_SYSTEM_PROMPT = `
你是 Sydaris。你通过自动加载的高层记忆、正式 Business View 和按需检索的证据，在真实互动与实践中逐渐理解当前工作环境。
冷启动且尚无 Environment Identity 或其他正式证据时，不要猜测当前环境的类型。自动上下文已经提供 Environment Identity 时，应把它视为有证据的环境默认值并据此理解用户意图；只有新的权威证据发生冲突时才修正，而不是每轮重新假装环境未知。
系统可能提供当前对话 Actor 对应的 Object 绑定；用户对自身的指称应解析到该既有 Object，而不是创建一个新的泛称 Object。
你必须区分已读取证据中的直接事实、其他对象的类比事实和当前信息缺口。

Higher Memory 不是单一的“业务对象资料”：Object Higher Memory 围绕少数重要 GlobalObject 维护共享认知与检索导航；Ambient Higher Memory 是每轮自动加载的共享 Workspace identity、长期叙事和近期共同工作集；View Higher Memory 是特定 Business View 的高层动态摘要；Actor Higher Memory 则只服务当前认证用户的私人跨会话协作连续性。
你默认不是知识图中的 GlobalObject，因此“没有一个关于 Sydaris 自身的 Object Higher Memory”不等于“Sydaris 没有 Higher Memory”。Ambient Higher Memory 是你对共享工作环境的高层认知，不是私密内心、模型权重、隐藏推理或某位用户的私人偏好。
下方 Ambient Higher Memory 区块会明确说明本轮实际加载状态。没有加载到任何 Ambient scope 时，只能说本轮没有可用的 Ambient Higher Memory；不得把它误说成系统没有这种记忆，或声称 Higher Memory 只属于社团、人物、活动等 Object。
当前对话历史可以让你在本次对话内沿用称呼和偏好，但不证明它已成为跨会话长期记忆。只有 updateActorHigherMemory 返回 committed=true，才可确认自然语言 Actor Higher Memory 已经保存；后台维护排队不等于完成。不得在没有真实成功写入时声称“已经记住”“以后都会记得”。
`.trim();

export const NO_MEMORY_NOTICE =
  "当前没有加载到与问题相关的环境记忆。若问题依赖当前工作空间的资料，请如实说明当前信息不足。";

export type MemoryPromptState = "not-searched" | "searched";

export function buildSystemPromptParts(
  result: MemoryRetrievalResult,
  state: MemoryPromptState = "searched",
  ambientHigherMemories: AmbientHigherMemorySnapshot[] = [],
  actorPrivateMemory: ActorPrivateMemorySnapshot = emptyActorPrivateMemory(),
): {
  base: string;
  memory: string;
} {
  const ambientContext = buildAmbientHigherMemoryContext(ambientHigherMemories);
  const actorContext = buildActorPrivateMemoryContext(actorPrivateMemory);
  const base = [BASE_SYSTEM_PROMPT, ambientContext, actorContext]
    .filter(Boolean).join("\n\n");
  if (result.seedMap.assertions.length === 0 && !(result.seedMap.higherMemories?.length)) {
    if (state === "not-searched") {
      return { base, memory: "" };
    }
    const notice =
      result.mode === "object-assertion"
        ? "在本轮 Object–Assertion Locate 的有效搜索范围内，没有找到足以支持回答的事实。不要据此断言整个知识库不存在相关信息。"
        : NO_MEMORY_NOTICE;
    return { base: `${base}\n\n${notice}`, memory: "" };
  }

  return { base, memory: buildEvidenceContext(result) };
}

export function buildSystemPrompt(
  result: MemoryRetrievalResult,
  state: MemoryPromptState = "searched",
  ambientHigherMemories: AmbientHigherMemorySnapshot[] = [],
  actorPrivateMemory: ActorPrivateMemorySnapshot = emptyActorPrivateMemory(),
): string {
  const parts = buildSystemPromptParts(
    result,
    state,
    ambientHigherMemories,
    actorPrivateMemory,
  );

  return parts.memory ? `${parts.base}\n\n${parts.memory}` : parts.base;
}
