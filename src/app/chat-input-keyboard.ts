export type ChatInputKeyEvent = {
  key: string;
  shiftKey: boolean;
  nativeEvent: {
    isComposing: boolean;
    keyCode?: number;
  };
};

/** Enter sends only when it is not being used to confirm an IME composition. */
export function shouldSubmitChatInput(
  event: ChatInputKeyEvent,
  compositionActive: boolean,
): boolean {
  return event.key === "Enter" &&
    !event.shiftKey &&
    !compositionActive &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229;
}
