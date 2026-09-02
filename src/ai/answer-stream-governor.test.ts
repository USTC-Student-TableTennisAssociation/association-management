import type { UIMessageChunk } from "ai";
import { describe, expect, it, vi } from "vitest";

import { governFinalAnswerStream } from "@/ai/answer-stream-governor";

function streamOf(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<UIMessageChunk>) {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
}

const answerChunks: UIMessageChunk[] = [
  { type: "start-step" },
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: "原始回答" },
  { type: "text-end", id: "answer" },
  { type: "finish-step" },
  { type: "finish", finishReason: "stop" },
];

describe("Answer Stream Governor", () => {
  it("passes direct and Evidence Envelope text deltas through", async () => {
    const onDirectStream = vi.fn();
    const chunks = await collect(governFinalAnswerStream(
      streamOf(answerChunks),
      () => "不应使用",
      () => false,
      onDirectStream,
    ));

    expect(chunks).toContainEqual({
      type: "text-delta",
      id: "answer",
      delta: "原始回答",
    });
    expect(onDirectStream).toHaveBeenCalled();
  });

  it("buffers Claim Frame text and emits the verified replacement", async () => {
    const chunks = await collect(governFinalAnswerStream(
      streamOf(answerChunks),
      () => "校验后回答",
      () => true,
      vi.fn(),
    ));

    expect(chunks).not.toContainEqual(expect.objectContaining({ id: "answer" }));
    expect(chunks).toContainEqual({
      type: "text-delta",
      id: "grounded-final-answer",
      delta: "校验后回答",
    });
  });
});
