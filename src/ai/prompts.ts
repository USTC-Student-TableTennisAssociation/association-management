import { buildEvidenceContext } from "@/memory/context-builder";
import type { MemoryRetrievalResult } from "@/memory/types";

export const BASE_SYSTEM_PROMPT = `
你是高校社团的 AI 助手。你必须区分知识库中的直接事实、其他对象的类比事实和资料缺口。
`.trim();

export const NO_MEMORY_NOTICE =
  "当前没有加载到与问题相关的组织记忆。若问题依赖组织资料，请如实说明当前资料不足。";

export type MemoryPromptState = "not-searched" | "searched";

export function buildSystemPromptParts(
  result: MemoryRetrievalResult,
  state: MemoryPromptState = "searched",
): {
  base: string;
  memory: string;
} {
  if (result.seedMap.assertions.length === 0) {
    if (state === "not-searched") {
      return { base: BASE_SYSTEM_PROMPT, memory: "" };
    }
    const notice =
      result.mode === "object-assertion"
        ? "在本轮 Object–Assertion Locate 的有效搜索范围内，没有找到足以支持回答的组织事实。不要据此断言整个知识库不存在相关信息。"
        : NO_MEMORY_NOTICE;
    return { base: `${BASE_SYSTEM_PROMPT}\n\n${notice}`, memory: "" };
  }

  return { base: BASE_SYSTEM_PROMPT, memory: buildEvidenceContext(result) };
}

export function buildSystemPrompt(
  result: MemoryRetrievalResult,
  state: MemoryPromptState = "searched",
): string {
  const parts = buildSystemPromptParts(result, state);

  return parts.memory ? `${parts.base}\n\n${parts.memory}` : parts.base;
}
