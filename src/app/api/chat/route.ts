import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ModelMessage,
  pruneMessages,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  zodSchema,
} from "ai";
import { z } from "zod";

import { latestUserQuery } from "@/ai/chat-policy";
import { ContextPackingError, packContext } from "@/ai/context-packer";
import { createModelProfile } from "@/ai/model-profile";
import { getChatModel } from "@/ai/provider";
import type { ClubChatMessage } from "@/ai/types";
import { finalStepMessageText } from "@/ai/ui-message-text";
import {
  citedAssertionRefs,
  hydrateCitedSourceExcerpts,
} from "@/memory/citation-sources";
import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import { createMemoryExploreToolset } from "@/memory/explore-toolset";
import { getMemoryRetriever } from "@/memory/retriever";
import type {
  MemoryRetrievalResult,
  MemorySearchBundle,
  MemorySearchTrace,
} from "@/memory/types";
import { emptySeedMap } from "@/memory/types";

export const maxDuration = 600;

const MAX_EXPLORE_STEPS = 4;
const EXPLORE_PROTOCOL_RESERVE_TOKENS = 4_000;

const EXPLORE_INSTRUCTIONS = `
你可以按需使用 searchMemory 和 followObject 在 Echo 的 GlobalObject–Assertion 记忆中查找组织知识。本轮开始时尚未执行搜索。
问候、闲聊、改写、翻译、总结用户已提供的文字、一般概念解释以及不依赖 Echo 组织资料的任务，直接回答，不要调用检索工具。
询问 Echo 中的协会、人物、活动、历史、时间、状态、制度、来源或其他组织事实时，必须先用 searchMemory 获取 Assertion；不得只依赖模型内部知识。
获得证据后如果仍存在未覆盖的子问题、歧义或证据缺口，优先用 searchMemory 换一个聚焦查询；只能对工具结果中已出现的 database GlobalObject id 调用 followObject。
独立的检索方向可以在同一 step 中发出多个 tool call；不要重复相同查询。
工具结果中的 [A#] 与 [O#] 已并入本轮统一 ref namespace。只有 Assertion 文本是事实证据；Object identity、surface form 和 connection 都不是额外事实。
最终回答中的组织事实必须引用实际支持它的 [A#]。检索失败或证据仍不足时如实说明，不得用常识补齐。
`.trim();

const FINAL_ANSWER_INSTRUCTION =
  "当前是本轮最后的回答 step，检索工具已停用。请立即基于现有 Assertion 完成最终回答；若证据不足则明确说明，并保留正确的 [A#] 引用。";

const facetSchema = z.object({
  id: z.string(),
  text: z.string(),
  source: z.enum(["query", "ai"]),
});

const matchSchema = z.object({
  facetId: z.string(),
  channel: z.enum(["object-lexical", "assertion-lexical", "assertion-vector"]),
  method: z.enum(["exact", "normalized-exact", "alias", "contains", "fuzzy", "vector"]),
  rank: z.number().int(),
  score: z.number(),
  distance: z.number().optional(),
});

const temporalSchema = z.object({
  rawExpression: z.string(),
  kind: z.enum(["point", "range", "recurring", "relative", "contextual", "unknown"]),
  normalizedText: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
  precision: z.enum(["day", "month", "year", "academic_year", "semester", "unspecified"]),
  derivation: z.enum(["source_explicit", "contextual_inference", "unresolved"]),
  basis: z.string(),
});

const sourceSchema = z.object({
  sourceTitle: z.string(),
  sourceSha256: z.string(),
  sourceNodeId: z.string(),
  sourceRegionLabel: z.string(),
  sourceBlockId: z.string(),
  ordinal: z.number().int(),
  pages: z.array(z.number()),
  excerpt: z.string().optional(),
});

