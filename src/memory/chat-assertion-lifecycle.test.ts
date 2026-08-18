import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleState = vi.hoisted(() => ({
  afterCallback: undefined as (() => Promise<void>) | undefined,
  capture: vi.fn(),
  maintain: vi.fn(),
  findExisting: vi.fn(),
  receiptRunning: vi.fn(),
  receiptComplete: vi.fn(),
  receiptFail: vi.fn(),
  loadJob: vi.fn(),
  consolidate: vi.fn(),
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
  loadChatAssertionWritebackJob: lifecycleState.loadJob,
  markChatAssertionReceiptRunning: lifecycleState.receiptRunning,
  completeChatAssertionReceipt: lifecycleState.receiptComplete,
  failChatAssertionReceipt: lifecycleState.receiptFail,
}));
vi.mock("@/memory/object-higher-memory", () => ({
  findExistingHigherMemoryObjectIds: lifecycleState.findExisting,
}));
vi.mock("@/memory/higher-memory-maintenance", () => ({
  maintainHigherMemories: lifecycleState.maintain,
}));
vi.mock("@/memory/knowledge-consolidator", () => ({
  consolidateTurnKnowledge: lifecycleState.consolidate,
}));

import { createChatMemoryMaintenanceScheduler } from "@/memory/chat-assertion-lifecycle";

beforeEach(() => {
  vi.clearAllMocks();
  lifecycleState.afterCallback = undefined;
  lifecycleState.order = [];
  lifecycleState.capture.mockImplementation(async () => {
    lifecycleState.order.push("assertion:start");
    await Promise.resolve();
    lifecycleState.order.push("assertion:end");
    return {
      publishedAssertions: 2,
      publishedAssertionIds: ["assertion-1", "assertion-2"],
      affectedObjectIds: ["object-1"],
      higherMemoryObjectIds: [],
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
  lifecycleState.findExisting.mockResolvedValue([]);
  lifecycleState.consolidate.mockResolvedValue({
    objectUpdates: [{
      globalObjectId: "object-1",
      canonicalName: "测试对象",
      updateAreas: ["current_state"],
      focus: "已发布的新 Assertion 改变了当前状态。",
    }],
    ambientUpdates: [],
  });
  lifecycleState.loadJob.mockResolvedValue({
    clientMessageId: "message-durable",
    submittedAt: "2026-08-14T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    semanticContext: {},
    retrieval: { compilationId: "compilation-1" },
    queueDecision: { reason: "durable job" },
  });
});

describe("post-answer memory maintenance pipeline", () => {
  it("loads a persisted job by key before starting background capture", async () => {
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertionJob: { actorId: "actor-1", clientMessageId: "message-durable" },
      assertionReceipt: { actorId: "actor-1", clientMessageId: "message-durable" },
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.loadJob).toHaveBeenCalledWith({
      actorId: "actor-1",
      clientMessageId: "message-durable",
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
      assertion: { clientMessageId: "message-1" } as never,
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
    expect(lifecycleState.receiptRunning).toHaveBeenCalledWith({
      actorId: "actor-1",
      clientMessageId: "message-1",
    });
    expect(lifecycleState.receiptComplete).toHaveBeenCalledWith(
      { actorId: "actor-1", clientMessageId: "message-1" },
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

  it("does not recapture a foreground publication and consolidates verified knowledge", async () => {
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      completedAssertion: {
        input: {
          clientMessageId: "message-foreground",
          submittedAt: "2026-08-14T00:00:00.000Z",
          timezone: "Asia/Shanghai",
          semanticContext: {},
          retrieval: { compilationId: "compilation-1" },
        } as never,
        result: {
          publishedAssertions: 1,
          publishedAssertionIds: ["assertion-foreground"],
          affectedObjectIds: ["object-1"],
          higherMemoryObjectIds: ["object-1"],
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
        retrieval: { compilationId: "compilation-1" },
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
      assertion: {
        clientMessageId: "message-3",
        submittedAt: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {},
        retrieval: { compilationId: "compilation-1" },
      } as never,
      consolidation: {
        clientMessageId: "message-3",
        submittedAt: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {},
        retrieval: { compilationId: "compilation-1" },
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

  it("does not maintain Higher Memory when consolidation selects no target", async () => {
    lifecycleState.consolidate.mockResolvedValueOnce({
      objectUpdates: [],
      ambientUpdates: [],
    });
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertion: {
        clientMessageId: "message-4",
        retrieval: { compilationId: "compilation-1" },
      } as never,
      consolidation: {
        clientMessageId: "message-4",
        submittedAt: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {},
        retrieval: { compilationId: "compilation-1" },
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
      higherMemoryObjectIds: [],
      affectedObjects: [],
    });
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertion: { clientMessageId: "message-empty" } as never,
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
      assertion: { clientMessageId: "message-failed" } as never,
      assertionReceipt: { actorId: "actor-1", clientMessageId: "message-failed" },
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.receiptFail).toHaveBeenCalledWith(
      { actorId: "actor-1", clientMessageId: "message-failed" },
      expect.objectContaining({ message: "capture failed" }),
    );
    expect(lifecycleState.receiptComplete).not.toHaveBeenCalled();
  });
});
