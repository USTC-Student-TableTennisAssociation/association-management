import {
  stepCountIs,
  streamText,
  simulateReadableStream,
  tool,
  ToolLoopAgent,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 5,
    text: 5,
    reasoning: undefined,
  },
};

function finish(unified: "stop" | "tool-calls") {
  return {
    type: "finish" as const,
    finishReason: { unified, raw: undefined },
    usage,
  };
}

function toolCallStep(
  calls: Array<{ toolCallId: string; toolName: string; input: string }>,
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...calls.map((call) => ({ type: "tool-call" as const, ...call })),
        finish("tool-calls"),
      ],
    }),
  };
}

function textStep(id: string, text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id },
        { type: "text-delta" as const, id, delta: text },
        { type: "text-end" as const, id },
        finish("stop"),
      ],
    }),
  };
}

describe("AI SDK 7 tool-loop compatibility", () => {
  it("streams tool result -> next tool call -> final text across multiple steps", async () => {
    const executions: string[] = [];
    const tools = {
      locate: tool({
        description: "Locate a global object.",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          executions.push(`locate:${query}`);
          return { globalObjectKey: "global:activity" };
        },
      }),
      inspectAssertion: tool({
        description: "Inspect an assertion connected to an object.",
        inputSchema: z.object({ globalObjectKey: z.string() }),
        execute: async ({ globalObjectKey }) => {
          executions.push(`inspect:${globalObjectKey}`);
          return { assertion: "这是一项活动 [A1]" };
        },
      }),
    };
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep([
          {
            toolCallId: "call-locate",
            toolName: "locate",
            input: JSON.stringify({ query: "继往开来" }),
          },
        ]),
        toolCallStep([
          {
            toolCallId: "call-inspect",
            toolName: "inspectAssertion",
            input: JSON.stringify({ globalObjectKey: "global:activity" }),
          },
        ]),
        textStep("answer", "继往开来是一项活动 [A1]。"),
      ],
    });

    const result = streamText({
      model,
      tools,
      prompt: "继往开来是什么活动？",
      stopWhen: stepCountIs(4),
    });
    await result.consumeStream();

    expect(await result.text).toBe("继往开来是一项活动 [A1]。");
    expect(executions).toEqual([
      "locate:继往开来",
      "inspect:global:activity",
    ]);
    expect(model.doStreamCalls).toHaveLength(3);

    const steps = await result.steps;
    expect(steps.map((step) => step.finishReason)).toEqual([
      "tool-calls",
      "tool-calls",
      "stop",
    ]);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
      "global:activity",
    );
    expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain(
      "这是一项活动 [A1]",
    );
  });

  it("executes multiple tool calls from one model step concurrently", async () => {
    const started: string[] = [];
    const completed: string[] = [];
    let startedBeforeRelease = -1;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const fallback = setTimeout(() => {
      startedBeforeRelease = started.length;
      releaseGate();
    }, 250);

    const tools = {
      parallelProbe: tool({
        inputSchema: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          started.push(id);
          if (started.length === 2) {
            startedBeforeRelease = started.length;
            clearTimeout(fallback);
            releaseGate();
          }
          await gate;
          completed.push(id);
          return { id, status: "ok" };
        },
      }),
    };
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep([
          {
            toolCallId: "call-left",
            toolName: "parallelProbe",
            input: JSON.stringify({ id: "left" }),
          },
          {
            toolCallId: "call-right",
            toolName: "parallelProbe",
            input: JSON.stringify({ id: "right" }),
          },
        ]),
        textStep("parallel-answer", "both complete"),
      ],
    });

    const result = streamText({
      model,
      tools,
      prompt: "run both probes",
      stopWhen: stepCountIs(2),
    });
    await result.consumeStream();

    expect(startedBeforeRelease).toBe(2);
    expect(started).toEqual(["left", "right"]);
    expect(new Set(completed)).toEqual(new Set(["left", "right"]));
    expect(await result.text).toBe("both complete");
    const secondPrompt = JSON.stringify(model.doStreamCalls[1].prompt);
    expect(secondPrompt).toContain("left");
    expect(secondPrompt).toContain("right");
  });

  it("documents that streamText defaults to one step even when a tool ran", async () => {
    const executions: string[] = [];
    const tools = {
      lookup: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          executions.push(query);
          return { found: true };
        },
      }),
    };
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep([
          {
            toolCallId: "call-default-stop",
            toolName: "lookup",
            input: JSON.stringify({ query: "Echo" }),
          },
        ]),
        textStep("unreachable-answer", "this step must not run"),
      ],
    });

    const result = streamText({ model, tools, prompt: "lookup Echo" });
    await result.consumeStream();

    expect(executions).toEqual(["Echo"]);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(await result.text).toBe("");
    expect(await result.finishReason).toBe("tool-calls");
    expect(await result.steps).toHaveLength(1);
  });

  it("can reserve the last bounded step for a forced text answer", async () => {
    const tools = {
      lookup: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ query, found: true }),
      }),
    };
    const preparedSteps: number[] = [];
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep([
          {
            toolCallId: "call-forced-answer",
            toolName: "lookup",
            input: JSON.stringify({ query: "Echo" }),
          },
        ]),
        textStep("forced-answer", "Echo was found."),
      ],
    });

    const result = streamText({
      model,
      tools,
      prompt: "lookup Echo and answer",
      stopWhen: stepCountIs(2),
      prepareStep: ({ stepNumber }) => {
        preparedSteps.push(stepNumber);
        return { toolChoice: stepNumber === 1 ? "none" : "required" };
      },
    });
    await result.consumeStream();

    expect(preparedSteps).toEqual([0, 1]);
    expect(model.doStreamCalls[0].toolChoice).toEqual({ type: "required" });
    expect(model.doStreamCalls[1].toolChoice).toEqual({ type: "none" });
    expect(await result.text).toBe("Echo was found.");
    expect(await result.steps).toHaveLength(2);
  });

  it("ToolLoopAgent continues after a tool call by default", async () => {
    const tools = {
      lookup: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ query, found: true }),
      }),
    };
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep([
          {
            toolCallId: "call-agent",
            toolName: "lookup",
            input: JSON.stringify({ query: "Echo" }),
          },
        ]),
        textStep("agent-answer", "Agent completed."),
      ],
    });
    const agent = new ToolLoopAgent({ model, tools });

    const result = await agent.stream({ prompt: "lookup Echo" });
    await result.consumeStream();

    expect(model.doStreamCalls).toHaveLength(2);
    expect(await result.text).toBe("Agent completed.");
    expect(await result.steps).toHaveLength(2);
  });
});
