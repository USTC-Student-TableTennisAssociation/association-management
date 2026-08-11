import { describe, expect, it } from "vitest";

import type { ClubChatMessage } from "@/ai/types";
import { finalStepMessageText } from "@/ai/ui-message-text";

describe("finalStepMessageText", () => {
  it("shows only the final model step after tool exploration", () => {
    const message: ClubChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "临时结论 [A1]" },
        { type: "step-start" },
        { type: "text", text: "最终回答 [A2]" },
      ],
    };

    expect(finalStepMessageText(message)).toBe("最终回答 [A2]");
  });

  it("keeps ordinary user and single-step text", () => {
    const message: ClubChatMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "继往开来是什么活动？" }],
    };

    expect(finalStepMessageText(message)).toBe("继往开来是什么活动？");
  });
});
