import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { societyInformationPlugin } from "@/plugins/society-information/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ViewChangeCoordinator } from "@/view-runtime/application/view-change-coordinator";

const actorId = "00000000-0000-4000-8000-000000000001";
const executionId = "00000000-0000-4000-8000-000000000003";
const societyCardId = "00000000-0000-4000-8000-000000000004";
const societyObjectId = "00000000-0000-4000-8000-000000000005";
const reactionId = "00000000-0000-4000-8000-000000000006";

function fixture(options: {
  deleted?: boolean;
  reconcile?: () => Promise<number>;
  superseded?: boolean;
} = {}) {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(societyInformationPlugin);
  const changes = options.deleted
    ? [{
        kind: "card_deleted",
        card: {
          id: societyCardId,
          viewKey: "society_information",
          cardTypeKey: "SocietyCard",
          dimensions: { rating: "三星级社团" },
          slots: {},
          relatedObjectIds: [societyObjectId],
        },
      }]
    : [{
        kind: "dimension",
        cardId: societyCardId,
        cardTypeKey: "SocietyCard",
        dimensionKey: "rating",
        before: { present: true, value: "三星级社团" },
        after: { present: true, value: "五星级社团" },
      }];
  const execution = {
    id: executionId,
    viewKey: "society_information",
    commandKey: "society.update_profile",
    commandVersion: "1",
    inputJson: { societyCardId, changes: { rating: "五星级社团" } },
    actorId,
    initiator: "human",
    skillId: null,
    resultSummaryJson: { cardId: societyCardId },
    stateVersionBefore: BigInt(1),
    stateVersionAfter: BigInt(2),
    changeSetJson: changes,
    createdAt: new Date(),
  };
  const reaction = {
    id: reactionId,
    executionId,
    viewKey: "society_information",
    actorId,
    stateVersion: BigInt(2),
    targetsJson: [{ kind: "dimension", cardId: societyCardId, cardTypeKey: "SocietyCard", dimensionKey: "rating" }],
    priorObjectsJson: [{
      id: societyObjectId,
      canonicalName: "中国科学技术大学学生乒乓球协会",
      cognitiveMemory: { narrative: "历史资料只记录为三星级社团。" },
    }],
    attentionPolicy: "evaluate",
    attentionStatus: "queued",
    knowledgePolicy: "reconcile",
    knowledgeStatus: "queued",
    guidanceJson: ["星级是正式评定结果。"],
    message: null,
    reason: null,
    attentionErrorMessage: null,
    knowledgeErrorMessage: null,
    settleUntil: new Date(Date.now() + 1_000),
    attentionStartedAt: null,
    attentionCompletedAt: null,
    knowledgeStartedAt: null,
    knowledgeCompletedAt: null,
    seenAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    execution,
  };
  const viewChangeReaction = {
    findFirst: vi.fn().mockResolvedValue(reaction),
    findMany: vi.fn().mockResolvedValue([reaction]),
    findUnique: vi.fn().mockImplementation(() => Promise.resolve(reaction)),
    count: vi.fn().mockResolvedValue(options.superseded ? 1 : 0),
    updateMany: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      Object.assign(reaction, data);
      return Promise.resolve({ count: 1 });
    }),
    update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      Object.assign(reaction, data, { updatedAt: new Date() });
      return Promise.resolve(reaction);
    }),
  };
  const database = {
    viewChangeReaction,
    domainEventOutbox: {
      findMany: vi.fn().mockResolvedValue([{
        eventType: "society.profile_updated",
        eventVersion: "1",
        payloadJson: { cardId: societyCardId, changedDimensions: ["rating"] },
        stateVersion: BigInt(2),
        occurredAt: new Date(),
      }]),
    },
  };
  const readPort = {
    query: vi.fn().mockResolvedValue({
      viewKey: "society_information",
      pluginVersion: "1.10.0",
      schemaVersion: "5",
      stateVersion: "2",
      observedAt: "2026-08-26T00:00:00.000Z",
      cards: options.deleted ? [] : [{
        id: societyCardId,
        viewKey: "society_information",
        cardTypeKey: "SocietyCard",
        dimensions: { rating: "五星级社团" },
        slots: {},
        relatedObjectIds: [societyObjectId],
      }],
      references: [],
    }),
  };
  const evaluate = vi.fn().mockResolvedValue({
    action: "request_confirmation",
    message: "知识层只有三星级的历史记录，请确认五星级是否已正式获评。",
    reason: "当前修改与修改前认知不一致",
  });
  const reconcileHigherMemory = vi.fn(options.reconcile ?? (async () => 1));
  const coordinator = new ViewChangeCoordinator({
    database: database as never,
    registry,
    readPort: readPort as never,
    evaluate,
    reconcileHigherMemory,
  });
  return { coordinator, evaluate, reconcileHigherMemory, reaction, viewChangeReaction };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("View change reaction coordinator", () => {
  it("evaluates and reconciles in parallel from the same pre-change knowledge", async () => {
    let releaseReconciliation: ((value: number) => void) | undefined;
    const reconciliation = new Promise<number>((resolve) => {
      releaseReconciliation = resolve;
    });
    const { coordinator, evaluate, reconcileHigherMemory, reaction } = fixture({
      reconcile: () => reconciliation,
    });

    await expect(coordinator.enqueue({ reactionId })).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));

    expect(reconcileHigherMemory).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      attentionPolicy: "evaluate",
      reactionGuidance: ["星级是正式评定结果。"],
      objects: [expect.objectContaining({
        cognitiveMemory: { narrative: "历史资料只记录为三星级社团。" },
      })],
    }));
    expect(reconcileHigherMemory).toHaveBeenCalledWith(expect.objectContaining({
      objects: [expect.objectContaining({
        cognitiveMemory: { narrative: "历史资料只记录为三星级社团。" },
      })],
    }));
    expect(reaction.attentionStatus).toBe("needs_confirmation");
    releaseReconciliation?.(1);
    await vi.waitFor(() => expect(reaction.knowledgeStatus).toBe("completed"));
    coordinator.dispose();
  });

  it("keeps a deleted card's former Object in both worker contexts", async () => {
    const { coordinator, evaluate, reconcileHigherMemory } = fixture({ deleted: true });

    await coordinator.enqueue({ reactionId });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(reconcileHigherMemory).toHaveBeenCalledTimes(1));

    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ cards: [] }),
      objects: [expect.objectContaining({ id: societyObjectId })],
    }));
    expect(reconcileHigherMemory).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ cards: [] }),
      objects: [expect.objectContaining({ id: societyObjectId })],
      executions: [expect.objectContaining({
        changes: [expect.objectContaining({ kind: "card_deleted" })],
      })],
    }));
    coordinator.dispose();
  });

  it("resumes durable queued reactions when the View reconnects", async () => {
    const { coordinator } = fixture();

    await expect(coordinator.resumePending({ viewKey: "society_information" }))
      .resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    coordinator.dispose();
  });

  it("does not let a superseded reconciliation overwrite a newer View state", async () => {
    const { coordinator, reconcileHigherMemory, reaction } = fixture({ superseded: true });

    await coordinator.enqueue({ reactionId });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(reaction.knowledgeStatus).toBe("completed"));

    expect(reconcileHigherMemory).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
