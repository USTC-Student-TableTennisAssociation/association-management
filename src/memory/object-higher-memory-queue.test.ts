import { describe, expect, it, vi } from "vitest";

import type { EchoDebugTrace } from "@/ai/debug-trace";
import { createObjectHigherMemoryQueueTool } from "@/memory/object-higher-memory-queue";

const executionOptions = {
  toolCallId: "tool-call-1",
  messages: [],
  abortSignal: undefined,
  context: {},
};

function mockTrace() {
  return {
    enabled: true,
    appendSection: vi.fn().mockResolvedValue(undefined),
    appendJsonSection: vi.fn().mockResolvedValue(undefined),
    appendError: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  } satisfies EchoDebugTrace;
}

describe("queueHigherMemoryMaintenance", () => {
  it("queues only known important Object ids and a reason", async () => {
    const trace = mockTrace();
    const knownId = "00000000-0000-4000-8000-000000000001";
    const toolset = createObjectHigherMemoryQueueTool({
      trace,
      hasObject: (id) => id === knownId,
    });

    await expect(toolset.tool.execute!({
      objectIds: [knownId, knownId],
      reason: "本轮实质讨论了该社团的当前状态",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({ queued: true }));

    expect(toolset.decision()).toEqual({
      objectIds: [knownId],
      reason: "本轮实质讨论了该社团的当前状态",
    });
    expect(trace.appendSection).toHaveBeenCalledWith(
      "Higher Memory 入口判断",
      expect.stringContaining("完整语义上下文"),
    );
  });

  it("rejects an Object that the main dialogue has not actually inspected", async () => {
    const toolset = createObjectHigherMemoryQueueTool({ hasObject: () => false });
    await expect(toolset.tool.execute!({
      objectIds: ["00000000-0000-4000-8000-000000000002"],
      reason: "模型猜测它可能重要",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({ queued: false }));
    expect(toolset.decision()).toBeUndefined();
  });
});
