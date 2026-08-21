import { beforeEach, describe, expect, it, vi } from "vitest";

const aiState = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("ai", async () => {
  const original = await vi.importActual<typeof import("ai")>("ai");
  return { ...original, generateText: aiState.generateText };
});
vi.mock("@/ai/provider", () => ({ getChatModel: vi.fn(() => "test-model") }));

import {
  curateRetrievalAssertions,
  resolveRetrievalTargets,
} from "@/memory/retrieval-curator";

const context = {
  conversation: [{
    messageId: "u1",
    role: "user" as const,
    text: "我问的是乒协组织本身，不是乒协知识库。",
  }],
  originalUserMessage: "那它目前最大的问题是什么？",
  currentInstant: "2026-08-14T00:00:00.000Z",
  timezone: "Asia/Shanghai",
};

const objects = [
  {
    id: "association",
    canonicalName: "中国科学技术大学学生乒乓球协会",
    surfaceForms: ["乒协"],
    lexicalMatch: true,
    semanticMatch: true,
  },
  {
    id: "knowledge-base",
    canonicalName: "乒协知识库",
    surfaceForms: ["知识库"],
    lexicalMatch: true,
    semanticMatch: true,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveRetrievalTargets", () => {
  it("uses the deterministic fast path for a unique exact alias", async () => {
    const result = await resolveRetrievalTargets({
      query: "当前治理问题",
      targetHints: ["乒协"],
      candidates: objects,
      context,
    });

    expect(result).toMatchObject({
      targetObjectIds: ["association"],
      mode: "deterministic",
    });
    expect(aiState.generateText).not.toHaveBeenCalled();
  });

  it("uses full conversation context for an ambiguous pronoun", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitRetrievalTarget",
        input: {
        targetObjects: [{ id: "association", reason: "前文明确纠正为组织本身。" }],
        },
      }],
      reasoningText: "根据完整前文消解它的指代。",
    });
    const result = await resolveRetrievalTargets({
      query: "当前治理问题",
      targetHints: ["它"],
      candidates: objects,
      context,
    });

    expect(result.mode).toBe("model");
    expect(result.targetObjectIds).toEqual(["association"]);
    expect(aiState.generateText.mock.calls[0][0].prompt).toContain("我问的是乒协组织本身");
    expect(aiState.generateText.mock.calls[0][0].prompt).toContain("那它目前最大的问题是什么");
    expect(aiState.generateText.mock.calls[0][0]).toMatchObject({
      tools: { submitRetrievalTarget: expect.any(Object) },
      toolChoice: { type: "tool", toolName: "submitRetrievalTarget" },
    });
  });

  it("rejects invented ids without guessing among multiple identity-supported candidates", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitRetrievalTarget",
        input: {
        targetObjects: [{ id: "invented", reason: "错误对象" }],
        },
      }],
      reasoningText: "错误选择",
    });
    const result = await resolveRetrievalTargets({
      query: "当前治理问题",
      targetHints: ["它"],
      candidates: objects,
      context,
    });

    expect(result.mode).toBe("none");
    expect(result.targetObjectIds).toEqual([]);
    expect(result.warning).toContain("未绑定任何候选 Object");
  });

  it("rejects a semantically related event when its proper name has no identity match", async () => {
    const relatedEvent = {
      id: "member-tournament",
      canonicalName: "会员大赛",
      surfaceForms: ["会员大赛"],
      lexicalMatch: false,
      semanticMatch: true,
    };
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitRetrievalTarget",
        input: {
          targetObjects: [{
            id: "member-tournament",
            reason: "Echo人工验收赛属于赛事，因此选择最相似的会员大赛。",
          }],
        },
      }],
      reasoningText: "按赛事类别选择最相似对象。",
    });

    const result = await resolveRetrievalTargets({
      query: "举行时间、地点、安排与状态",
      targetHints: ["Echo人工验收赛-20260821-B4"],
      candidates: [relatedEvent],
      context: {
        ...context,
        conversation: [{
          messageId: "u-b4",
          role: "user",
          text: "Echo人工验收赛-20260821-B4可能在2026年8月25日举行，地点还没有确定。",
        }],
        originalUserMessage: "Echo人工验收赛-20260821-B4可能在2026年8月25日举行，地点还没有确定。",
      },
    });

    expect(result).toMatchObject({
      mode: "none",
      targetObjectIds: [],
    });
    expect(result.warning).toContain("无身份依据");
  });

  it("does not reuse an old conversation Object against a new explicit target name", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitRetrievalTarget",
        input: {
          targetObjects: [{ id: "member-tournament", reason: "前文讨论过会员大赛。" }],
        },
      }],
      reasoningText: "沿用前文活动。",
    });

    const result = await resolveRetrievalTargets({
      query: "举行时间和地点",
      targetHints: ["Echo人工验收赛-20260821-B5"],
      candidates: [{
        id: "member-tournament",
        canonicalName: "会员大赛",
        surfaceForms: ["会员大赛"],
        lexicalMatch: false,
        semanticMatch: true,
      }],
      context: {
        ...context,
        conversation: [
          { messageId: "u-old", role: "user", text: "会员大赛去年在哪里举行？" },
          {
            messageId: "u-new",
            role: "user",
            text: "Echo人工验收赛-20260821-B5可能在明天举行。",
          },
        ],
        originalUserMessage: "Echo人工验收赛-20260821-B5可能在明天举行。",
      },
    });

    expect(result).toMatchObject({ mode: "none", targetObjectIds: [] });
  });

  it("allows the model to return no target when no candidate has the same identity", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitRetrievalTarget",
        input: { targetObjects: [] },
      }],
      reasoningText: "候选只是同类对象，不是同一对象。",
    });

    const result = await resolveRetrievalTargets({
      query: "举行时间与地点",
      targetHints: ["全新验收赛"],
      candidates: [{
        id: "old-event",
        canonicalName: "旧比赛",
        surfaceForms: ["旧比赛"],
        lexicalMatch: false,
        semanticMatch: true,
      }],
      context,
    });

    expect(result).toMatchObject({ mode: "none", targetObjectIds: [] });
    expect(result.warning).toContain("没有能够确认身份");
  });
});

