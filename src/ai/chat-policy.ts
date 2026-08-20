import type { ClubChatMessage } from "@/ai/types";

export function messageText(message: ClubChatMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function latestUserQuery(messages: ClubChatMessage[]): string {
  const latest = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  return latest ? messageText(latest).trim() : "";
}

export function isMemoryWriteStatusQuery(text: string): boolean {
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  if (!normalized) return false;
  return normalized.includes("readmemorywritestatus") ||
    normalized.includes("处理回执") ||
    normalized.includes("真实回执") ||
    normalized.includes("回执状态") ||
    normalized.includes("写入状态") ||
    normalized.includes("记忆状态") ||
    normalized.includes("后台处理到哪") ||
    normalized.includes("有没有记住") ||
    normalized.includes("是否已记住") ||
    normalized.includes("是否已经记住") ||
    normalized.includes("是否写入assertion") ||
    normalized.includes("是否已经写入assertion") ||
    normalized.includes("是否已写入assertion");
}

const RETRIEVAL_ACTION_PATTERN = /(检索|搜索|查找|寻找|定位|查询|筛选)/iu;
const TITLE_AND_CONTENT_SCOPE_PATTERN =
  /(?:标题|文件名|名称).{0,8}(?:或|和|及|以及|、).{0,8}(?:内容|正文|原文)|(?:内容|正文|原文).{0,8}(?:或|和|及|以及|、).{0,8}(?:标题|文件名|名称)/iu;

export function requiresCrossLayerContentSearch(text: string): boolean {
  return RETRIEVAL_ACTION_PATTERN.test(text) && TITLE_AND_CONTENT_SCOPE_PATTERN.test(text);
}

export function shouldForceCrossLayerMemorySearch(input: {
  query: string;
  libraryQueryCount: number;
  hasSearchedMemory: boolean;
  alreadyForced: boolean;
  resultTokenBudget: number;
  stepNumber: number;
  maxSteps: number;
}): boolean {
  return requiresCrossLayerContentSearch(input.query) &&
    input.libraryQueryCount > 0 &&
    !input.hasSearchedMemory &&
    !input.alreadyForced &&
    input.resultTokenBudget > 0 &&
    input.stepNumber < input.maxSteps - 1;
}
