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

/** Keep prior structured proposals available for continued Chat negotiation. */
export function modelHistoryMessageText(message: ClubChatMessage): string {
  const answer = finalStepMessageText(message);
  const viewProposals = message.parts
    .filter((part) => part.type === "data-viewProposal")
    .map((part) => {
      const changes = part.data.changes.map((change) => {
        if (change.type === "CREATE_CARD") {
          return `${change.title}：${change.objectName}`;
        }
        if (change.type === "SET_CONTENT_DIMENSION") {
          return `${change.title}：${change.after}`;
        }
        return `${change.title}：${change.after.map((target) => target.objectName).join("、") || "清空"}`;
      });
      return `此前结构化 Proposal ${part.data.id}（${part.data.status}）：${changes.join("；")}`;
    });
  const objectProposals = message.parts
    .filter((part) => part.type === "data-objectChangeProposal")
    .map((part) =>
      `此前 Object Change Proposal ${part.data.id}（${part.data.status}）：` +
      part.data.changes.map((change) => change.title).join("；")
    );
  return [answer, ...viewProposals, ...objectProposals].filter(Boolean).join("\n\n");
}

/**
 * Keep browser request history small: tool outputs are only needed within the
 * request that produced them. Persist final prose and lightweight UI anchors.
 */
export function compactChatRequestMessages(
  messages: ClubChatMessage[],
): ClubChatMessage[] {
  return messages.map((message) =>
    message.role === "assistant"
      ? {
          ...message,
          parts: [
            { type: "text", text: finalStepMessageText(message) },
            ...message.parts.filter((part) =>
              part.type === "data-viewProposal" ||
              part.type === "data-objectChangeProposal" ||
              part.type === "data-sourceReferences" ||
              part.type === "data-viewReferences"
            ),
          ],
        }
      : message
  );
}
