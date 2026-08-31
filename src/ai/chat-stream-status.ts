import { z } from "zod";

export const chatStreamStatusSchema = z.object({
  status: z.enum(["completed", "incomplete", "failed"]),
  completionKind: z.enum(["answer", "tool_call", "empty", "error"]),
  failureCode: z.enum([
    "stream_aborted",
    "timeout",
    "upstream_error",
    "unknown_error",
  ]).optional(),
  finishReason: z.string().optional(),
  reasoningChars: z.number().int().nonnegative(),
  contentChars: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  modelCallCount: z.number().int().nonnegative().default(0),
  retryCount: z.number().int().nonnegative().default(0),
  partial: z.boolean(),
  error: z.object({
    name: z.string(),
    message: z.string(),
    statusCode: z.number().int().optional(),
  }).optional(),
});

export type ChatStreamStatus = z.infer<typeof chatStreamStatusSchema>;

export type ChatStreamObservation = {
  finishReason?: string;
  reasoningChars: number;
  contentChars: number;
  toolCallCount: number;
  modelCallCount: number;
  retryCount: number;
  streamEnded: boolean;
  terminalMetadataOnlyToolCalls?: boolean;
  failureCode?: ChatStreamStatus["failureCode"];
  error?: ChatStreamStatus["error"];
};

export function summarizeChatStreamError(
  error: unknown,
): NonNullable<ChatStreamStatus["error"]> {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
  const rawMessage = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : "Unknown stream error";
  return {
    name: error instanceof Error
      ? error.name
      : typeof record?.name === "string"
        ? record.name
        : "UnknownError",
    message: rawMessage.replace(/\s+/g, " ").slice(0, 1_000),
    ...(typeof record?.statusCode === "number"
      ? { statusCode: record.statusCode }
      : {}),
  };
}

export function classifyChatStreamFailureCode(
  error: unknown,
): NonNullable<ChatStreamStatus["failureCode"]> {
  const summary = summarizeChatStreamError(error);
  const name = summary.name.toLowerCase();
  const message = summary.message.toLowerCase();
  if (name.includes("abort") || message.includes("aborted") || message.includes("abort")) {
    return "stream_aborted";
  }
  if (name.includes("timeout") || message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  return "upstream_error";
}

export function createModelCallAttemptTracker() {
  let modelCallCount = 0;
  let retryCount = 0;
  let pending = false;

  return {
    started() {
      modelCallCount += 1;
      if (pending) retryCount += 1;
      pending = true;
      return { modelCallCount, retryCount };
    },
    ended() {
      pending = false;
    },
    snapshot() {
      return { modelCallCount, retryCount };
    },
  };
}

function failureCodeFor(
  observation: ChatStreamObservation,
): ChatStreamStatus["failureCode"] {
  if (observation.failureCode) return observation.failureCode;
  return observation.error
    ? classifyChatStreamFailureCode(observation.error)
    : "unknown_error";
}

export function classifyChatStreamStatus(
  observation: ChatStreamObservation,
): ChatStreamStatus {
  const hasContent = observation.contentChars > 0;
  const completionKind = hasContent
    ? "answer" as const
    : observation.toolCallCount > 0
      ? "tool_call" as const
      : "empty" as const;

  // A tool can fail recoverably during a multi-step response. The final model
  // completion is authoritative when it still produces a complete answer.
  if (
    observation.streamEnded &&
    hasContent &&
    (
      observation.finishReason === "stop" ||
      (
        observation.finishReason === "tool-calls" &&
        observation.terminalMetadataOnlyToolCalls === true
      )
    )
  ) {
    return {
      status: "completed",
      completionKind,
      finishReason: observation.finishReason,
      reasoningChars: observation.reasoningChars,
      contentChars: observation.contentChars,
      toolCallCount: observation.toolCallCount,
      modelCallCount: observation.modelCallCount,
      retryCount: observation.retryCount,
      partial: false,
    };
  }

  if (observation.error || !observation.streamEnded) {
    return {
      status: "failed",
      completionKind: "error",
      finishReason: observation.finishReason,
      reasoningChars: observation.reasoningChars,
      contentChars: observation.contentChars,
      toolCallCount: observation.toolCallCount,
      modelCallCount: observation.modelCallCount,
      retryCount: observation.retryCount,
      partial: true,
      failureCode: failureCodeFor(observation),
      ...(observation.error ? { error: observation.error } : {}),
    };
  }

  return {
    status: "incomplete",
    completionKind,
    finishReason: observation.finishReason,
    reasoningChars: observation.reasoningChars,
    contentChars: observation.contentChars,
    toolCallCount: observation.toolCallCount,
    modelCallCount: observation.modelCallCount,
    retryCount: observation.retryCount,
    partial: hasContent,
  };
}
