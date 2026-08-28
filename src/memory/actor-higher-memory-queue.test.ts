import { describe, expect, it } from "vitest";

import {
  addActorHigherMemoryScopes,
  createActorHigherMemoryQueueTool,
} from "@/memory/actor-higher-memory-queue";

const executionOptions = {
  toolCallId: "tool-call-actor-hm",
  messages: [],
  abortSignal: undefined,
  context: {},
};

describe("Actor Higher Memory queue", () => {
  it("deduplicates private scopes and queues only once", async () => {
    const toolset = createActorHigherMemoryQueueTool({});
    await expect(toolset.tool.execute!({
      scopes: ["interaction", "working_set", "interaction"],
      reason: "用户明确了跨会话称呼和需要继续的私人工作",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({ queued: true }));
    expect(toolset.decision()).toEqual({
      scopes: ["interaction", "working_set"],
      reason: "用户明确了跨会话称呼和需要继续的私人工作",
    });
  });

  it("can merge additional natural-language maintenance scopes", () => {
    expect(addActorHigherMemoryScopes({
      decision: {
        scopes: ["working_style"],
        reason: "形成了稳定工作习惯",
      },
      scopes: ["interaction"],
      reason: "精确偏好发生变化",
    })).toEqual({
      scopes: ["working_style", "interaction"],
      reason: "形成了稳定工作习惯；精确偏好发生变化",
    });
  });
});
