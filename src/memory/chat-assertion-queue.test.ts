import { describe, expect, it, vi } from "vitest";

import type { DebugTrace } from "@/ai/debug-trace";
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
  } satisfies DebugTrace;
}

describe("queueChatAssertionCapture", () => {
  it("queues only a reason and leaves evidence/context selection to the background agent", async () => {
    const trace = mockTrace();
    const onQueued = vi.fn().mockResolvedValue(undefined);
    const toolset = createChatAssertionQueueTool({ trace, onQueued });

    await expect(toolset.tool.execute!({
      reason: "用户陈述了新的活动安排",
      execution: "background",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({
      queued: true,
      alreadyQueued: false,
    }));

    expect(toolset.decision()).toEqual({ reason: "用户陈述了新的活动安排" });
    expect(onQueued).toHaveBeenCalledWith(
      { reason: "用户陈述了新的活动安排" },
      "background",
    );
    expect(trace.appendSection).toHaveBeenCalledWith(
      "Assertion 入口判断",
      expect.stringContaining("完整语义转录"),
    );
  });

  it("is idempotent within one main answer", async () => {
    const toolset = createChatAssertionQueueTool({});
    await toolset.tool.execute!({ reason: "第一次", execution: "background" }, executionOptions);
    await expect(toolset.tool.execute!({
      reason: "第二次",
      execution: "background",
    }, executionOptions))
      .resolves.toEqual(expect.objectContaining({ alreadyQueued: true }));
    expect(toolset.decision()).toEqual({ reason: "第一次" });
  });

  it("can finish Object/Assertion publication before a same-turn View Proposal", async () => {
    const captureForeground = vi.fn().mockResolvedValue({
      publishedAssertions: 1,
      publishedAssertionIds: ["00000000-0000-4000-8000-000000000051"],
      affectedObjectIds: ["00000000-0000-4000-8000-000000000052"],
      affectedObjects: [{
        id: "00000000-0000-4000-8000-000000000052",
        canonicalName: "雷岳鑫",
        resolution: "created" as const,
      }],
    });
    const onForegroundResult = vi.fn();
    const toolset = createChatAssertionQueueTool({
      captureForeground,
      onForegroundResult,
    });

    await expect(toolset.foregroundTool.execute!({
      reason: "用户要求把新会长收录进正式档案",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({
      queued: false,
      completed: true,
      publishedAssertions: 1,
      objects: [expect.objectContaining({ canonicalName: "雷岳鑫" })],
    }));

    expect(captureForeground).toHaveBeenCalledWith({
      reason: "用户要求把新会长收录进正式档案",
    });
    expect(onForegroundResult).toHaveBeenCalledWith(await captureForeground.mock.results[0].value);
    expect(toolset.decision()).toBeUndefined();
    expect(toolset.foregroundDecision()).toEqual({
      reason: "用户要求把新会长收录进正式档案",
    });
    expect(toolset.foregroundResult()?.affectedObjects[0].canonicalName).toBe("雷岳鑫");
  });

  it("does not invalidate Objects discovered earlier when no new chat fact is published", async () => {
    const toolset = createChatAssertionQueueTool({
      captureForeground: vi.fn().mockResolvedValue({
        publishedAssertions: 0,
        publishedAssertionIds: [],
        affectedObjectIds: [],
        affectedObjects: [],
      }),
    });

    await expect(toolset.foregroundTool.execute!({
      reason: "尝试发布缺失实体",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({
      completed: true,
      message: expect.stringContaining("先前检索到的 O#"),
    }));
  });
});
