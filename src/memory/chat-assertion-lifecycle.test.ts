import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleState = vi.hoisted(() => ({
  afterCallback: undefined as (() => Promise<void>) | undefined,
  capture: vi.fn(),
  maintain: vi.fn(),
  findExisting: vi.fn(),
  receiptRunning: vi.fn(),
  receiptComplete: vi.fn(),
  receiptFail: vi.fn(),
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
  markChatAssertionReceiptRunning: lifecycleState.receiptRunning,
  completeChatAssertionReceipt: lifecycleState.receiptComplete,
  failChatAssertionReceipt: lifecycleState.receiptFail,
}));
vi.mock("@/memory/object-higher-memory", () => ({
  findExistingHigherMemoryObjectIds: lifecycleState.findExisting,
  maintainObjectHigherMemories: lifecycleState.maintain,
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
      affectedObjects: [{
        id: "object-1",
        canonicalName: "测试对象",
        resolution: "existing",
      }],
    };
  });
  lifecycleState.maintain.mockImplementation(async () => {
    lifecycleState.order.push("higher-memory:start");
    return 1;
  });
  lifecycleState.findExisting.mockResolvedValue([]);
});

describe("post-answer memory maintenance pipeline", () => {
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

  it("does not recapture a foreground publication and still refreshes existing Higher Memory", async () => {
    lifecycleState.findExisting.mockResolvedValue(["object-1"]);
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
          affectedObjects: [{
            id: "object-1",
            canonicalName: "测试对象",
            resolution: "created",
          }],
        },
      },
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.capture).not.toHaveBeenCalled();
    expect(lifecycleState.findExisting).toHaveBeenCalledWith({
      objectIds: ["object-1"],
      compilationId: "compilation-1",
    });
    expect(lifecycleState.maintain).toHaveBeenCalledOnce();
    expect(lifecycleState.order).toEqual(["higher-memory:start"]);
  });

  it("automatically refreshes an existing Higher Memory after publishing an Assertion", async () => {
    lifecycleState.findExisting.mockResolvedValue(["object-1"]);
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({
      assertion: {
        clientMessageId: "message-3",
        submittedAt: "2026-08-14T00:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {},
        retrieval: { compilationId: "compilation-1" },
      } as never,
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.findExisting).toHaveBeenCalledWith({
      objectIds: ["object-1"],
      compilationId: "compilation-1",
    });
    expect(lifecycleState.maintain).toHaveBeenCalledWith(
      expect.objectContaining({
        queueDecision: expect.objectContaining({ objectIds: ["object-1"] }),
      }),
      undefined,
    );
    expect(lifecycleState.order).toEqual([
      "assertion:start",
      "assertion:end",
      "higher-memory:start",
    ]);
  });

  it("does not create Higher Memory for an affected Object that has none", async () => {
    const scheduler = createChatMemoryMaintenanceScheduler();
    scheduler.publish({ assertion: {
      clientMessageId: "message-4",
      retrieval: { compilationId: "compilation-1" },
    } as never });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.findExisting).toHaveBeenCalledOnce();
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
