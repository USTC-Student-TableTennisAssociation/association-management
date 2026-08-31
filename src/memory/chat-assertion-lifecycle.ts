import { after } from "next/server";

import type { DebugTrace } from "@/ai/debug-trace";
import {
  captureChatAssertions,
  type ChatAssertionCaptureInput,
  type ChatAssertionCaptureResult,
} from "@/memory/chat-assertion";
import {
  claimChatAssertionReceipt,
  completeChatAssertionReceipt,
  failChatAssertionReceipt,
  loadChatAssertionReceiptInput,
  recoverPendingChatAssertionReceipts,
  type ChatAssertionReceiptClaim,
  type ChatAssertionReceiptKey,
} from "@/memory/chat-assertion-receipt";
import {
  consolidateTurnKnowledge,
  type KnowledgeConsolidationInput,
} from "@/memory/knowledge-consolidator";
import {
  maintainHigherMemories,
  type HigherMemoryMaintenanceInput,
} from "@/memory/higher-memory-maintenance";
import {
  maintainActorHigherMemories,
  type ActorHigherMemoryMaintenanceInput,
} from "@/memory/actor-higher-memory";

export type ChatMemoryMaintenanceInput = {
  assertionReceipt?: ChatAssertionReceiptKey;
  completedAssertion?: {
    input: ChatAssertionCaptureInput;
    result: ChatAssertionCaptureResult;
  };
  consolidation?: KnowledgeConsolidationInput;
  higherMemory?: HigherMemoryMaintenanceInput;
  actorHigherMemory?: ActorHigherMemoryMaintenanceInput;
};

export type ChatMemoryMaintenanceScheduler = {
  publish(input: ChatMemoryMaintenanceInput): void;
  cancel(reason?: string): void;
};

function emptyCaptureResult(): ChatAssertionCaptureResult {
  return {
    publishedAssertions: 0,
    publishedAssertionIds: [],
    affectedObjectIds: [],
    affectedObjects: [],
  };
}

async function processQueuedChatAssertionReceipt(
  key: ChatAssertionReceiptKey,
  trace?: DebugTrace,
): Promise<ChatAssertionCaptureResult> {
  let claim: ChatAssertionReceiptClaim | undefined;
  try {
    claim = await claimChatAssertionReceipt(key);
  } catch (error) {
    console.error("[chat.assertion-receipt.claim]", error);
    await trace?.appendError("领取持久化 Assertion 回执失败", error);
    return emptyCaptureResult();
  }
  if (!claim) {
    await trace?.appendSection(
      "后台 Chat → Assertion 跳过",
      "该回执已由另一个处理者领取，当前进程不重复执行。",
    );
    return emptyCaptureResult();
  }

  try {
    const assertionInput = await loadChatAssertionReceiptInput(claim);
    await trace?.appendSection(
      "后台 Chat → Assertion 任务恢复",
      "已从持久化回执加载完整语义上下文与检索快照。",
    );
    await trace?.appendSection(
      "后台 Chat → Assertion 开始",
      "主回答已结束，现在独立判断用户原话是否值得固化。",
    );
    const result = await captureChatAssertions(assertionInput, trace);
    console.info("[chat.assertion-capture]", JSON.stringify({
      clientMessageId: assertionInput.clientMessageId,
      ...result,
    }));
    try {
      await completeChatAssertionReceipt(claim, result);
    } catch (error) {
      // The capture itself is idempotent. Leave this claim running so a later
      // request can requeue it and reconstruct the receipt from persisted data.
      console.error("[chat.assertion-receipt.complete]", error);
      await trace?.appendError("Assertion 回执写入处理结果失败", error);
    }
    return result;
  } catch (error) {
    console.error("[chat.assertion-capture]", error);
    await trace?.appendError("后台 Chat → Assertion 失败", error);
    try {
      await failChatAssertionReceipt(claim, error);
    } catch (receiptError) {
      console.error("[chat.assertion-receipt.failed]", receiptError);
      await trace?.appendError("Assertion 回执写入失败状态失败", receiptError);
    }
    return emptyCaptureResult();
  }
}

/** Resume interrupted Assertion publication when the actor next uses Chat. */
export async function resumePendingChatAssertionReceipts(input: {
  actorId: string;
}): Promise<number> {
  try {
    const receipts = await recoverPendingChatAssertionReceipts(input);
    if (!receipts.length) return 0;
    after(async () => {
      for (const receipt of receipts) {
        await processQueuedChatAssertionReceipt(receipt);
      }
    });
    return receipts.length;
  } catch (error) {
    console.warn("[chat.assertion-receipt.resume]", error);
    return 0;
  }
}

/**
 * One post-answer pipeline owns assertion publication, semantic consolidation,
 * and Higher Memory maintenance in that order.
 */
