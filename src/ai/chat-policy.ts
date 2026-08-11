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
