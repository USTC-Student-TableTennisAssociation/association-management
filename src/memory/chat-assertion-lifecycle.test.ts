import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleState = vi.hoisted(() => ({
  afterCallback: undefined as (() => Promise<void>) | undefined,
  capture: vi.fn(),
  maintain: vi.fn(),
  findExisting: vi.fn(),
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
    return { publishedAssertions: 2, affectedObjectIds: ["object-1"] };
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
      higherMemory: { clientMessageId: "message-1" } as never,
    });

    await lifecycleState.afterCallback?.();

    expect(lifecycleState.order).toEqual([
      "assertion:start",
      "assertion:end",
      "higher-memory:start",
    ]);
    expect(lifecycleState.capture).toHaveBeenCalledOnce();
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
});
