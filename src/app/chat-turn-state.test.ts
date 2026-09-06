import { describe, expect, it } from "vitest";

import { chatTurnInteractionState } from "@/app/chat-turn-state";

describe("chatTurnInteractionState", () => {
  it("blocks a second turn while the model is still generating", () => {
    expect(chatTurnInteractionState({
      status: "streaming",
      answerComplete: false,
      historyReady: true,
      hasInput: true,
    })).toMatchObject({
      isGenerating: true,
      isFinalizing: false,
      submitMode: "blocked",
      canSubmit: false,
    });
  });

  it("rolls over to a fresh transport once the visible answer is complete", () => {
    expect(chatTurnInteractionState({
      status: "streaming",
      answerComplete: true,
      historyReady: true,
      hasInput: true,
    })).toMatchObject({
      isGenerating: false,
      isFinalizing: true,
      submitMode: "rollover",
      canSubmit: true,
    });
  });

  it("sends immediately when the transport is ready", () => {
    expect(chatTurnInteractionState({
      status: "ready",
      answerComplete: true,
      historyReady: true,
      hasInput: true,
    })).toMatchObject({
      transportBusy: false,
      submitMode: "send",
      canSubmit: true,
    });
  });
});
