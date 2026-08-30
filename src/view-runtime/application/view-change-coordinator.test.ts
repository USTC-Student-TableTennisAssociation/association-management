import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { societyInformationPlugin } from "@/plugins/society-information/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ViewChangeCoordinator } from "@/view-runtime/application/view-change-coordinator";

const actorId = "00000000-0000-4000-8000-000000000001";
const executionId = "00000000-0000-4000-8000-000000000003";
const societyCardId = "00000000-0000-4000-8000-000000000004";
const societyObjectId = "00000000-0000-4000-8000-000000000005";
const reactionId = "00000000-0000-4000-8000-000000000006";
const viewLocalCardId = "00000000-0000-4000-8000-000000000007";

function fixture(options: {
  deleted?: boolean;
  reconcileObject?: () => Promise<number>;
  reconcileView?: () => Promise<number>;
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
    eventsJson: [{
      type: "society.profile_updated",
      version: "1",
      payload: { cardId: societyCardId, changedDimensions: ["rating"] },
    }],
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
    attentionStartedAt: null as Date | null,
    attentionCompletedAt: null,
    knowledgeStartedAt: null as Date | null,
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
  };
  const readPort = {
    query: vi.fn().mockResolvedValue({
      viewKey: "society_information",
      pluginVersion: "1.10.0",
      schemaVersion: "5",
      stateVersion: "2",
      observedAt: "2026-08-26T00:00:00.000Z",
      cards: [
        ...(options.deleted ? [] : [{
          id: societyCardId,
          viewKey: "society_information",
          cardTypeKey: "SocietyCard",
          dimensions: { rating: "五星级社团" },
          slots: {},
          relatedObjectIds: [societyObjectId],
        }]),
        {
          id: viewLocalCardId,
          viewKey: "society_information",
          cardTypeKey: "SocietyCard",
          dimensions: { rating: "未评级" },
          slots: {},
          relatedObjectIds: [],
        },
      ],
    }),
  };
  const evaluate = vi.fn().mockResolvedValue({
    action: "request_confirmation",
    message: "知识层只有三星级的历史记录，请确认五星级是否已正式获评。",
    reason: "当前修改与修改前认知不一致",
  });
  const reconcileObjectHigherMemory = vi.fn(options.reconcileObject ?? (async () => 1));
  const reconcileViewHigherMemory = vi.fn(options.reconcileView ?? (async () => 1));
  const coordinator = new ViewChangeCoordinator({
    database: database as never,
    registry,
    readPort: readPort as never,
    evaluate,
    reconcileObjectHigherMemory,
    reconcileViewHigherMemory,
  });
  return {
    coordinator,
    evaluate,
    reconcileObjectHigherMemory,
    reconcileViewHigherMemory,
    reaction,
    viewChangeReaction,
  };
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
    const {
      coordinator,
      evaluate,
      reconcileObjectHigherMemory,
      reconcileViewHigherMemory,
      reaction,
    } = fixture({
      reconcileObject: () => reconciliation,
    });

    await expect(coordinator.enqueue({ reactionId })).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));

    expect(reconcileObjectHigherMemory).toHaveBeenCalledTimes(1);
    expect(reconcileViewHigherMemory).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      attentionPolicy: "evaluate",
      reactionGuidance: ["星级是正式评定结果。"],
      events: [{
        type: "society.profile_updated",
        version: "1",
        payload: { cardId: societyCardId, changedDimensions: ["rating"] },
        stateVersion: "2",
      }],
      objects: [expect.objectContaining({
        cognitiveMemory: { narrative: "历史资料只记录为三星级社团。" },
      })],
    }));
    expect(reconcileObjectHigherMemory).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        cards: [expect.objectContaining({ id: societyCardId })],
      }),
      objects: [expect.objectContaining({
        cognitiveMemory: { narrative: "历史资料只记录为三星级社团。" },
      })],
    }));
    expect(reconcileViewHigherMemory).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        cards: [
          expect.objectContaining({ id: societyCardId }),
          expect.objectContaining({ id: viewLocalCardId, relatedObjectIds: [] }),
        ],
      }),
    }));
    expect(reaction.attentionStatus).toBe("needs_confirmation");
    releaseReconciliation?.(1);
    await vi.waitFor(() => expect(reaction.knowledgeStatus).toBe("completed"));
    coordinator.dispose();
  });

  it("keeps a deleted card's former Object in both worker contexts", async () => {
    const {
      coordinator,
      evaluate,
      reconcileObjectHigherMemory,
      reconcileViewHigherMemory,
    } = fixture({ deleted: true });

    await coordinator.enqueue({ reactionId });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(reconcileObjectHigherMemory).toHaveBeenCalledTimes(1));

    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ cards: [] }),
      objects: [expect.objectContaining({ id: societyObjectId })],
    }));
    expect(reconcileObjectHigherMemory).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ cards: [] }),
      objects: [expect.objectContaining({ id: societyObjectId })],
      executions: [expect.objectContaining({
        changes: [expect.objectContaining({ kind: "card_deleted" })],
      })],
    }));
    expect(reconcileViewHigherMemory).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        cards: [expect.objectContaining({ id: viewLocalCardId })],
      }),
      objects: [expect.objectContaining({ id: societyObjectId })],
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

  it("requeues stale running work before resuming it", async () => {
    const {
      coordinator,
      evaluate,
      reaction,
      viewChangeReaction,
    } = fixture();
    reaction.attentionStatus = "running";
    reaction.knowledgeStatus = "running";
    reaction.attentionStartedAt = new Date(Date.now() - 11 * 60 * 1_000);
    reaction.knowledgeStartedAt = new Date(Date.now() - 11 * 60 * 1_000);
    reaction.settleUntil = new Date(Date.now());

    await expect(coordinator.resumePending({ viewKey: "society_information" }))
      .resolves.toBe(1);
    expect(viewChangeReaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        attentionStatus: "running",
        OR: expect.arrayContaining([{ attentionStartedAt: null }]),
      }),
      data: expect.objectContaining({
        attentionStatus: "queued",
        attentionStartedAt: null,
      }),
    }));
    expect(viewChangeReaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        knowledgeStatus: "running",
        OR: expect.arrayContaining([{ knowledgeStartedAt: null }]),
      }),
      data: expect.objectContaining({
        knowledgeStatus: "queued",
        knowledgeStartedAt: null,
      }),
    }));

    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    coordinator.dispose();
  });

  it("does not execute work when another process wins both claims", async () => {
    const {
      coordinator,
      evaluate,
      reconcileObjectHigherMemory,
      reconcileViewHigherMemory,
      viewChangeReaction,
    } = fixture();
    viewChangeReaction.updateMany.mockResolvedValue({ count: 0 });

    await coordinator.enqueue({ reactionId });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(evaluate).not.toHaveBeenCalled();
    expect(reconcileObjectHigherMemory).not.toHaveBeenCalled();
    expect(reconcileViewHigherMemory).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("does not let a superseded reconciliation overwrite a newer View state", async () => {
    const {
      coordinator,
      reconcileObjectHigherMemory,
      reconcileViewHigherMemory,
      reaction,
    } = fixture({ superseded: true });

    await coordinator.enqueue({ reactionId });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(reaction.knowledgeStatus).toBe("completed"));

    expect(reconcileObjectHigherMemory).not.toHaveBeenCalled();
    expect(reconcileViewHigherMemory).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