const seedMapSchema = z.object({
  facets: z.array(facetSchema),
  objects: z.array(z.object({
    ref: z.string(),
    id: z.string(),
    globalObjectKey: z.string(),
    canonicalName: z.string(),
    surfaceForms: z.array(z.string()),
    matchedBy: z.array(matchSchema),
    matchedFacets: z.array(z.string()),
    supportingAssertions: z.array(z.string()),
    lexicalMatch: z.boolean(),
    semanticMatch: z.boolean(),
  })),
  assertions: z.array(z.object({
    ref: z.string(),
    sourceNodeId: z.string(),
    sourceClaimId: z.string(),
    renderedStatement: z.string(),
    contextDependent: z.boolean(),
    matchedBy: z.array(matchSchema),
    matchedFacets: z.array(z.string()),
    temporalAnnotations: z.array(temporalSchema),
    sources: z.array(sourceSchema),
  })),
  connections: z.array(z.object({
    assertionRef: z.string(),
    objectRef: z.string(),
  })),
});

const traceHitSchema = z.object({
  facetId: z.string(),
  targetRef: z.string(),
  label: z.string(),
  method: z.enum(["exact", "normalized-exact", "alias", "contains", "fuzzy", "vector"]),
  rank: z.number().int(),
  score: z.number(),
  distance: z.number().optional(),
  selected: z.boolean(),
});

const channelTraceSchema = z.object({
  facetId: z.string(),
  facetText: z.string(),
  hits: z.array(traceHitSchema),
});

const traceSchema = z.object({
  version: z.literal("structured-seed-map.v1"),
  query: z.string(),
  snapshot: z.object({
    id: z.string(),
    sourceTitle: z.string(),
    sourceSha256: z.string(),
    compiledAt: z.string(),
    embeddingModel: z.string().nullable(),
    embeddingRevision: z.string().nullable(),
    embeddingDimension: z.number().int().nullable(),
    embeddingAssertionCount: z.number().int(),
    globalObjectCount: z.number().int(),
    objectFragmentCount: z.number().int(),
    surfaceFormCount: z.number().int(),
    fragmentReferenceCount: z.number().int(),
    assertionCount: z.number().int(),
  }),
  facets: z.array(facetSchema),
  objectLexical: z.array(channelTraceSchema),
  assertionLexical: z.array(channelTraceSchema),
  assertionVector: z.array(channelTraceSchema),
  semanticDerivedObjects: z.array(z.object({
    objectRef: z.string(),
    canonicalName: z.string(),
    supportingAssertions: z.array(z.string()),
    matchedFacets: z.array(z.string()),
  })),
  finalSeedMap: z.object({
    objectRefs: z.array(z.string()),
    assertionRefs: z.array(z.string()),
    connections: z.number().int(),
  }),
  answerUsedAssertionRefs: z.array(z.string()),
  budget: z.object({
    facetLimit: z.number().int(),
    objectHitsPerFacet: z.number().int(),
    assertionLexicalHitsPerFacet: z.number().int(),
    assertionVectorHitsPerFacet: z.number().int(),
    assertionSeeds: z.number().int(),
  }),
  durationMs: z.number().int(),
  warnings: z.array(z.string()),
});

const memorySearchSchema = z.object({
  mode: z.enum(["disabled", "fixture", "object-assertion"]),
  seedMap: seedMapSchema,
  answerUsedAssertionRefs: z.array(z.string()).optional(),
  trace: traceSchema.optional(),
});

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}
function actualSeedTrace(result: MemoryRetrievalResult) {
  if (!result.trace) return undefined;
  return {
    ...result.trace,
    finalSeedMap: {
      objectRefs: result.seedMap.objects.map((item) => item.ref),
      assertionRefs: result.seedMap.assertions.map((item) => item.ref),
      connections: result.seedMap.connections.length,
    },
  };
}

