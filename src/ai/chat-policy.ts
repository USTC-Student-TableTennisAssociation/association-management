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
