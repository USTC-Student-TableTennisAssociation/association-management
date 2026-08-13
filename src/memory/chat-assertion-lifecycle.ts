import { after } from "next/server";

import {
  captureChatAssertions,
  type ChatAssertionCaptureInput,
} from "@/memory/chat-assertion";
import type { EchoDebugTrace } from "@/ai/debug-trace";

export type ChatAssertionCaptureScheduler = {
  publish(input: ChatAssertionCaptureInput): void;
  cancel(reason?: string): void;
};

export function createChatAssertionCaptureScheduler(
  trace?: EchoDebugTrace,
): ChatAssertionCaptureScheduler {
  let resolveInput: (input: ChatAssertionCaptureInput | undefined) => void = () => undefined;
  let published = false;
  const inputReady = new Promise<ChatAssertionCaptureInput | undefined>((resolve) => {
    resolveInput = resolve;
  });
  try {
    after(async () => {
      const input = await inputReady;
      if (!input) {
        await trace?.flush();
        return;
      }
      try {
        await trace?.appendSection(
          "后台 Chat → Assertion 开始",
          "主回答已经结束。以下处理在后台执行，不影响本轮回答是否成功。",
        );
        const count = await captureChatAssertions(input, trace);
        console.info("[chat.assertion-capture]", JSON.stringify({
          clientMessageId: input.clientMessageId,
          publishedAssertions: count,
        }));
      } catch (error) {
        console.error("[chat.assertion-capture]", error);
        await trace?.appendError("后台 Chat → Assertion 失败", error);
      } finally {
        await trace?.flush();
      }
    });
  } catch (error) {
    // Unit tests and non-Next callers do not have an after() request scope.
    // Capturing is best-effort and must never interrupt the normal answer.
    console.warn("[chat.assertion-capture.schedule]", error);
  }
  return {
    publish(input) {
      if (published) return;
      published = true;
      resolveInput(input);
    },
    cancel(reason = "主回答未正常完成，因此没有启动后台 Assertion 提取。") {
      if (published) return;
      published = true;
      void trace?.appendSection("Assertion 入口判断", reason);
      resolveInput(undefined);
    },
  };
}