export function createChatMemoryMaintenanceScheduler(
  trace?: DebugTrace,
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
            "固定顺序：Assertion 发布 → Knowledge Consolidation → Object/Ambient Higher Memory → Actor 私有 Higher Memory。View Higher Memory 由正式 View 的 post-commit 事件链维护。",
          ].join("\n"),
        );
        let captureResult: ChatAssertionCaptureResult = input.completedAssertion?.result ??
          emptyCaptureResult();
        if (input.completedAssertion) {
          await trace?.appendSection(
            "后台 Chat → Assertion 跳过",
            [
              "本轮 Assertion/Object 已在正式 View Proposal 前完成发布，不重复提取。",
              `- 已发布 Assertion：${captureResult.publishedAssertions} 条`,
              `- 关联 Object：${captureResult.affectedObjectIds.length} 个`,
            ].join("\n"),
          );
        } else if (input.assertionReceipt) {
          captureResult = await processQueuedChatAssertionReceipt(
            input.assertionReceipt,
            trace,
          );
        } else {
          await trace?.appendSection(
            "后台 Chat → Assertion 跳过",
            "本轮没有可执行的回答后 Assertion 任务；Higher Memory 如有维护意图，仍可基于数据库中已有 Assertion 继续。",
          );
        }

        let higherMemoryInput = input.higherMemory;
        const consolidationInput = input.consolidation;
        if (consolidationInput && captureResult.publishedAssertions > 0) {
          try {
            const consolidation = await consolidateTurnKnowledge(
              consolidationInput,
              captureResult,
              trace,
            );
            const selectedTargets = [
              ...consolidation.objectUpdates.map((update) => ({
                scope: "object" as const,
                globalObjectId: update.globalObjectId,
              })),
              ...consolidation.ambientUpdates.map((update) => ({ scope: update.scope })),
            ];
            // The main answer can register early intent. Once Assertions have
            // been published, replace early Object choices with targets derived
            // from their actual Object–Assertion graph; ambient intent remains.
            const existingTargets = (higherMemoryInput?.queueDecision.targets ?? [])
              .filter((target) =>
                target.scope !== "object" || captureResult.publishedAssertions === 0
              );
            const uniqueTargets = [...existingTargets, ...selectedTargets].filter(
              (target, index, all) => {
                const key = target.scope === "object"
                  ? `object:${target.globalObjectId}`
                  : target.scope;
                return all.findIndex((candidate) =>
                  (candidate.scope === "object"
                    ? `object:${candidate.globalObjectId}`
                    : candidate.scope) === key
                ) === index;
              },
            );
            if (uniqueTargets.length) {
              const focus = [
                ...consolidation.objectUpdates.map((update) =>
                  `${update.canonicalName}：${update.focus}`
                ),
                ...consolidation.ambientUpdates.map((update) =>
                  `${update.scope}：${update.focus}`
                ),
              ].join("；");
              higherMemoryInput = {
                clientMessageId: higherMemoryInput?.clientMessageId ?? consolidationInput.clientMessageId,
                submittedAt: higherMemoryInput?.submittedAt ?? consolidationInput.submittedAt,
                timezone: higherMemoryInput?.timezone ?? consolidationInput.timezone,
                semanticContext: higherMemoryInput?.semanticContext ?? consolidationInput.semanticContext,
                retrieval: higherMemoryInput?.retrieval ?? consolidationInput.retrieval,
                queueDecision: {
                  targets: uniqueTargets,
                  reason: [higherMemoryInput?.queueDecision.reason, focus]
                    .filter(Boolean).join("；"),
                },
              };
            } else {
              higherMemoryInput = undefined;
            }
          } catch (error) {
            console.error("[chat.knowledge-consolidation]", error);
            await trace?.appendError("Knowledge Consolidator 失败", error);
          }
        } else if (consolidationInput) {
          await trace?.appendSection(
            "Knowledge Consolidator 跳过",
            "Assertion Agent 没有发布经过验证的新 Assertion；不使用普通检索过程或 Assistant 结论维护 Higher Memory。",
          );
        }

        if (higherMemoryInput) {
          try {
            await trace?.appendSection(
              "后台 Higher Memory 开始",
              `Assertion 阶段已经完整结束，本轮新发布 ${captureResult.publishedAssertions} 条 Assertion。现在开始维护 Higher Memory。`,
            );
            const maintained = await maintainHigherMemories(
              higherMemoryInput,
              trace,
            );
            console.info("[chat.higher-memory]", JSON.stringify({
              clientMessageId: higherMemoryInput.clientMessageId,
              ...maintained,
            }));
          } catch (error) {
            console.error("[chat.higher-memory]", error);
            await trace?.appendError("后台 Higher Memory 失败", error);
          }
        } else {
          await trace?.appendSection(
            "后台 Higher Memory 跳过",
            "Knowledge Consolidator 没有选择需要维护的 Object、identity、narrative 或 working_set。",
          );
        }

        if (input.actorHigherMemory) {
          try {
            const maintained = await maintainActorHigherMemories(
              input.actorHigherMemory,
              trace,
            );
            console.info("[chat.actor-higher-memory]", JSON.stringify({
              actorId: input.actorHigherMemory.actorId,
              clientMessageId: input.actorHigherMemory.clientMessageId,
              maintained,
            }));
          } catch (error) {
            console.error("[chat.actor-higher-memory]", error);
            await trace?.appendError("后台 Actor Higher Memory 失败", error);
          }
        } else {
          await trace?.appendSection(
            "Actor Higher Memory 跳过",
            "本轮没有新的持久私人协作上下文，也没有精确偏好变更需要综合。",
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
