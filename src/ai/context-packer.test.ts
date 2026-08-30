import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  ContextPackingError,
  estimateMessageTokens,
  estimateTokens,
  packContext,
} from "@/ai/context-packer";
import type { ModelProfile } from "@/ai/model-profile";
import { buildEvidenceContext } from "@/memory/context-builder";
import type { MemoryAssertionSeed, MemoryRetrievalResult } from "@/memory/types";

const roomyProfile: ModelProfile = {
  contextWindowTokens: 200_000,
  preferredInputTokens: 128_000,
  maxOutputTokens: 16_384,
  safetyTokens: 12_000,
  historyMaxTokens: 40_000,
  memoryMaxTokens: 64_000,
  maxRequestBytes: 2_000_000,
  maxRetries: 2,
  modelFirstChunkTimeoutMs: 180_000,
  modelChunkTimeoutMs: 180_000,
};

function message(role: "user" | "assistant", content: string): ModelMessage {
  return { role, content };
}

function memory(id: string, content: string): MemoryAssertionSeed {
  return {
    ref: id,
    kind: "grounded",
    dereferenceRequired: false,
    sourceNodeId: "region-test",
    sourceClaimId: id,
    renderedStatement: content,
    contextDependent: false,
    matchedBy: [],
    matchedFacets: [],
    sources: [
      {
        kind: "document",
        sourceDocumentId: "document-test",
        sourceTitle: "测试来源",
        sourceSha256: "sha",
        sourceNodeId: "region-test",
        sourceRegionLabel: "测试区域",
        sourceBlockId: "block-1",
        ordinal: 0,
        pages: [1],
      },
    ],
  };
}

function retrieval(assertions: MemoryAssertionSeed[] = []): MemoryRetrievalResult {
  return {
    query: "test",
    mode: "fixture",
    seedMap: { facets: [], objects: [], assertions, connections: [] },
  };
}

