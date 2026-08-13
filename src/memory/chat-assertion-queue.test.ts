import { describe, expect, it, vi } from "vitest";

import type { EchoDebugTrace } from "@/ai/debug-trace";
import { createChatAssertionQueueTool } from "@/memory/chat-assertion-queue";

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

describe("queueChatAssertionCapture", () => {
  it("queues only a reason and leaves evidence/context selection to the background agent", async () => {
    const trace = mockTrace();
    const toolset = createChatAssertionQueueTool({ trace });

    await expect(toolset.tool.execute!({
      reason: "用户陈述了新的活动安排",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({
      queued: true,
      alreadyQueued: false,
    }));

    expect(toolset.decision()).toEqual({ reason: "用户陈述了新的活动安排" });
    expect(trace.appendSection).toHaveBeenCalledWith(
      "Assertion 入口判断",
      expect.stringContaining("完整语义转录"),
    );
  });

  it("is idempotent within one main answer", async () => {
    const toolset = createChatAssertionQueueTool({});
    await toolset.tool.execute!({ reason: "第一次" }, executionOptions);
    await expect(toolset.tool.execute!({ reason: "第二次" }, executionOptions))
      .resolves.toEqual(expect.objectContaining({ alreadyQueued: true }));
    expect(toolset.decision()).toEqual({ reason: "第一次" });
  });
});
