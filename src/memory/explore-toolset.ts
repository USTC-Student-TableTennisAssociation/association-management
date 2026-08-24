import { tool } from "ai";
import { z } from "zod";

import { ToolResultTokenBudget } from "@/ai/tool-result-budget";
import { retrievalEvidenceSemantics } from "@/evidence/tool-semantics";
import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import {
  followObject as followMemoryObject,
  memoryExploreLimits,
  searchMemory as searchMemoryIndex,
  type MemoryExploreResult,
} from "@/memory/explore";
import type { EchoDebugTrace } from "@/ai/debug-trace";
import type { RetrievalCuratorContext } from "@/memory/retrieval-curator";
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
  preferHigherMemory?: boolean;
  allowKnownObjectIds?: Iterable<string>;
  curatorContext?: RetrievalCuratorContext;
  curatorTrace?: EchoDebugTrace;
  onLocateTrace?: (trace: MemorySearchTrace) => void;
  onEvidence?: (
    retrieval: MemoryRetrievalResult,
    discovered: MemoryExploreResult,
  ) => void;
}) {
  let toolCalls = 0;
  const additionalKnownObjectIds = new Set(input.allowKnownObjectIds ?? []);
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
    const question = discovered.query ?? discovered.focus ?? "当前 Shared Brain 检索问题";
    const described: MemoryExploreResult = {
      ...discovered,
      semantics: retrievalEvidenceSemantics({
        id: `shared_brain.${discovered.kind}.${toolCalls}`,
        layer: "shared_brain",
        scope: discovered.globalObjectId
          ? `GlobalObject:${discovered.globalObjectId}`
          : `query:${question}`,
        subject: question,
        question,
        coverage: discovered.coverage,
        refs: [
          ...(discovered.higherMemories ?? []).map((item) => item.ref),
          ...discovered.assertions.map((item) => item.ref),
        ],
        authority: "supporting",
        presentSummary: "本次聚焦 Shared Brain 检索返回了可用证据。",
        absentSummary:
          "本次聚焦 Shared Brain 检索没有返回足以回答的证据；这不等于其他知识层或现实中不存在该信息。",
        unknownSummary: "本次 Shared Brain 检索没有形成完整的证据覆盖判断。",
      }),
    };
    input.onEvidence?.(input.evidence.snapshot(), described);
    return described;
  }

  return {
    searchMemory: tool({
      description:
        "在 Echo 的 GlobalObject–Assertion 记忆中执行一次聚焦 Locate。" +
        "把要找的实体原话放进 targetHints，把围绕该实体想了解的信息放进 query；不要把两者润色成一段。" +
        "必须按任务形状选择 taskShape：单一明确事实使用 fact；完整理解、名单/表格、多字段 View 填充或资料梳理使用 synthesis。" +
        "synthesis 遇到无 Higher Memory 的唯一目标时会自动补充 Object 关联证据与来源入口；即使 Assertion coverage 已完整，宽综合仍应读取高价值原文的目录与相关章节。" +
        "当回答需要当前环境中的 Object、历史、时间、状态、规则或来源等事实时使用；" +
        "问候、闲聊、改写、翻译和不依赖组织资料的任务不应调用。" +
        "获得证据后，如问题仍包含未覆盖的子问题，可以换一种聚焦表述再次检索。" +
        "结果中只有 GlobalObject identity、Assertion 与最小 provenance；" +
        "只有 kind=grounded 的 Assertion 是事实证据，kind=reference 只是需要回读来源的导航索引。",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(memoryExploreLimits.queryChars)
          .describe("围绕目标 Object 想了解的信息需求；不要重复堆叠目标名称"),
        targetHints: z.array(z.string().trim().min(1).max(200)).min(1).max(8)
          .optional()
          .describe("主对话应提供：用户所指目标实体的名称、别名或忠实原话；不要扩写成相关文档或概念"),
        targetObjectIds: z.array(z.string().trim().min(1).max(200)).max(3)
          .optional()
          .describe("可选：本轮先前工具结果已确认的目标 GlobalObject database id"),
        taskShape: z.enum(["fact", "synthesis"])
          .describe("fact=单一事实；synthesis=完整理解、名单/表格、资料梳理或多字段 View 填充"),
      }),
      execute: async ({ query, targetHints, targetObjectIds, taskShape }) => {
        // searchMemory is the discovery primitive. Do not require the request-
        // local accumulator to have observed an explicit id first: parallel
        // tool calls can otherwise race even though the id belongs to the
        // current Compilation. The database-backed target resolver validates it.
        reserveCall();
        return merge(await searchMemoryIndex({
          query,
          targetHints: targetHints ?? [],
          targetObjectIds,
          taskShape,
        }, {
          signal: input.signal,
          preferHigherMemory: input.preferHigherMemory,
          curatorContext: input.curatorContext,
          curatorTrace: input.curatorTrace,
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
        if (!input.evidence.hasObject(globalObjectId) && !additionalKnownObjectIds.has(globalObjectId)) {
          throw new UnknownExploreObjectError(globalObjectId);
        }
        reserveCall();
        return merge(
          await followMemoryObject(globalObjectId, focus, {
            signal: input.signal,
            curatorContext: input.curatorContext,
            curatorTrace: input.curatorTrace,
          }),
        );
      },
    }),
  };
}

export const memoryExploreToolLimits = {
  callsPerAnswer: MAX_TOOL_CALLS_PER_ANSWER,
} as const;
