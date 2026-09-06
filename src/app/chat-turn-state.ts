import type { ChatStatus } from "ai";

export type ChatSubmitMode = "send" | "rollover" | "blocked";

export type ChatTurnInteractionState = {
  transportBusy: boolean;
  isGenerating: boolean;
  isFinalizing: boolean;
  submitMode: ChatSubmitMode;
  canSubmit: boolean;
};

/**
 * The model answer and the HTTP transport have different lifetimes. Once the
 * terminal answer lifecycle arrives, a following turn may start on a fresh
 * transport instance while the previous one finishes persistence and cleanup.
 */
export function chatTurnInteractionState(input: {
  status: ChatStatus;
  answerComplete: boolean;
  historyReady: boolean;
  hasInput: boolean;
}): ChatTurnInteractionState {
  const transportBusy = input.status === "submitted" || input.status === "streaming";
  const isGenerating = transportBusy && !input.answerComplete;
  const isFinalizing = transportBusy && input.answerComplete;
  const submitMode = !input.historyReady || isGenerating
    ? "blocked"
    : isFinalizing
      ? "rollover"
      : "send";

  return {
    transportBusy,
    isGenerating,
    isFinalizing,
    submitMode,
    canSubmit: input.hasInput && submitMode !== "blocked",
  };
}
