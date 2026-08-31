import { describe, expect, it } from "vitest";

import {
  classifyChatStreamFailureCode,
  classifyChatStreamStatus,
  summarizeChatStreamError,
} from "@/ai/chat-stream-status";

describe("chat stream errors", () => {
  it("uses one classification rule for raw and summarized errors", () => {
    const error = Object.assign(new Error("model call timed out"), {
      name: "TimeoutError",
      statusCode: 504,
    });
    const summary = summarizeChatStreamError(error);

    expect(summary).toEqual({
      name: "TimeoutError",
      message: "model call timed out",
      statusCode: 504,
    });
    expect(classifyChatStreamFailureCode(error)).toBe("timeout");
    expect(classifyChatStreamFailureCode(summary)).toBe("timeout");
  });
});

describe("classifyChatStreamStatus", () => {
  it("treats an audited final answer as completed", () => {
    expect(classifyChatStreamStatus({
      streamEnded: true,
      finishReason: "stop",
      reasoningChars: 120,
      contentChars: 42,
      toolCallCount: 3,
      modelCallCount: 1,
      retryCount: 0,
    })).toMatchObject({
      status: "completed",
      completionKind: "answer",
      partial: false,
    });
  });

  it("treats a final answer as completed after a recoverable tool error", () => {
    expect(classifyChatStreamStatus({
      streamEnded: true,
      finishReason: "stop",
      reasoningChars: 120,
      contentChars: 42,
      toolCallCount: 3,
      modelCallCount: 1,
      retryCount: 0,
      error: {
        name: "SourceDocumentReadError",
        message: "selection was not a heading",
      },
    })).toEqual({
      status: "completed",
      completionKind: "answer",
      finishReason: "stop",
      reasoningChars: 120,
      contentChars: 42,
      toolCallCount: 3,
      modelCallCount: 1,
      retryCount: 0,
      partial: false,
    });
  });

  it("does not call a tool-only turn a completed answer", () => {
    expect(classifyChatStreamStatus({
      streamEnded: true,
      finishReason: "tool-calls",
      reasoningChars: 120,
      contentChars: 0,
      toolCallCount: 1,
      modelCallCount: 1,
      retryCount: 0,
    })).toMatchObject({
      status: "incomplete",
      completionKind: "tool_call",
      partial: false,
    });
  });

  it("accepts a complete answer whose only terminal tool is metadata", () => {
    expect(classifyChatStreamStatus({
      streamEnded: true,
      finishReason: "tool-calls",
      reasoningChars: 0,
      contentChars: 996,
      toolCallCount: 6,
      modelCallCount: 4,
      retryCount: 0,
      terminalMetadataOnlyToolCalls: true,
    })).toMatchObject({
      status: "completed",
      completionKind: "answer",
      finishReason: "tool-calls",
      partial: false,
    });
  });

  it("keeps an answer with unfinished substantive tool calls incomplete", () => {
    expect(classifyChatStreamStatus({
      streamEnded: true,
      finishReason: "tool-calls",
      reasoningChars: 0,
      contentChars: 996,
      toolCallCount: 6,
      modelCallCount: 4,
      retryCount: 0,
      terminalMetadataOnlyToolCalls: false,
    })).toMatchObject({
      status: "incomplete",
      completionKind: "answer",
      partial: true,
    });
  });

  it("does not call an empty stop a completed answer", () => {
    expect(classifyChatStreamStatus({
      streamEnded: true,
      finishReason: "stop",
      reasoningChars: 2400,
      contentChars: 0,
      toolCallCount: 0,
      modelCallCount: 1,
      retryCount: 0,
    })).toMatchObject({
      status: "incomplete",
      completionKind: "empty",
      partial: false,
    });
  });

  it("marks a length-limited answer as incomplete", () => {
    expect(classifyChatStreamStatus({
      streamEnded: true,
      finishReason: "length",
      reasoningChars: 1200,
      contentChars: 18,
      toolCallCount: 0,
      modelCallCount: 1,
      retryCount: 0,
    })).toMatchObject({
      status: "incomplete",
      completionKind: "answer",
      partial: true,
    });
  });

  it("preserves the partial observation when the stream fails", () => {
    expect(classifyChatStreamStatus({
      streamEnded: false,
      reasoningChars: 1200,
      contentChars: 18,
      toolCallCount: 0,
      modelCallCount: 1,
      retryCount: 0,
      error: { name: "TimeoutError", message: "model call timed out" },
    })).toMatchObject({
      status: "failed",
      completionKind: "error",
      reasoningChars: 1200,
      contentChars: 18,
      partial: true,
      failureCode: "timeout",
      error: { name: "TimeoutError" },
    });
  });

  it("distinguishes aborted and upstream failures", () => {
    expect(classifyChatStreamStatus({
      streamEnded: false,
      reasoningChars: 12,
      contentChars: 0,
      toolCallCount: 0,
      modelCallCount: 1,
      retryCount: 0,
      failureCode: "stream_aborted",
    })).toMatchObject({
      status: "failed",
      failureCode: "stream_aborted",
    });
    expect(classifyChatStreamStatus({
      streamEnded: false,
      reasoningChars: 0,
      contentChars: 0,
      toolCallCount: 0,
      modelCallCount: 3,
      retryCount: 2,
      error: { name: "AI_RetryError", message: "upstream returned 503" },
    })).toMatchObject({
      status: "failed",
      failureCode: "upstream_error",
      retryCount: 2,
    });
  });
});
