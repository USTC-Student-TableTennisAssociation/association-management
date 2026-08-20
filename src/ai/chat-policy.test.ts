import { describe, expect, it } from "vitest";

import {
  isMemoryWriteStatusQuery,
  latestUserQuery,
  messageText,
} from "@/ai/chat-policy";
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

  it("recognizes requests that require a fresh memory write receipt", () => {
    expect(isMemoryWriteStatusQuery(
      "请查询这条消息的真实处理回执，必须调用 readMemoryWriteStatus。",
    )).toBe(true);
    expect(isMemoryWriteStatusQuery("刚才的事实是否已经写入 Assertion？")).toBe(true);
    expect(isMemoryWriteStatusQuery("后台处理到哪一步了？")).toBe(true);
  });

  it("does not treat general Assertion questions as receipt queries", () => {
    expect(isMemoryWriteStatusQuery("Assertion 是什么？")).toBe(false);
    expect(isMemoryWriteStatusQuery("请检索历任会长资料")).toBe(false);
  });
});
