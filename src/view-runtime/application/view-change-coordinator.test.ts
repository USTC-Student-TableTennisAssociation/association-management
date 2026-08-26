import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { societyInformationPlugin } from "@/plugins/society-information/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ViewChangeCoordinator } from "@/view-runtime/application/view-change-coordinator";

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
      findMany: vi.fn()
        .mockResolvedValueOnce([{
          id: societyObjectId,
          canonicalName: "中国科学技术大学学生乒乓球协会",
          higherMemory: { cognitiveMemory: { narrative: "旧资料为三星级社团。" } },
        }])
        .mockResolvedValueOnce([{
          id: societyObjectId,
          canonicalName: "中国科学技术大学学生乒乓球协会",
          higherMemory: { cognitiveMemory: { narrative: "现已正式获评四星级社团。" } },
        }]),
    },
  };
  const readPort = {
    query: vi.fn().mockResolvedValue({
      viewKey: "society_information",
      pluginVersion: "1.8.0",
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
    message: "需要我检查对外展示口径吗？",
    reason: "正式状态可能影响公开页面",
  });
  const appendMessage = vi.fn().mockResolvedValue(undefined);
  const loadConversation = vi.fn().mockResolvedValue([]);
  const reconcileHigherMemory = vi.fn().mockResolvedValue(1);
  const coordinator = new ViewChangeCoordinator({
    database: database as never,
    registry,
    readPort: readPort as never,
    evaluate,
    reconcileHigherMemory,
    appendMessage,
    loadConversation,
    defaultSettleMs: 1_000,
  });
  return {
    coordinator,
    evaluate,
    reconcileHigherMemory,
    appendMessage,
    loadConversation,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("View AI attention coordinator", () => {
  it("evaluates settled human changes and appends at most one assistant message", async () => {
    const {
      coordinator,
      evaluate,
      reconcileHigherMemory,
      appendMessage,
      loadConversation,
    } = fixture(
      "society.profile_updated",
    );

    await expect(coordinator.enqueue({ executionId, actor, conversationId }))
      .resolves.toBe("scheduled");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));

    expect(reconcileHigherMemory).toHaveBeenCalledTimes(1);
    expect(reconcileHigherMemory.mock.invocationCallOrder[0])
      .toBeLessThan(evaluate.mock.invocationCallOrder[0]);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      objects: [expect.objectContaining({
        cognitiveMemory: { narrative: "现已正式获评四星级社团。" },
      })],
    }));
    expect(loadConversation).toHaveBeenCalledWith({ actor, conversationId });
    expect(appendMessage).toHaveBeenCalledWith({
      actor,
      conversationId,
      text: "需要我检查对外展示口径吗？",
    });
    coordinator.dispose();
  });

  it("does not invoke the background model for next-turn-only events", async () => {
    const { coordinator, evaluate, reconcileHigherMemory, appendMessage } = fixture(
      "society.long_term_activities_reordered",
    );

    await expect(coordinator.enqueue({ executionId, actor, conversationId }))
      .resolves.toBe("next_turn");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(evaluate).not.toHaveBeenCalled();
    expect(reconcileHigherMemory).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("reconciles existing Higher Memory without requiring a conversation", async () => {
    const { coordinator, evaluate, reconcileHigherMemory, appendMessage } = fixture(
      "society.profile_updated",
    );

    await expect(coordinator.enqueue({ executionId, actor }))
      .resolves.toBe("ignored");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(reconcileHigherMemory).toHaveBeenCalledTimes(1));

    expect(evaluate).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
