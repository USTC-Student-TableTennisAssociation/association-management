import { after } from "next/server";

import type { EchoDebugTrace } from "@/ai/debug-trace";
import {
  captureChatAssertions,
  type ChatAssertionCaptureInput,
} from "@/memory/chat-assertion";
import {
  findExistingHigherMemoryObjectIds,
  maintainObjectHigherMemories,
  type ObjectHigherMemoryMaintenanceInput,
} from "@/memory/object-higher-memory";

export type ChatMemoryMaintenanceInput = {
  assertion?: ChatAssertionCaptureInput;
  higherMemory?: ObjectHigherMemoryMaintenanceInput;
};

export type ChatMemoryMaintenanceScheduler = {
  publish(input: ChatMemoryMaintenanceInput): void;
  cancel(reason?: string): void;
};

/**
 * One post-answer pipeline owns both stages. The fixed order prevents Higher
 * Memory from observing a half-finished Chat Assertion publication.
 */
export function createChatMemoryMaintenanceScheduler(
  trace?: EchoDebugTrace,
): ChatMemoryMaintenanceScheduler {
  let resolveInput: (input: ChatMemoryMaintenanceInput | undefined) => void = () => undefined;
  let published = false;
  const inputReady = new Promise<ChatMemoryMaintenanceInput | undefined>((resolve) => {
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
          "后台对话记忆线路开始",
          [
            "主回答已经结束。以下处理在后台执行，不影响本轮回答是否成功。",
            "固定顺序：Chat → Assertion 完整结束后，才允许 Higher Memory 开始维护。",
          ].join("\n"),
        );
        let captureResult = { publishedAssertions: 0, affectedObjectIds: [] as string[] };
        if (input.assertion) {
          try {
            await trace?.appendSection(
              "后台 Chat → Assertion 开始",
              "主回答模型已登记 Assertion 提取意图。",
            );
            captureResult = await captureChatAssertions(input.assertion, trace);
            console.info("[chat.assertion-capture]", JSON.stringify({
              clientMessageId: input.assertion.clientMessageId,
              ...captureResult,
            }));
          } catch (error) {
            console.error("[chat.assertion-capture]", error);
            await trace?.appendError("后台 Chat → Assertion 失败", error);
          }
        } else {
          await trace?.appendSection(
            "后台 Chat → Assertion 跳过",
            "主回答模型没有登记 Assertion 提取；Higher Memory 如有维护意图，仍可基于数据库中已有 Assertion 继续。",
          );
        }

        let higherMemoryInput = input.higherMemory;
        if (input.assertion && captureResult.publishedAssertions > 0) {
          try {
            const compilationId = input.assertion.retrieval.compilationId ??
              input.assertion.retrieval.trace?.snapshot.id;
            const automaticallyAffected = await findExistingHigherMemoryObjectIds({
              objectIds: captureResult.affectedObjectIds,
              compilationId,
            });
            if (automaticallyAffected.length) {
              const explicitIds = higherMemoryInput?.queueDecision.objectIds ?? [];
              const objectIds = [...new Set([...explicitIds, ...automaticallyAffected])].slice(0, 6);
              const automaticReason = "本轮新发布 Assertion 涉及已有 Higher Memory，自动刷新以避免旧高层认知遮住新事实。";
              higherMemoryInput = {
                clientMessageId: higherMemoryInput?.clientMessageId ?? input.assertion.clientMessageId,
                submittedAt: higherMemoryInput?.submittedAt ?? input.assertion.submittedAt,
                timezone: higherMemoryInput?.timezone ?? input.assertion.timezone,
                semanticContext: higherMemoryInput?.semanticContext ?? input.assertion.semanticContext,
                retrieval: higherMemoryInput?.retrieval ?? input.assertion.retrieval,
                queueDecision: {
                  objectIds,
                  reason: higherMemoryInput
                    ? `${higherMemoryInput.queueDecision.reason}；${automaticReason}`
                    : automaticReason,
                },
              };
              await trace?.appendSection(
                "Higher Memory 自动补偿触发",
                [
                  `新发布的 ${captureResult.publishedAssertions} 条 Assertion 关联了已有 Higher Memory。`,
                  `自动加入维护的 Object：${automaticallyAffected.map((id) => `\`${id}\``).join("、")}`,
                  "这里只刷新已经存在的 Higher Memory，不会因此为普通 Object 新建 Higher Memory。",
                ].join("\n"),
              );
            }
          } catch (error) {
            console.error("[chat.higher-memory.auto-trigger]", error);
            await trace?.appendError("Higher Memory 自动补偿判断失败", error);
          }
        }

        if (higherMemoryInput) {
          try {
            await trace?.appendSection(
              "后台 Higher Memory 开始",
              `Assertion 阶段已经完整结束，本轮新发布 ${captureResult.publishedAssertions} 条 Assertion。现在开始维护 Higher Memory。`,
            );
            const maintainedObjects = await maintainObjectHigherMemories(
              higherMemoryInput,
              trace,
            );
            console.info("[chat.higher-memory]", JSON.stringify({
              clientMessageId: higherMemoryInput.clientMessageId,
              maintainedObjects,
            }));
          } catch (error) {
            console.error("[chat.higher-memory]", error);
            await trace?.appendError("后台 Higher Memory 失败", error);
          }
        } else {
          await trace?.appendSection(
            "后台 Higher Memory 跳过",
            "主回答模型没有登记重要 Object 的 Higher Memory 维护意图，本轮也没有新 Assertion 需要刷新已有 Higher Memory。",
          );
        }
      } finally {
        await trace?.flush();
      }
    });
  } catch (error) {
    // Unit tests and non-Next callers do not have an after() request scope.
    // Maintenance is best-effort and must never interrupt the normal answer.
    console.warn("[chat.memory-maintenance.schedule]", error);
  }
  return {
    publish(input) {
      if (published) return;
      published = true;
      resolveInput(input);
    },
    cancel(reason = "主回答未正常完成，因此没有启动后台对话记忆线路。") {
      if (published) return;
      published = true;
      void trace?.appendSection("后台对话记忆线路取消", reason);
      resolveInput(undefined);
    },
  };
}

/** Backward-compatible name for tests/callers that still only publish Assertions. */
export const createChatAssertionCaptureScheduler = createChatMemoryMaintenanceScheduler;
