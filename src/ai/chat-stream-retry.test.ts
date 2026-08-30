import { APICallError, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createModelCallAttemptTracker } from "@/ai/chat-stream-status";

const usage = {
  inputTokens: {
    total: 5,
    noCache: 5,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 2,
    text: 2,
    reasoning: undefined,
  },
};

function successfulStream(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: text },
        { type: "text-end" as const, id: "answer" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

describe("chat model request retries", () => {
  it("retries a retryable failure before streaming starts and records the attempt", async () => {
    const attempts = createModelCallAttemptTracker();
    let providerCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          throw new APICallError({
            message: "temporary upstream overload",
            url: "https://model.example/v1/chat/completions",
            requestBodyValues: {},
            statusCode: 503,
            responseHeaders: { "retry-after-ms": "0" },
            isRetryable: true,
          });
        }
        return successfulStream("完成");
      },
    });

    const result = streamText({
      model,
      prompt: "test",
      maxRetries: 1,
      onLanguageModelCallStart: () => {
        attempts.started();
      },
      onLanguageModelCallEnd: () => {
        attempts.ended();
      },
    });
    await result.consumeStream();

    expect(await result.text).toBe("完成");
    expect(providerCalls).toBe(2);
    expect(attempts.snapshot()).toEqual({ modelCallCount: 2, retryCount: 1 });
  });

  it("does not replay a request after its response stream has started", async () => {
    const attempts = createModelCallAttemptTracker();
    let providerCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        providerCalls += 1;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "answer" });
              controller.enqueue({ type: "text-delta", id: "answer", delta: "部分正文" });
              controller.error(new Error("connection reset"));
            },
          }),
        };
      },
    });

    const result = streamText({
      model,
      prompt: "test",
      maxRetries: 2,
      onLanguageModelCallStart: () => {
        attempts.started();
      },
      onLanguageModelCallEnd: () => {
        attempts.ended();
      },
    });
    await result.consumeStream();

    expect(providerCalls).toBe(1);
    expect(attempts.snapshot()).toEqual({ modelCallCount: 1, retryCount: 0 });
  });

  it("does not count normal post-tool model steps as retries", async () => {
    const attempts = createModelCallAttemptTracker();
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallId: "search-1",
                toolName: "search",
                input: JSON.stringify({ query: "Sydaris" }),
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: undefined },
                usage,
              },
            ],
          }),
        },
        successfulStream("最终回答"),
      ],
    });
    const result = streamText({
      model,
      prompt: "test",
      tools: {
        search: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => ({ query, found: true }),
        }),
      },
      stopWhen: stepCountIs(3),
      maxRetries: 2,
      onLanguageModelCallStart: () => {
        attempts.started();
      },
      onLanguageModelCallEnd: () => {
        attempts.ended();
      },
    });
    await result.consumeStream();

    expect(await result.text).toBe("最终回答");
    expect(model.doStreamCalls).toHaveLength(2);
    expect(attempts.snapshot()).toEqual({ modelCallCount: 2, retryCount: 0 });
  });
});
