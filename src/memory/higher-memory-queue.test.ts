import { describe, expect, it, vi } from "vitest";

import type { DebugTrace } from "@/ai/debug-trace";
import {
  addObjectTargetsToQueueDecision,
  ambientScopesFromQueueDecision,
  createHigherMemoryQueueTool,
  objectHigherMemoryQueueDecision,
} from "@/memory/higher-memory-queue";

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

describe("queueHigherMemoryMaintenance", () => {
  it("queues ambient and known Object targets once with stable deduplication", async () => {
    const trace = mockTrace();
    const knownId = "00000000-0000-4000-8000-000000000001";
    const toolset = createHigherMemoryQueueTool({
      trace,
      hasObject: (id) => id === knownId,
    });

    await expect(toolset.tool.execute!({
      targets: [
        { scope: "identity" },
        { scope: "working_set" },
        { scope: "working_set" },
        { scope: "object", globalObjectId: knownId },
        { scope: "object", globalObjectId: knownId },
      ],
      reason: "本轮同时形成了环境、近期焦点和重要对象理解",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({ queued: true }));

    const decision = toolset.decision();
    expect(decision).toEqual({
      targets: [
        { scope: "identity" },
        { scope: "working_set" },
        { scope: "object", globalObjectId: knownId },
      ],
      reason: "本轮同时形成了环境、近期焦点和重要对象理解",
    });
    expect(ambientScopesFromQueueDecision(decision)).toEqual(["identity", "working_set"]);
    expect(objectHigherMemoryQueueDecision(decision)).toEqual({
      objectIds: [knownId],
      reason: "本轮同时形成了环境、近期焦点和重要对象理解",
    });
    expect(trace.appendSection).toHaveBeenCalledWith(
      "Higher Memory 入口判断",
      expect.stringContaining("完整语义上下文"),
    );
  });

  it("can queue ambient scopes before any GlobalObject has been inspected", async () => {
    const toolset = createHigherMemoryQueueTool({ hasObject: () => false });
    await expect(toolset.tool.execute!({
      targets: [{ scope: "identity" }, { scope: "working_set" }],
      reason: "首次实质性对话形成了环境理解",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({ queued: true }));
  });

  it("rejects Ambient intent when the runtime has not observed authoritative evidence", async () => {
    const toolset = createHigherMemoryQueueTool({
      hasObject: () => false,
      canQueueAmbient: () => false,
    });
    await expect(toolset.tool.execute!({
      targets: [{ scope: "identity" }],
      reason: "模型仅凭问候猜测当前环境",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({
      queued: false,
      message: expect.stringContaining("尚未读取足以支持 Ambient Higher Memory"),
    }));
    expect(toolset.decision()).toBeUndefined();
  });

  it("rejects an Object that the main dialogue has not actually inspected", async () => {
    const toolset = createHigherMemoryQueueTool({ hasObject: () => false });
    await expect(toolset.tool.execute!({
      targets: [{
        scope: "object",
        globalObjectId: "00000000-0000-4000-8000-000000000002",
      }],
      reason: "模型猜测它可能重要",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({ queued: false }));
    expect(toolset.decision()).toBeUndefined();
  });

  it("preserves proactive Ambient intent when a cold Object target is added", () => {
    expect(addObjectTargetsToQueueDecision({
      decision: {
        targets: [{ scope: "identity" }, { scope: "working_set" }],
        reason: "本轮读取正式 View 后形成了共享环境理解",
      },
      objectIds: ["00000000-0000-4000-8000-000000000003"],
      reason: "唯一目标 Object 尚无 Higher Memory",
    })).toEqual({
      targets: [
        { scope: "identity" },
        { scope: "working_set" },
        { scope: "object", globalObjectId: "00000000-0000-4000-8000-000000000003" },
      ],
      reason: "本轮读取正式 View 后形成了共享环境理解；唯一目标 Object 尚无 Higher Memory",
    });
  });
});
