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
import type { MemoryRetrievalResult, MemorySearchTrace } from "@/memory/types";

const MAX_TOOL_CALLS_PER_ANSWER = 6;

export class MemoryExploreBudgetError extends Error {
  constructor() {
    super(`本轮最多执行 ${MAX_TOOL_CALLS_PER_ANSWER} 次记忆检索工具`);
    this.name = "MemoryExploreBudgetError";
  }
}

export class UnknownExploreObjectError extends Error {
  constructor(objectRef: string) {
    super(
      `GlobalObject 引用 ${objectRef} 尚未出现在本轮检索工具结果中，` +
        "请先使用 searchMemory 定位对象",
    );
    this.name = "UnknownExploreObjectError";
  }
}

function presentSource(source: MemoryExploreResult["assertions"][number]["sources"][number]) {
  if (source.kind === "chat") {
    return {
      kind: "chat" as const,
      actorDisplayName: source.actorDisplayName,
      submittedAt: source.submittedAt,
      timezone: source.timezone,
      ordinal: source.ordinal,
    };
  }
  return {
    kind: "document" as const,
    sourceTitle: source.sourceTitle,
    sourceRegionLabel: source.sourceRegionLabel,
    ordinal: source.ordinal,
    pages: [...source.pages],
  };
}

/** Keep storage identities inside the Runtime; the main model works with O#/A#/H#. */
function presentExploreResult(
  result: MemoryExploreResult,
  evidence: MemoryEvidenceAccumulator,
) {
  const {
    globalObjectId,
    knowledgeState,
    objects,
    higherMemories,
    assertions,
    connections,
    counts: _counts,
    sourceTime,
    ...rest
  } = result;
  void _counts;
  const objectRefsByAssertionRef = new Map<string, string[]>();
  for (const connection of connections) {
    const refs = objectRefsByAssertionRef.get(connection.assertionRef) ?? [];
    refs.push(connection.objectRef);
    objectRefsByAssertionRef.set(connection.assertionRef, refs);
  }
  const presentAssertion = (assertion: MemoryExploreResult["assertions"][number]) => ({
    ref: assertion.ref,
    renderedStatement: assertion.renderedStatement,
    contextDependent: assertion.contextDependent,
    objectRefs: objectRefsByAssertionRef.get(assertion.ref) ?? [],
    sources: assertion.sources.map(presentSource),
  });
  const facts = assertions.filter((assertion) => assertion.kind === "grounded");
  const references = assertions.filter((assertion) => assertion.kind === "reference");
  return {
    ...rest,
    ...(globalObjectId
      ? { globalObjectRef: evidence.objectRefForId(globalObjectId) }
      : {}),
    ...(knowledgeState
      ? {
          knowledgeState: {
            targetObjectRef: evidence.objectRefForId(knowledgeState.targetObjectId),
            higherMemory: knowledgeState.higherMemory,
            coldBootstrapApplied: knowledgeState.coldBootstrapApplied,
          },
        }
      : {}),
    ...(sourceTime
      ? {
          sourceTime: {
            sourceTitle: sourceTime.sourceTitle,
            text: sourceTime.text,
            supportingPages: [...new Set(sourceTime.supportingBlocks.flatMap((block) => block.pages))],
          },
        }
      : {}),
    objects: objects.map((object) => ({
      ref: object.ref,
      canonicalName: object.canonicalName,
      surfaceForms: [...object.surfaceForms],
      lexicalMatch: object.lexicalMatch,
      semanticMatch: object.semanticMatch,
    })),
    ...(higherMemories?.length
      ? {
          higherMemories: higherMemories.map((memory) => ({
            ref: memory.ref,
            objectRef: evidence.objectRefForId(memory.globalObjectId),
            contentMarkdown: memory.contentMarkdown,
            operationalIndex: {
              aspects: memory.operationalIndex.aspects.map((aspect) => ({
                key: aspect.key,
                label: aspect.label,
                summary: aspect.summary,
                coverage: aspect.coverage,
                sourceTitles: [...aspect.sourceTitles],
                recommendedQueries: [...aspect.recommendedQueries],
                unresolvedAspects: [...aspect.unresolvedAspects],
              })),
            },
            maintainedAt: memory.maintainedAt,
          })),
        }
      : {}),
    facts: facts.map(presentAssertion),
    references: references.map((assertion) => ({
      ...presentAssertion(assertion),
      dereferenceRequired: true as const,
    })),
    counts: {
      objects: objects.length,
      facts: facts.length,
      references: references.length,
    },
  };
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
  /** Internal fact agents may need storage identities for structured persistence. */
  exposeDatabaseIds?: boolean;
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

  function merge(result: MemoryExploreResult) {
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
          ? `GlobalObject:${input.exposeDatabaseIds
            ? discovered.globalObjectId
            : input.evidence.objectRefForId(discovered.globalObjectId) ?? "unresolved"}`
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
    return input.exposeDatabaseIds
      ? described
      : presentExploreResult(described, input.evidence);
  }

  return {
    searchMemory: tool({
      description:
        "在 Sydaris 的 GlobalObject–Assertion 记忆中执行一次聚焦 Locate。" +
        "把唯一主体实体的原话放进 targetHints，把成员、子项、活动、平台等想了解的相关实体和信息放进 query；不要把相关实体并列成主目标。" +
        "必须按任务形状选择 taskShape：单一明确事实使用 fact；完整理解、名单/表格、多字段 View 填充或资料梳理使用 synthesis。" +
        "一次 query 只表达一个内聚的信息需求；多字段 synthesis 对未覆盖字段分别窄查。partial/truncated、‘等’或一个完整章节都不代表完整集合已穷尽。" +
        "模型发起查询后，目标 Object 的 Operational Memory Index 与 Object 关系会参与候选召回，但不会自动读取原文。" +
        "宽综合应根据未覆盖方面选择必要的高价值原文目录与章节，不预设固定阅读数量。" +
        "当回答需要当前环境中的 Object、历史、时间、状态、规则或来源等事实时使用；" +
        "问候、闲聊、改写、翻译和不依赖组织资料的任务不应调用。" +
        "获得证据后，如问题仍包含未覆盖的子问题，可以换一种聚焦表述再次检索。" +
        "结果把 facts 与 references 分开：facts 是可用事实证据；references 只是原文导航，需要时应使用 readSourceDocument 回读。",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(memoryExploreLimits.queryChars)
          .describe("围绕目标 Object 想了解的信息需求；不要重复堆叠目标名称"),
        targetHints: z.array(z.string().trim().min(1).max(200)).min(1).max(8)
          .optional()
          .describe("同一个主体 Object 的名称、别名或忠实原话，主名称放第一个；不要放入其成员、子项、活动或平台"),
        targetObjectRefs: z.array(z.string().trim().regex(/^O\d+$/)).max(3)
          .optional()
          .describe("可选：本轮先前工具结果已确认的目标 O#；数据库 ID 由 Runtime 自动解析"),
        taskShape: z.enum(["fact", "synthesis"])
          .describe("fact=单一事实；synthesis=完整理解、名单/表格、资料梳理或多字段 View 填充"),
      }),
      execute: async ({ query, targetHints, targetObjectRefs, taskShape }) => {
        const targetObjectIds = targetObjectRefs?.map((objectRef) => {
          const objectId = input.evidence.objectIdForRef(objectRef);
          if (!objectId) throw new UnknownExploreObjectError(objectRef);
          return objectId;
        });
        reserveCall();
        return merge(await searchMemoryIndex({
          query,
          targetHints: targetHints ?? [],
          targetObjectIds,
          taskShape,
        }, {
          signal: input.signal,
          preferHigherMemory: input.preferHigherMemory,
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
        "objectRef 必须使用本轮初始 Context 或之前工具结果中的 O#；数据库 ID 由 Runtime 自动解析。" +
        "focus 只用于排序，不会创造或扩张事实。",
      inputSchema: z.object({
        objectRef: z.string().trim().regex(/^O\d+$/)
          .describe("已在本轮证据中出现的 O# Object 引用"),
        focus: z.string().trim().min(1).max(memoryExploreLimits.focusChars)
          .optional()
          .describe("可选的关系或子问题焦点"),
      }),
      execute: async ({ objectRef, focus }) => {
        const globalObjectId = input.evidence.objectIdForRef(objectRef);
        if (!globalObjectId) throw new UnknownExploreObjectError(objectRef);
        reserveCall();
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