describe("curateRetrievalAssertions", () => {
  const assertions = Array.from({ length: 10 }, (_, index) => ({
    id: `assertion-${index + 1}`,
    renderedStatement: `候选事实 ${index + 1}`,
    kind: "grounded" as const,
    contextDependent: false,
    sourceSummary: ["document:test"],
  }));

  it("returns only candidate ids selected by the model", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitRetrievalSelection",
        input: {
        selectedAssertions: [
          { id: "assertion-2", reason: "直接回答" },
          { id: "assertion-5", reason: "保留不同限定" },
        ],
        coverage: "partial",
        missingAspects: ["当前有效性"],
        },
      }],
      reasoningText: "保留直接回答且限定不同的证据。",
    });
    const result = await curateRetrievalAssertions({
      query: "当前治理问题",
      targetHints: ["乒协"],
      targetObjects: [objects[0]],
      candidates: assertions,
      context,
    });

    expect(result).toMatchObject({
      mode: "model",
      selectedAssertionIds: ["assertion-2", "assertion-5"],
      coverage: "partial",
      missingAspects: ["当前有效性"],
    });
    expect(aiState.generateText.mock.calls[0][0]).toMatchObject({
      tools: { submitRetrievalSelection: expect.any(Object) },
      toolChoice: { type: "tool", toolName: "submitRetrievalSelection" },
    });
  });

  it("falls back to the first six candidates when the model fails", async () => {
    aiState.generateText.mockRejectedValue(new Error("provider unavailable"));
    const result = await curateRetrievalAssertions({
      query: "当前治理问题",
      targetHints: ["乒协"],
      targetObjects: [objects[0]],
      candidates: assertions,
      context,
    });

    expect(result.mode).toBe("fallback");
    expect(result.selectedAssertionIds).toEqual(
      assertions.slice(0, 6).map((assertion) => assertion.id),
    );
  });
});
