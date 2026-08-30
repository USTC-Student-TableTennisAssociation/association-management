import { beforeEach, describe, expect, it, vi } from "vitest";

const aiState = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return { ...original, generateText: aiState.generateText };
});
vi.mock("@/ai/provider", () => ({ getChatModel: () => ({}) }));

import {
  buildViewChangeObserverPrompt,
  observeViewChanges,
  type ViewChangeObserverInput,
} from "@/ai/view-change-observer";
import { societyInformationViewModule } from "@/plugins/society-information/view/schema";

const societyCardId = "00000000-0000-4000-8000-000000000001";
const societyObjectId = "00000000-0000-4000-8000-000000000002";

function input(): ViewChangeObserverInput {
  return {
    viewModule: societyInformationViewModule,
    snapshot: {
      viewKey: "society_information",
      pluginVersion: "1.10.0",
      schemaVersion: "5",
      stateVersion: "8",
      observedAt: "2026-08-26T00:00:00.000Z",
      cards: [{
        id: societyCardId,
        viewKey: "society_information",
        cardTypeKey: "SocietyCard",
        dimensions: { rating: "四星级社团" },
        slots: {},
        relatedObjectIds: [societyObjectId],
      }],
    },
    executions: [{
      id: "00000000-0000-4000-8000-000000000003",
      commandKey: "society.update_profile",
      input: { societyCardId, changes: { rating: "四星级社团" } },
      result: { cardId: societyCardId, changedDimensions: ["rating"] },
      stateVersionBefore: "7",
      stateVersionAfter: "8",
      changes: [{
        kind: "dimension",
        cardId: societyCardId,
        cardTypeKey: "SocietyCard",
        dimensionKey: "rating",
        before: { present: true, value: "三星级社团" },
        after: { present: true, value: "四星级社团" },
      }],
    }],
    events: [{
      type: "society.profile_updated",
      version: "1",
      payload: { cardId: societyCardId, changedDimensions: ["rating"] },
      stateVersion: "8",
    }],
    objects: [{
      id: societyObjectId,
      canonicalName: "中国科学技术大学学生乒乓球协会",
      cognitiveMemory: { narrative: "旧资料仍记录为三星级社团。" },
    }],
    attentionPolicy: "evaluate",
    reactionGuidance: ["社团星级是正式评价事实。"],
    conversation: [{
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "我正在整理社团概览。" }],
    }],
  };
}

beforeEach(() => vi.clearAllMocks());

describe("View Change Observer", () => {
  it("presents logical references without leaking storage UUIDs", () => {
    const prompt = buildViewChangeObserverPrompt(input());

    expect(prompt).toContain("V1");
    expect(prompt).toContain("O1");
    expect(prompt).toContain("四星级社团");
    expect(prompt).toContain("三星级社团");
    expect(prompt).toContain("社团在当前评价体系中正式获评的等级");
    expect(prompt).toContain("旧资料仍记录为三星级社团");
    expect(prompt).toContain("不得把本次修改所生成的派生知识");
    expect(prompt).toContain("不是纯展示文字");
    expect(prompt).not.toContain(societyCardId);
    expect(prompt).not.toContain(societyObjectId);
  });

  it("requires a structured intervention decision", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitViewAttentionDecision",
        input: {
          action: "request_confirmation",
          message: "四星级对应的评审结果是否还需要同步到公开平台简介？",
          reason: "正式等级变化可能影响对外展示口径",
        },
      }],
    });

    await expect(observeViewChanges(input())).resolves.toEqual(expect.objectContaining({
      action: "request_confirmation",
    }));
    expect(aiState.generateText).toHaveBeenCalledWith(expect.objectContaining({
      toolChoice: { type: "tool", toolName: "submitViewAttentionDecision" },
    }));
  });

  it("represents silence explicitly without a user-visible message", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitViewAttentionDecision",
        input: {
          action: "silent",
          message: "",
          reason: "本次变化只是展示层微调",
        },
      }],
    });

    await expect(observeViewChanges(input())).resolves.toEqual({
      action: "silent",
      message: "",
      reason: "本次变化只是展示层微调",
    });
  });

  it("makes silence invalid in the tool schema for an always-visible review", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitViewAttentionDecision",
        input: {
          action: "silent",
          message: "",
          reason: "没有发现冲突",
        },
      }],
    });
    const value = input();
    value.attentionPolicy = "always";

    await expect(observeViewChanges(value)).rejects.toThrow();
  });
});
