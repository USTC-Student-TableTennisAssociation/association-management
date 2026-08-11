import { describe, expect, it } from "vitest";

import { latestUserQuery, messageText } from "@/ai/chat-policy";
import type { ClubChatMessage } from "@/ai/types";

function message(id: string, role: "user" | "assistant", text: string): ClubChatMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

describe("chat policy", () => {
  it("does not truncate message text", () => {
    const text = "长".repeat(20_000);
    expect(messageText(message("1", "user", text))).toBe(text);
  });

  it("uses the latest user text as the retrieval query", () => {
    expect(
      latestUserQuery([
        message("1", "user", "first"),
        message("2", "assistant", "answer"),
        message("3", "user", "latest"),
      ]),
    ).toBe("latest");
  });
});
