import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleState = vi.hoisted(() => ({
  afterCallback: undefined as (() => Promise<void>) | undefined,
  capture: vi.fn(),
  maintain: vi.fn(),
  receiptClaim: vi.fn(),
  receiptComplete: vi.fn(),
  receiptFail: vi.fn(),
  loadReceipt: vi.fn(),
  recoverReceipts: vi.fn(),
  consolidate: vi.fn(),
  maintainActor: vi.fn(),
  order: [] as string[],
}));

vi.mock("next/server", () => ({
  after: (callback: () => Promise<void>) => {
    lifecycleState.afterCallback = callback;
  },
}));
vi.mock("@/memory/chat-assertion", () => ({
  captureChatAssertions: lifecycleState.capture,
}));
vi.mock("@/memory/chat-assertion-receipt", () => ({
  loadChatAssertionReceiptInput: lifecycleState.loadReceipt,
  claimChatAssertionReceipt: lifecycleState.receiptClaim,
  completeChatAssertionReceipt: lifecycleState.receiptComplete,
  failChatAssertionReceipt: lifecycleState.receiptFail,
  recoverPendingChatAssertionReceipts: lifecycleState.recoverReceipts,
}));
vi.mock("@/memory/higher-memory-maintenance", () => ({
  maintainHigherMemories: lifecycleState.maintain,
}));
vi.mock("@/memory/knowledge-consolidator", () => ({
  consolidateTurnKnowledge: lifecycleState.consolidate,
}));
vi.mock("@/memory/actor-higher-memory", () => ({
  maintainActorHigherMemories: lifecycleState.maintainActor,
}));

import {
  createChatMemoryMaintenanceScheduler,
  resumePendingChatAssertionReceipts,
} from "@/memory/chat-assertion-lifecycle";

const claimStartedAt = new Date("2026-08-14T00:00:01.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  lifecycleState.afterCallback = undefined;
  lifecycleState.order = [];
  lifecycleState.receiptClaim.mockImplementation(async (key: object) => ({
    ...key,
    startedAt: claimStartedAt,
  }));
  lifecycleState.recoverReceipts.mockResolvedValue([]);
  lifecycleState.capture.mockImplementation(async () => {
    lifecycleState.order.push("assertion:start");
    await Promise.resolve();
    lifecycleState.order.push("assertion:end");
    return {
      publishedAssertions: 2,
      publishedAssertionIds: ["assertion-1", "assertion-2"],
      affectedObjectIds: ["object-1"],
      affectedObjects: [{
        id: "object-1",
        canonicalName: "测试对象",
        resolution: "existing",
      }],
    };
  });
  lifecycleState.maintain.mockImplementation(async () => {
    lifecycleState.order.push("higher-memory:start");
    return { objectMemories: 1, ambientMemories: 0 };
  });
  lifecycleState.consolidate.mockResolvedValue({
    objectUpdates: [{
      globalObjectId: "object-1",
      canonicalName: "测试对象",
      focus: "已发布的新 Assertion 改变了当前状态。",
    }],
    ambientUpdates: [],
  });
  lifecycleState.maintainActor.mockImplementation(async () => {
    lifecycleState.order.push("actor-higher-memory:start");
    return 1;
  });
  lifecycleState.loadReceipt.mockImplementation(async (key: { clientMessageId: string }) => ({
    clientMessageId: key.clientMessageId,
    submittedAt: "2026-08-14T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    semanticContext: {},
    retrieval: {},
    queueDecision: { reason: "durable job" },
  }));
});

