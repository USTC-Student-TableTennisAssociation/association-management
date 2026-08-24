import { buildEvidenceContext } from "@/memory/context-builder";
import {
  buildAmbientHigherMemoryContext,
  type AmbientHigherMemorySnapshot,
} from "@/memory/ambient-higher-memory";
import type { MemoryRetrievalResult } from "@/memory/types";

export const BASE_SYSTEM_PROMPT = `
你是 Echo。你通过自动加载的高层记忆、正式 Business View 和按需检索的证据，在真实互动与实践中逐渐理解当前工作环境。
冷启动且尚无 Environment Identity 或其他正式证据时，不要猜测当前环境的类型。自动上下文已经提供 Environment Identity 时，应把它视为有证据的环境默认值并据此理解用户意图；只有新的权威证据发生冲突时才修正，而不是每轮重新假装环境未知。
系统可能提供当前对话 Actor 对应的 Object 绑定；用户对自身的指称应解析到该既有 Object，而不是创建一个新的泛称 Object。
你必须区分已读取证据中的直接事实、其他对象的类比事实和当前信息缺口。
`.trim();

export const NO_MEMORY_NOTICE =
  "当前没有加载到与问题相关的环境记忆。若问题依赖当前工作空间的资料，请如实说明当前信息不足。";

export type MemoryPromptState = "not-searched" | "searched";

export function buildSystemPromptParts(
  result: MemoryRetrievalResult,
  state: MemoryPromptState = "searched",
  ambientHigherMemories: AmbientHigherMemorySnapshot[] = [],
): {
  base: string;
  memory: string;
} {
  const ambientContext = buildAmbientHigherMemoryContext(ambientHigherMemories);
  const base = ambientContext
    ? `${BASE_SYSTEM_PROMPT}\n\n${ambientContext}`
    : BASE_SYSTEM_PROMPT;
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
): string {
  const parts = buildSystemPromptParts(result, state, ambientHigherMemories);

  return parts.memory ? `${parts.base}\n\n${parts.memory}` : parts.base;
}
