import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { societyInformationPlugin } from "@/plugins/society-information/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ViewAIAttentionCoordinator } from "@/view-runtime/application/view-ai-attention";

const actor = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "开发用户",
};
const conversationId = "00000000-0000-4000-8000-000000000002";
const executionId = "00000000-0000-4000-8000-000000000003";
const societyCardId = "00000000-0000-4000-8000-000000000004";
const societyObjectId = "00000000-0000-4000-8000-000000000005";

function fixture(eventType: string) {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(societyInformationPlugin);
  registry.registerPlugin(activityOperationsPlugin);
  const stateVersionAfter = BigInt(2);
  const execution = {
    id: executionId,
    viewKey: "society_information",
    commandKey: eventType === "society.long_term_activities_reordered"
      ? "society.reorder_long_term_activities"
      : "society.update_profile",
    inputJson: { societyCardId, changes: { rating: "四星级社团" } },
    resultSummaryJson: { cardId: societyCardId },
    stateVersionBefore: BigInt(1),
    stateVersionAfter,
  };
  const domainEventOutbox = {
    findMany: vi.fn(async (query: { select?: { eventVersion?: boolean } }) =>
      query.select?.eventVersion
        ? [{ eventType, eventVersion: "1" }]
        : [{
            eventType,
            payloadJson: { cardId: societyCardId, changedDimensions: ["rating"] },
            stateVersion: stateVersionAfter,
          }]
    ),
  };
  const database = {
    viewCommandExecution: {
      findFirst: vi.fn().mockResolvedValue({
        id: execution.id,
        viewKey: execution.viewKey,
        stateVersionAfter,
      }),
      findMany: vi.fn().mockResolvedValue([execution]),
    },
    domainEventOutbox,
    memoryGlobalObject: {
      findMany: vi.fn().mockResolvedValue([{
        id: societyObjectId,
        canonicalName: "中国科学技术大学学生乒乓球协会",
        higherMemory: { cognitiveMemory: { narrative: "旧资料为三星级社团。" } },
      }]),
    },
  };
  const readPort = {
    query: vi.fn().mockResolvedValue({
      viewKey: "society_information",
      pluginVersion: "1.7.0",
      schemaVersion: "5",
      stateVersion: "2",
      observedAt: "2026-08-26T00:00:00.000Z",
      cards: [{
        id: societyCardId,
        viewKey: "society_information",
        cardTypeKey: "SocietyCard",
        dimensions: { rating: "四星级社团" },
        slots: {},
        relatedObjectIds: [societyObjectId],
      }],
      references: [],
    }),
  };
  const evaluate = vi.fn().mockResolvedValue({
    action: "respond",
    message: "需要我整理一条 Shared Brain 更新候选吗？",
    reason: "正式状态与旧高层记忆不一致",
  });
  const appendMessage = vi.fn().mockResolvedValue(undefined);
  const loadConversation = vi.fn().mockResolvedValue([]);
  const coordinator = new ViewAIAttentionCoordinator({
    database: database as never,
    registry,
    readPort: readPort as never,
    evaluate,
    appendMessage,
    loadConversation,
    defaultSettleMs: 1_000,
  });
  return { coordinator, evaluate, appendMessage, loadConversation };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("View AI attention coordinator", () => {
  it("evaluates settled human changes and appends at most one assistant message", async () => {
    const { coordinator, evaluate, appendMessage, loadConversation } = fixture(
      "society.profile_updated",
    );

    await expect(coordinator.enqueue({ executionId, actor, conversationId }))
      .resolves.toBe("scheduled");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));

    expect(loadConversation).toHaveBeenCalledWith({ actor, conversationId });
    expect(appendMessage).toHaveBeenCalledWith({
      actor,
      conversationId,
      text: "需要我整理一条 Shared Brain 更新候选吗？",
    });
    coordinator.dispose();
  });

  it("does not invoke the background model for next-turn-only events", async () => {
    const { coordinator, evaluate, appendMessage } = fixture(
      "society.long_term_activities_reordered",
    );

    await expect(coordinator.enqueue({ executionId, actor, conversationId }))
      .resolves.toBe("next_turn");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(evaluate).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
