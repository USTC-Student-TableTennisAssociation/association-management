import { describe, expect, it } from "vitest";

import {
  evaluateAgentRunGuard,
  incompleteRunInstruction,
} from "@/ai/agent-run-guard";

describe("evaluateAgentRunGuard", () => {
  it("allows long runs below the emergency ceiling", () => {
    expect(evaluateAgentRunGuard({
      stepNumber: 63,
      toolCalls: Array.from({ length: 40 }, (_, index) => ({
        toolName: "readSourceDocument",
        input: { cursor: index },
      })),
      emergencyStepLimit: 64,
      repeatedToolCallLimit: 3,
    })).toEqual({ interrupted: false });
  });

  it("interrupts an exact repeated tool call as no progress", () => {
    expect(evaluateAgentRunGuard({
      stepNumber: 5,
      toolCalls: [
        { toolName: "searchMemory", input: { query: "same", shape: "fact" } },
        { toolName: "readView", input: { viewKey: "one" } },
        { toolName: "searchMemory", input: { shape: "fact", query: "same" } },
        { toolName: "searchMemory", input: { query: "same", shape: "fact" } },
      ],
      emergencyStepLimit: 64,
      repeatedToolCallLimit: 3,
    })).toMatchObject({
      interrupted: true,
      reason: "no_progress",
    });
  });

  it("does not treat pagination or different targets as repetition", () => {
    expect(evaluateAgentRunGuard({
      stepNumber: 8,
      toolCalls: [
        { toolName: "readSourceDocument", input: { cursor: "page-1" } },
        { toolName: "readSourceDocument", input: { cursor: "page-2" } },
        { toolName: "readSourceDocument", input: { cursor: "page-3" } },
      ],
      emergencyStepLimit: 64,
      repeatedToolCallLimit: 3,
    })).toEqual({ interrupted: false });
  });

  it("interrupts only when the high emergency ceiling is reached", () => {
    expect(evaluateAgentRunGuard({
      stepNumber: 64,
      toolCalls: [],
      emergencyStepLimit: 64,
      repeatedToolCallLimit: 3,
    })).toEqual({
      interrupted: true,
      reason: "emergency_step_limit",
      detail: "模型运行已达到 64 个 step 的异常安全上限",
    });
  });
});

describe("incompleteRunInstruction", () => {
  it("requires an explicit incomplete handoff", () => {
    const instruction = incompleteRunInstruction({
      reason: "no_progress",
      detail: "没有形成新进展",
    });

    expect(instruction).toContain("本轮未完成");
    expect(instruction).toContain("尚未完成");
    expect(instruction).toContain("不得");
  });
});