describe("post-answer memory maintenance pipeline", () => {
  it("loads a persisted job by key before starting background capture", async () => {
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertionReceipt: { actorId: "actor-1", clientMessageId: "message-durable" },
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.loadReceipt).toHaveBeenCalledWith({
      actorId: "actor-1",
      clientMessageId: "message-durable",
      startedAt: claimStartedAt,
    });
    expect(lifecycleState.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMessageId: "message-durable",
        queueDecision: { reason: "durable job" },
      }),
      undefined,
    );
  });

  it("always completes Chat Assertion before starting Higher Memory", async () => {
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertionReceipt: { actorId: "actor-1", clientMessageId: "message-1" },
      higherMemory: { clientMessageId: "message-1" } as never,
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.order).toEqual([
      "assertion:start",
      "assertion:end",
      "higher-memory:start",
    ]);
    expect(lifecycleState.capture).toHaveBeenCalledOnce();
    expect(lifecycleState.receiptClaim).toHaveBeenCalledWith({
      actorId: "actor-1",
      clientMessageId: "message-1",
    });
    expect(lifecycleState.receiptComplete).toHaveBeenCalledWith(
      {
        actorId: "actor-1",
        clientMessageId: "message-1",
        startedAt: claimStartedAt,
      },
      expect.objectContaining({ publishedAssertions: 2 }),
    );
    expect(lifecycleState.maintain).toHaveBeenCalledOnce();
  });

  it("can maintain Higher Memory without forcing a new Assertion capture", async () => {
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      higherMemory: { clientMessageId: "message-2" } as never,
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.capture).not.toHaveBeenCalled();
    expect(lifecycleState.maintain).toHaveBeenCalledOnce();
  });

  it("maintains Actor-private Higher Memory without publishing a shared Assertion", async () => {
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      actorHigherMemory: {
        actorId: "actor-1",
        clientMessageId: "message-private",
      } as never,
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.capture).not.toHaveBeenCalled();
    expect(lifecycleState.maintain).not.toHaveBeenCalled();
    expect(lifecycleState.maintainActor).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "actor-1" }),
      undefined,
    );
    expect(lifecycleState.order).toEqual(["actor-higher-memory:start"]);
  });

  it("does not recapture a foreground publication and consolidates verified knowledge", async () => {
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      completedAssertion: {
        input: {
          clientMessageId: "message-foreground",
          submittedAt: "2026-08-14T00:00:00.000Z",
          timezone: "Asia/Shanghai",
          semanticContext: {},
          retrieval: {},
        } as never,
        result: {
          publishedAssertions: 1,
          publishedAssertionIds: ["assertion-foreground"],
          affectedObjectIds: ["object-1"],
          affectedObjects: [{
            id: "object-1",
            canonicalName: "测试对象",
            resolution: "created",
          }],
        },
      },
      consolidation: {
        clientMessageId: "message-foreground",
        submittedAt: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {},
        retrieval: {},
      } as never,
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.capture).not.toHaveBeenCalled();
    expect(lifecycleState.consolidate).toHaveBeenCalledOnce();
    expect(lifecycleState.maintain).toHaveBeenCalledOnce();
    expect(lifecycleState.order).toEqual(["higher-memory:start"]);
  });

  it("consolidates only after publishing an Assertion", async () => {
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertionReceipt: { actorId: "actor-1", clientMessageId: "message-3" },
      consolidation: {
        clientMessageId: "message-3",
        submittedAt: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {},
        retrieval: {},
      } as never,
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.consolidate).toHaveBeenCalledOnce();
    expect(lifecycleState.maintain).toHaveBeenCalledWith(
      expect.objectContaining({
        queueDecision: expect.objectContaining({
          targets: [{ scope: "object", globalObjectId: "object-1" }],
        }),
      }),
      undefined,
    );
    expect(lifecycleState.order).toEqual([
      "assertion:start",
      "assertion:end",
      "higher-memory:start",
    ]);
  });

  it("replaces early model Object targets with graph-derived consolidation targets", async () => {
    lifecycleState.consolidate.mockResolvedValueOnce({
      objectUpdates: [{
        globalObjectId: "linked-object-a",
        canonicalName: "对象 A",
        focus: "该 Object 与新 Assertion 直接连接。",
      }, {
        globalObjectId: "linked-object-b",
        canonicalName: "对象 B",
        focus: "该 Object 与新 Assertion 直接连接。",
      }],
      ambientUpdates: [],
    });
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertionReceipt: { actorId: "actor-1", clientMessageId: "message-graph-scope" },
      consolidation: {
        clientMessageId: "message-graph-scope",
        submittedAt: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {},
        retrieval: {},
      } as never,
      higherMemory: {
        clientMessageId: "message-graph-scope",
        submittedAt: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {},
        retrieval: {},
        queueDecision: {
          targets: [
            { scope: "object", globalObjectId: "early-model-target" },
            { scope: "working_set" },
          ],
          reason: "主回答阶段的早期维护意图",
        },
      } as never,
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.maintain).toHaveBeenCalledWith(
      expect.objectContaining({
        queueDecision: expect.objectContaining({
          targets: [
            { scope: "working_set" },
            { scope: "object", globalObjectId: "linked-object-a" },
            { scope: "object", globalObjectId: "linked-object-b" },
          ],
        }),
      }),
      undefined,
    );
  });

  it("does not maintain Higher Memory when consolidation selects no target", async () => {
    lifecycleState.consolidate.mockResolvedValueOnce({
      objectUpdates: [],
      ambientUpdates: [],
    });
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertionReceipt: { actorId: "actor-1", clientMessageId: "message-4" },
      consolidation: {
        clientMessageId: "message-4",
        submittedAt: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {},
        retrieval: {},
      } as never,
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.consolidate).toHaveBeenCalledOnce();
    expect(lifecycleState.maintain).not.toHaveBeenCalled();
  });

  it("does not consolidate when the Assertion Agent publishes nothing", async () => {
    lifecycleState.capture.mockResolvedValueOnce({
      publishedAssertions: 0,
      publishedAssertionIds: [],
      affectedObjectIds: [],
      affectedObjects: [],
    });
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertionReceipt: { actorId: "actor-1", clientMessageId: "message-empty" },
      consolidation: { clientMessageId: "message-empty" } as never,
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.consolidate).not.toHaveBeenCalled();
    expect(lifecycleState.maintain).not.toHaveBeenCalled();
  });

  it("records a failed background Assertion attempt", async () => {
    lifecycleState.capture.mockRejectedValueOnce(new Error("capture failed"));
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertionReceipt: { actorId: "actor-1", clientMessageId: "message-failed" },
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.receiptFail).toHaveBeenCalledWith(
      {
        actorId: "actor-1",
        clientMessageId: "message-failed",
        startedAt: claimStartedAt,
      },
      expect.objectContaining({ message: "capture failed" }),
    );
    expect(lifecycleState.receiptComplete).not.toHaveBeenCalled();
  });

  it("resumes a bounded batch of persisted receipts on a later request", async () => {
    lifecycleState.recoverReceipts.mockResolvedValueOnce([{
      actorId: "actor-1",
      clientMessageId: "message-interrupted",
    }]);

    await expect(resumePendingChatAssertionReceipts({ actorId: "actor-1" }))
      .resolves.toBe(1);
    await lifecycleState.afterCallback?.();

    expect(lifecycleState.recoverReceipts).toHaveBeenCalledWith({ actorId: "actor-1" });
    expect(lifecycleState.receiptClaim).toHaveBeenCalledWith({
      actorId: "actor-1",
      clientMessageId: "message-interrupted",
    });
    expect(lifecycleState.capture).toHaveBeenCalledOnce();
  });
});