describe("packContext", () => {
  it("keeps a 20,000-character current user message intact", () => {
    const content = "长".repeat(20_000);
    const result = packContext({
      messages: [message("user", content)],
      retrieval: retrieval(),
      profile: roomyProfile,
    });

    expect(result.messages).toEqual([message("user", content)]);
  });

  it("keeps more than 20 short history messages when the budget allows", () => {
    const history = Array.from({ length: 50 }, (_, index) => [
      message("user", `user-${index}`),
      message("assistant", `assistant-${index}`),
    ]).flat();
    const result = packContext({
      messages: [...history, message("user", "current")],
      retrieval: retrieval(),
      profile: roomyProfile,
    });

    expect(result.report.selected.conversationMessages).toBe(100);
    expect(result.report.dropped.conversationMessages).toBe(0);
  });

  it("selects complete recent turns and restores chronological order", () => {
    const turnTokens =
      estimateMessageTokens(message("user", "recent-user")) +
      estimateMessageTokens(message("assistant", "recent-answer"));
    const result = packContext({
      messages: [
        message("assistant", "orphan welcome"),
        message("user", "old-user"),
        message("assistant", "old-answer"),
        message("user", "recent-user"),
        message("assistant", "recent-answer"),
        message("user", "current"),
      ],
      retrieval: retrieval(),
      profile: { ...roomyProfile, historyMaxTokens: turnTokens },
    });

    expect(result.messages).toEqual([
      message("user", "recent-user"),
      message("assistant", "recent-answer"),
      message("user", "current"),
    ]);
    expect(result.report.dropped.conversationMessages).toBe(3);
  });

  it("drops old history before touching the complete current message", () => {
    const current = "现".repeat(3_000);
    const result = packContext({
      messages: [
        message("user", "old".repeat(2_000)),
        message("assistant", "answer".repeat(2_000)),
        message("user", current),
      ],
      retrieval: retrieval(),
      profile: {
        ...roomyProfile,
        preferredInputTokens: 1_100,
        historyMaxTokens: 10_000,
      },
    });

    expect(result.messages).toEqual([message("user", current)]);
  });

  it("rejects a current message that exceeds the hard input limit", () => {
    expect(() =>
      packContext({
        messages: [message("user", "太长".repeat(1_000))],
        retrieval: retrieval(),
        profile: {
          ...roomyProfile,
          contextWindowTokens: 1_000,
          maxOutputTokens: 200,
          safetyTokens: 200,
          preferredInputTokens: 500,
        },
      }),
    ).toThrowError(ContextPackingError);
  });

  it("packs only complete retrieval items within the memory budget", () => {
    const first = memory("memory-1", "a".repeat(600));
    const second = memory("memory-2", "b".repeat(600));
    const oneItemBudget = estimateTokens(
      buildEvidenceContext(retrieval([first])),
    );
    const result = packContext({
      messages: [message("user", "current")],
      retrieval: retrieval([first, second]),
      profile: { ...roomyProfile, memoryMaxTokens: oneItemBudget },
    });

    expect(result.retrieval.seedMap.assertions).toEqual([first]);
    expect(result.report.dropped.memoryItems).toBe(1);
    expect(result.system).toContain("memory-1");
    expect(result.system).not.toContain("memory-2");
  });

  it("does not add anything when retrieval is small or empty", () => {
    const result = packContext({
      messages: [message("user", "current")],
      retrieval: retrieval(),
      profile: roomyProfile,
    });

    expect(result.retrieval.seedMap.assertions).toEqual([]);
    expect(result.report.estimatedTokens.memory).toBe(0);
    expect(result.report.dropped.memoryItems).toBe(0);
  });

  it("does not describe an unsearched empty seed map as a failed Locate", () => {
    const result = packContext({
      messages: [message("user", "你好")],
      retrieval: retrieval(),
      profile: roomyProfile,
      memoryState: "not-searched",
    });

    expect(result.system).not.toContain("Locate");
    expect(result.system).not.toContain("资料不足");
    expect(result.report.estimatedTokens.memory).toBe(0);
    expect(result.system).toContain("本轮没有加载到 identity、narrative 或 working_set");
    expect(result.system).toContain("没有一个关于 Sydaris 自身的 Object Higher Memory");
    expect(result.system).toContain("不等于“Sydaris 没有 Higher Memory”");
  });

  it("always includes environment identity and working set before any search", () => {
    const result = packContext({
      messages: [message("user", "你好")],
      retrieval: retrieval(),
      profile: roomyProfile,
      memoryState: "not-searched",
      ambientHigherMemories: [{
        scope: "identity",
        contentMarkdown: "Sydaris 当前正在帮助一个团队延续共同工作。",
        maintainedAt: "2026-08-15T00:00:00.000Z",
      }, {
        scope: "working_set",
        contentMarkdown: "近期主要在准备一场比赛。",
        maintainedAt: "2026-08-15T00:00:00.000Z",
      }],
    });

    expect(result.system).toContain("Environment Identity");
    expect(result.system).toContain("Shared Working Set");
    expect(result.system).toContain("近期主要在准备一场比赛");
    expect(result.system).not.toContain("本轮 Object–Assertion Locate");
  });

  it("automatically loads only the current Actor's natural-language Higher Memory", () => {
    const result = packContext({
      messages: [message("user", "你好")],
      retrieval: retrieval(),
      profile: roomyProfile,
      memoryState: "not-searched",
      actorPrivateMemory: {
        higherMemories: [{
          scope: "interaction",
          contentMarkdown: "当前用户希望 Sydaris 在回答不确定问题时先说明证据边界。",
          maintainedAt: "2026-08-27T00:00:00.000Z",
        }],
      },
    });

    expect(result.system).toContain("当前 Actor 的私有长期记忆");
    expect(result.system).toContain("当前用户希望 Sydaris 在回答不确定问题时先说明证据边界");
    expect(result.system).toContain("不得向其他 Actor 暴露");
    expect(result.system).toContain("Interaction Context");
  });

  it("reports component estimates and a consistent total", () => {
    const result = packContext({
      messages: [
        message("user", "history"),
        message("assistant", "answer"),
        message("user", "current"),
      ],
      retrieval: retrieval([memory("memory-1", "content")]),
      profile: roomyProfile,
    });
    const tokens = result.report.estimatedTokens;

    expect(tokens.totalInput).toBe(
      tokens.system +
        tokens.conversation +
        tokens.memory +
        tokens.currentMessage,
    );
    expect(result.report.selected).toEqual({
      conversationMessages: 2,
      memoryItems: 1,
    });
  });
});
