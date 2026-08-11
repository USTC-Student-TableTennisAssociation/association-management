import type { ClubChatMessage } from "@/ai/types";

/**
 * A tool loop can emit provisional text before it calls a tool. Only text from
 * the last model step is the final answer; reasoning remains available through
 * the separate debug panel.
 */
export function finalStepMessageText(message: ClubChatMessage): string {
  const lastStepStart = message.parts.reduce(
    (lastIndex, part, index) => part.type === "step-start" ? index : lastIndex,
    -1,
  );
  return message.parts
    .slice(lastStepStart + 1)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
