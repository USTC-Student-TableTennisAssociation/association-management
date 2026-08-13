import { tool } from "ai";
import { z } from "zod";

import { ToolResultTokenBudget } from "@/ai/tool-result-budget";
import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import {
  followObject as followMemoryObject,
  memoryExploreLimits,
  searchMemory as searchMemoryIndex,
  type MemoryExploreResult,
} from "@/memory/explore";
import type { MemoryRetrievalResult, MemorySearchTrace } from "@/memory/types";

const MAX_TOOL_CALLS_PER_ANSWER = 6;

export class MemoryExploreBudgetError extends Error {
  constructor() {
    super(`本轮最多执行 ${MAX_TOOL_CALLS_PER_ANSWER} 次记忆检索工具`);
    this.name = "MemoryExploreBudgetError";
  }
}

export class UnknownExploreObjectError extends Error {
  constructor(globalObjectId: string) {
    super(
      `GlobalObject ${globalObjectId} 尚未出现在本轮检索工具结果中，` +
        "请先使用 searchMemory 定位对象",
    );
    this.name = "UnknownExploreObjectError";
  }
}

export class MemoryExploreContextBudgetError extends Error {
  constructor(maximumTokens: number) {
    super(
      `本轮记忆探索结果已达 ${maximumTokens} tokens 上下文预算，` +
        "请基于已有 Assertion 完成回答",
    );
    this.name = "MemoryExploreContextBudgetError";
  }
}

export function createMemoryExploreToolset(input: {
  evidence: MemoryEvidenceAccumulator;
  resultTokenBudget: number;
  sharedResultBudget?: ToolResultTokenBudget;
  signal?: AbortSignal;
  onLocateTrace?: (trace: MemorySearchTrace) => void;
  onEvidence?: (
    retrieval: MemoryRetrievalResult,
    discovered: MemoryExploreResult,
  ) => void;
}) {
  let toolCalls = 0;
  const resultBudget = input.sharedResultBudget ??
    new ToolResultTokenBudget(input.resultTokenBudget);

  function reserveCall(): void {
    toolCalls += 1;
    if (toolCalls > MAX_TOOL_CALLS_PER_ANSWER) {
      throw new MemoryExploreBudgetError();
    }
  }

  function merge(result: MemoryExploreResult): MemoryExploreResult {
    if (!resultBudget.reserve(result)) {
      throw new MemoryExploreContextBudgetError(input.resultTokenBudget);
    }
    const discovered = input.evidence.merge(result);
    input.onEvidence?.(input.evidence.snapshot(), discovered);
    return discovered;
  }

  return {
    searchMemory: tool({
      description:
        "在 Echo 的 GlobalObject–Assertion 记忆中执行一次聚焦 Locate。" +
        "当回答需要 Echo 的协会、人物、活动、历史、时间、状态、制度或来源等组织事实时使用；" +
        "问候、闲聊、改写、翻译和不依赖组织资料的任务不应调用。" +
        "获得证据后，如问题仍包含未覆盖的子问题，可以换一种聚焦表述再次检索。" +
        "结果中只有 GlobalObject identity、Assertion 与最小 provenance；" +
        "只有 kind=grounded 的 Assertion 是事实证据，kind=reference 只是需要回读来源的导航索引。",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(memoryExploreLimits.queryChars)
          .describe("独立、聚焦的记忆检索问题"),
      }),
      execute: async ({ query }) => {
        reserveCall();
        return merge(await searchMemoryIndex(query, {
          signal: input.signal,
          onLocate: (retrieval) => {
            if (retrieval.trace) input.onLocateTrace?.(retrieval.trace);
          },
        }));
      },
    }),

    followObject: tool({
      description:
        "沿一个已知 GlobalObject 的 anchored 或 semantic Assertion 连接继续查找，" +
        "并返回这些 Assertion 所连接的 GlobalObject。" +
        "globalObjectId 必须原样取自本轮初始 Context 或之前工具结果。" +
        "focus 只用于排序，不会创造或扩张事实。",
      inputSchema: z.object({
        globalObjectId: z.string().trim().min(1).max(200)
          .describe("已在本轮证据中出现的 GlobalObject database id"),
        focus: z.string().trim().min(1).max(memoryExploreLimits.focusChars)
          .optional()
          .describe("可选的关系或子问题焦点"),
      }),
      execute: async ({ globalObjectId, focus }) => {
        reserveCall();
        if (!input.evidence.hasObject(globalObjectId)) {
          throw new UnknownExploreObjectError(globalObjectId);
        }
        return merge(
          await followMemoryObject(globalObjectId, focus, {
            signal: input.signal,
          }),
        );
      },
    }),
  };
}

export const memoryExploreToolLimits = {
  callsPerAnswer: MAX_TOOL_CALLS_PER_ANSWER,
} as const;
