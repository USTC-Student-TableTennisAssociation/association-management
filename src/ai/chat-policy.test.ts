import { describe, expect, it } from "vitest";

import {
  isMemoryWriteStatusQuery,
  latestUserQuery,
  messageText,
  requiresCrossLayerContentSearch,
  shouldForceCrossLayerMemorySearch,
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

  it("recognizes an explicit title-and-content retrieval scope", () => {
    expect(requiresCrossLayerContentSearch(
      "请只检索标题或内容中包含“历任会长”的资料。",
    )).toBe(true);
    expect(requiresCrossLayerContentSearch(
      "查询文件名以及正文中出现“星火传承录”的资料。",
    )).toBe(true);
  });

  it("does not force Shared Brain for ordinary file lookup or document analysis", () => {
    expect(requiresCrossLayerContentSearch("请查找《协会章程》文件")).toBe(false);
    expect(requiresCrossLayerContentSearch("请分析这个文件的正文内容")).toBe(false);
  });

  it("forces one Shared Brain search after Library was queried", () => {
    const input = {
      query: "请检索标题或内容中包含“历任会长”的资料。",
      libraryQueryCount: 1,
      hasSearchedMemory: false,
      alreadyForced: false,
      resultTokenBudget: 2_000,
      stepNumber: 1,
      maxSteps: 12,
    };
    expect(shouldForceCrossLayerMemorySearch(input)).toBe(true);
    expect(shouldForceCrossLayerMemorySearch({
      ...input,
      hasSearchedMemory: true,
    })).toBe(false);
    expect(shouldForceCrossLayerMemorySearch({
      ...input,
      alreadyForced: true,
    })).toBe(false);
    expect(shouldForceCrossLayerMemorySearch({
      ...input,
      libraryQueryCount: 0,
    })).toBe(false);
  });
});
