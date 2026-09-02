import { describe, expect, it } from "vitest";

import { shouldSubmitChatInput } from "@/app/chat-input-keyboard";

function keyEvent(input: {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
} = {}) {
  return {
    key: input.key ?? "Enter",
    shiftKey: input.shiftKey ?? false,
    nativeEvent: {
      isComposing: input.isComposing ?? false,
      ...(input.keyCode === undefined ? {} : { keyCode: input.keyCode }),
    },
  };
}

describe("chat input keyboard policy", () => {
  it("submits a regular Enter", () => {
    expect(shouldSubmitChatInput(keyEvent(), false)).toBe(true);
  });

  it("does not submit while an IME composition is active", () => {
    expect(shouldSubmitChatInput(keyEvent({ isComposing: true }), false)).toBe(false);
    expect(shouldSubmitChatInput(keyEvent(), true)).toBe(false);
    expect(shouldSubmitChatInput(keyEvent({ keyCode: 229 }), false)).toBe(false);
  });

  it("keeps Shift+Enter as a line break", () => {
    expect(shouldSubmitChatInput(keyEvent({ shiftKey: true }), false)).toBe(false);
  });
});