function searchBundle(
  result: MemoryRetrievalResult,
  answerUsedAssertionRefs: string[] = [],
  locateTrace?: MemorySearchTrace,
): MemorySearchBundle {
  const trace = locateTrace ?? actualSeedTrace(result);
  return {
    mode: result.mode,
    seedMap: result.seedMap,
    answerUsedAssertionRefs,
    ...(trace
      ? { trace }
      : {}),
  };
}

function compactExploreStepMessages(messages: ModelMessage[]): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: "all",
    emptyMessages: "remove",
  }).map((message): ModelMessage => {
    if (
      message.role !== "assistant" ||
      typeof message.content === "string" ||
      !message.content.some((part) => part.type === "tool-call")
    ) {
      return message;
    }

    // Provisional prose before a tool call is neither final answer nor needed
    // by the next model step. Keep the tool call itself and its paired result.
    return {
      ...message,
      content: message.content.filter((part) => part.type !== "text"),
    };
  });
}

export async function POST(request: Request) {
  let profile;
  try {
    profile = createModelProfile();
  } catch (error) {
    console.error("[chat.config]", error);
    return jsonError("AI 上下文配置无效，请联系管理员。", 500);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > profile.maxRequestBytes) return jsonError("请求内容过大。", 413);

  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > profile.maxRequestBytes) {
      return jsonError("请求内容过大。", 413);
    }
    body = JSON.parse(text);
  } catch {
    return jsonError("请求格式不是有效 JSON。", 400);
  }

  const messagesInput =
    typeof body === "object" && body !== null
      ? (body as { messages?: unknown }).messages
      : undefined;
  const validation = await safeValidateUIMessages<ClubChatMessage>({
    messages: messagesInput,
    dataSchemas: { memorySearch: zodSchema(memorySearchSchema) },
  });
  if (!validation.success) return jsonError("消息格式错误。", 400);

  const messages = validation.data;
  const query = latestUserQuery(messages);
  if (!query) return jsonError("消息内容不能为空。", 400);

  let model;
  try {
    model = getChatModel();
  } catch {
    return jsonError("AI 服务暂不可用，请联系管理员。", 500);
  }

  const retrieval: MemoryRetrievalResult = {
    query,
    mode: getMemoryRetriever().mode,
    seedMap: emptySeedMap(),
  };

  let context;
  try {
    const modelHistory = messages.map((message): ClubChatMessage =>
      message.role === "assistant"
        ? {
            ...message,
            parts: [{ type: "text", text: finalStepMessageText(message) }],
          }
        : message,
    );
    const modelMessages = pruneMessages({
      messages: await convertToModelMessages(modelHistory),
      reasoning: "all",
      toolCalls: "before-last-message",
      emptyMessages: "remove",
    });
    context = packContext({
      messages: modelMessages,
      retrieval,
      profile,
      memoryState: "not-searched",
    });
  } catch (error) {
    if (error instanceof ContextPackingError) {
      return jsonError(error.message, error.code === "current_message_too_large" ? 413 : 400);
    }
    console.error("[chat.context]", error);
    return jsonError("无法准备本轮对话上下文。", 500);
  }

  const exploreResultTokenBudget = Math.max(
    0,
    Math.min(
      profile.memoryMaxTokens,
      context.report.limits.hardInput -
        context.report.estimatedTokens.totalInput -
        EXPLORE_PROTOCOL_RESERVE_TOKENS,
    ),
  );
  console.info(
    "[chat.context]",
    JSON.stringify({ ...context.report, exploreResultTokenBudget }),
  );
  const stream = createUIMessageStream<ClubChatMessage>({
    originalMessages: messages,
    execute: async ({ writer }) => {
      const evidence = new MemoryEvidenceAccumulator(context.retrieval);
      let hasSearchedMemory = false;
      let latestLocateTrace: MemorySearchTrace | undefined;
      const tools = createMemoryExploreToolset({
        evidence,
        resultTokenBudget: exploreResultTokenBudget,
        signal: request.signal,
        onLocateTrace: (trace) => {
          latestLocateTrace = {
            ...trace,
            finalSeedMap: {
              objectRefs: [...trace.finalSeedMap.objectRefs],
              assertionRefs: [...trace.finalSeedMap.assertionRefs],
              connections: trace.finalSeedMap.connections,
            },
          };
        },
        onEvidence: (current, discovered) => {
          hasSearchedMemory = true;
          console.info(
            "[chat.explore]",
            JSON.stringify({
              kind: discovered.kind,
              query: discovered.query,
              globalObjectId: discovered.globalObjectId,
              focus: discovered.focus,
              discovered: discovered.counts,
              accumulated: {
                objects: current.seedMap.objects.length,
                assertions: current.seedMap.assertions.length,
                connections: current.seedMap.connections.length,
              },
              truncated: discovered.truncated,
              warnings: discovered.warnings,
            }),
          );
          writer.write({
            type: "data-memorySearch",
            data: searchBundle(current, [], latestLocateTrace),
          });
        },
      });
      const exploreSystem = `${context.system}\n\n${EXPLORE_INSTRUCTIONS}`;

      const result = streamText({
        model,
        system: exploreSystem,
        messages: context.messages,
        tools,
        toolChoice: "auto",
        stopWhen: stepCountIs(MAX_EXPLORE_STEPS),
        prepareStep: ({ stepNumber, messages: stepMessages }) => ({
          ...(stepNumber > 0
            ? { messages: compactExploreStepMessages(stepMessages) }
            : {}),
          ...(stepNumber === MAX_EXPLORE_STEPS - 1 || exploreResultTokenBudget === 0
            ? {
                activeTools: [] as const,
                toolChoice: "none" as const,
                instructions:
                  stepNumber === MAX_EXPLORE_STEPS - 1
                    ? `${exploreSystem}\n\n${FINAL_ANSWER_INSTRUCTION}`
                    : exploreSystem,
              }
            : {}),
        }),
        temperature: 0.3,
        maxOutputTokens: profile.maxOutputTokens,
        abortSignal: request.signal,
        timeout: {
          totalMs: profile.timeoutMs,
          stepMs: Math.min(profile.timeoutMs, 180_000),
          chunkMs: 60_000,
          toolMs: 120_000,
        },
        onStepEnd: ({ stepNumber, finishReason, toolCalls, toolResults, usage }) => {
          console.info(
            "[chat.step]",
            JSON.stringify({
              stepNumber,
              finishReason,
              toolCalls: toolCalls.map((call) => call.toolName),
              toolResults: toolResults.length,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            }),
          );
        },
        onFinish: async ({ text, finishReason, totalUsage }) => {
          const accumulatedRetrieval = evidence.snapshot();
          const usedRefs = citedAssertionRefs(text, accumulatedRetrieval.seedMap);
          let citedRetrieval = accumulatedRetrieval;
          try {
            citedRetrieval = await hydrateCitedSourceExcerpts(
              accumulatedRetrieval,
              usedRefs,
            );
          } catch (error) {
            console.error("[chat.citation-sources]", error);
          }
          if (hasSearchedMemory) {
            writer.write({
              type: "data-memorySearch",
              data: searchBundle(citedRetrieval, usedRefs, latestLocateTrace),
            });
          }
          console.info(
            "[chat.usage]",
            JSON.stringify({
              finishReason,
              answerUsedAssertionRefs: usedRefs,
              inputTokens: totalUsage.inputTokens,
              outputTokens: totalUsage.outputTokens,
              reasoningTokens: totalUsage.outputTokenDetails.reasoningTokens,
              totalTokens: totalUsage.totalTokens,
            }),
          );
        },
      });

      writer.merge(result.toUIMessageStream({ sendReasoning: true }));
    },
    onError: () => "AI 服务响应失败，请稍后重试。",
  });

  return createUIMessageStreamResponse({ stream });
}
