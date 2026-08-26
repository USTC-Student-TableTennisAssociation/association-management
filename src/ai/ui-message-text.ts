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

/** Keep prior proposal intent without presenting a stale notice as live state. */
export function modelHistoryMessageText(message: ClubChatMessage): string {
  const answer = finalStepMessageText(message);
  const viewProposals = message.parts
    .filter((part) => part.type === "data-viewCommandProposal")
    .map((part) =>
      "历史消息曾展示 View Proposal：" +
      `${part.data.commandKey}@${part.data.commandVersion}。` +
      "它只用于理解先前修改意图，当前审批状态未知；不得据此声称本轮已生成、仍待审批或已经生效。"
    );
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
              part.type === "data-viewCommandProposal" ||
              part.type === "data-objectChangeProposal" ||
              part.type === "data-sourceReferences" ||
              part.type === "data-viewReferences"
            ),
          ],
        }
      : message
  );
}
