import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  getToolName,
  isToolUIPart,
  type ModelMessage,
  pruneMessages,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  tool,
  type ToolSet,
  type UIMessageChunk,
  zodSchema,
} from "ai";
import { z } from "zod";

import { latestUserQuery, messageText } from "@/ai/chat-policy";
import { citedRefs } from "@/ai/citation-refs";
import {
  auditGroundedAnswer,
  GroundingState,
  type GroundingAudit,
} from "@/ai/grounding-gates";
import {
  activeCapabilityToolNames,
  capabilityGatewayToolNames,
  createCapabilityGatewayTools,
  createOpenedCapabilities,
  detailedToolNames,
  TURN_KERNEL_INSTRUCTIONS,
} from "@/ai/capability-gates";
import { buildCapabilityInstructions } from "@/ai/capability-instructions";
import { ContextPackingError, packContext } from "@/ai/context-packer";
import { buildCurrentTimeInstruction } from "@/ai/current-time-context";
import {
  createEchoDebugTrace,
  debugCodeBlock,
  debugJson,
  renderDebugMessages,
  renderDebugModelOutput,
  renderDebugTools,
} from "@/ai/debug-trace";
import { createModelProfile } from "@/ai/model-profile";
import { getChatModel } from "@/ai/provider";
import { ToolResultTokenBudget } from "@/ai/tool-result-budget";
import type { ChatPageContext, ClubChatMessage } from "@/ai/types";
import { modelHistoryMessageText } from "@/ai/ui-message-text";
import { buildViewContext } from "@/agent-runtime/view-context";
import {
  buildViewOrientationContext,
  loadViewHigherMemory,
} from "@/agent-runtime/view-orientation";
import { createAgentViewToolset, registeredViewKeySchema } from "@/agent-runtime/view-toolset";
import {
  viewCommandProposalNoticeSchema,
  viewReferenceBundleSchema,
} from "@/agent-runtime/view-types";
import { currentAuthUser } from "@/auth/session";
import {
  extensionRegistry,
  viewCommandBus,
  viewReadPort,
} from "@/shell/composition-root";
import { saveChatMessage } from "@/chat/persistence";
import {
  artifactSearchEvidenceSemantics,
  retrievalEvidenceSemantics,
} from "@/evidence/tool-semantics";
import {
  findArtifactsByTitle,
  getArtifactPublishedKnowledge,
} from "@/library/artifact-knowledge";
import { artifactReferenceBundleSchema } from "@/library/artifact-reference-ui-schema";
import { createArtifactReferenceRegistry } from "@/library/artifact-references";
import { createLibraryToolset } from "@/library/toolset";
import { libraryPlanPresentationSchema } from "@/library/ui-schema";
import {
  citedAssertionRefs,
  hydrateCitedSourceExcerpts,
} from "@/memory/citation-sources";
import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import {
  captureChatAssertions,
  organizationTimezone,
  type ChatMainModelCall,
  type ChatMainToolExecution,
  type ChatSemanticMessage,
} from "@/memory/chat-assertion";
import { createChatAssertionQueueTool } from "@/memory/chat-assertion-queue";
import {
  completeChatAssertionReceipt,
  createMemoryWriteStatusTool,
  failChatAssertionReceipt,
  markChatAssertionReceiptRunning,
  queueChatAssertionReceipt,
} from "@/memory/chat-assertion-receipt";
import { createChatMemoryMaintenanceScheduler } from "@/memory/chat-assertion-lifecycle";
import {
  loadAmbientHigherMemories,
  type AmbientHigherMemorySnapshot,
} from "@/memory/ambient-higher-memory";
import { createMemoryExploreToolset } from "@/memory/explore-toolset";
import { getMemoryRetriever } from "@/memory/retriever";
import { createObjectManagementToolset } from "@/memory/object-management-toolset";
import { objectChangeProposalPresentationSchema } from "@/memory/object-management-types";
import { createSourceDocumentToolset } from "@/memory/source-document-toolset";
import { sourceDocumentReferenceBundleSchema } from "@/memory/source-document-ui-schema";
import type {
  EvidenceCoverageByLayer,
  MemoryRetrievalResult,
  MemorySearchBundle,
  MemorySearchTrace,
} from "@/memory/types";
import { emptySeedMap } from "@/memory/types";

export const maxDuration = 600;

// View → Search → optional original-source reads/continuations → Proposal → final answer.
const MAX_EXPLORE_STEPS = 12;
const EXPLORE_PROTOCOL_RESERVE_TOKENS = 4_000;


const FINAL_ANSWER_INSTRUCTION =
  "当前是本轮最后的回答 step，工具已停用。请立即基于现有正式 View、Assertion、已经读取的原文或资料库索引完成最终回答；若证据不足则明确说明，并保留正确的 [V#]/[A#]/[S#]/[F#] 引用。";

const TURN_HANDOFF_TOOL = "submitTurnHandoff";
const turnHandoffSchema = z.object({
  reviewNeeded: z.boolean(),
  candidateQuotes: z.array(z.string().trim().min(1).max(300)).max(3),
});

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function withoutTurnHandoff(message: ClubChatMessage): ClubChatMessage {
  return {
    ...message,
    parts: message.parts.filter((part) =>
      !isToolUIPart(part) || getToolName(part) !== TURN_HANDOFF_TOOL
    ),
  };
}

const pageContextSchema = z.object({
  activeViewKey: registeredViewKeySchema(extensionRegistry).optional(),
  activePresentation: z.enum(["inspector", "full_chat", "library"]),
  activeFolderId: z.string().uuid().optional(),
  activeCardId: z.string().uuid().optional(),
  activeNodeId: z.string().uuid().optional(),
  activeObjectName: z.string().trim().min(1).max(200).optional(),
}).refine(
  (context) => ["full_chat", "library"].includes(context.activePresentation) || Boolean(context.activeViewKey),
  { message: "Business View presentation 必须提供 activeViewKey" },
);

function pageContextInstruction(context?: ChatPageContext): string {
  if (!context || context.activePresentation === "full_chat") {
    return "页面 soft context：用户当前位于全屏 AI 对话。不要因此限制 Shared Brain 检索范围。";
  }
  if (context.activePresentation === "library") {
    return [
      `页面 soft context：用户当前正在查看资料库${context.activeFolderId ? `，当前文件夹 id 为 ${context.activeFolderId}` : ""}。`,
      "这只用于理解当前工作位置；文件索引不是组织事实证据。",
    ].join("\n");
  }
  return [
    `页面 soft context：用户当前正在查看 ${context.activeViewKey} 的只读 Generic View Inspector。`,
    ...(context.activeObjectName || context.activeCardId || context.activeNodeId
      ? [
          `当前页面实体：${context.activeObjectName ?? "名称未提供"}` +
            `${context.activeCardId ? `；Card ID=${context.activeCardId}` : ""}` +
            `${context.activeNodeId ? `；Node ID=${context.activeNodeId}` : ""}。`,
          "用户说“这个、该节点、当前对象、这里”时优先按该实体理解；用户明确点名其他实体时，以明确名称为准。",
        ]
      : []),
    "这只用于理解用户当前工作位置；可以优先考虑当前 View，但不能限制已有 Shared Brain retrieval，也不能把页面状态当作事实依据。",
  ].join("\n");
}

function authenticatedUserInstruction(user: Awaited<ReturnType<typeof currentAuthUser>>): string {
  if (!user) return "";
  return [
    `当前登录用户：${user.actor.displayName}。`,
    user.personObject
      ? `用户说“我”时，对应已认证人物“${user.personObject.canonicalName}”；内部 ID 由服务端处理。`
      : "当前账号尚未关联人物对象，不要猜测“我”对应谁。",
  ].join("\n");
}

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

const documentSourceSchema = z.object({
  kind: z.literal("document").optional(),
  sourceTitle: z.string(),
  sourceSha256: z.string(),
  sourceNodeId: z.string(),
  sourceRegionLabel: z.string(),
  sourceBlockId: z.string(),
  ordinal: z.number().int(),
  pages: z.array(z.number()),
  excerpt: z.string().optional(),
});

const chatSourceSchema = z.object({
  kind: z.literal("chat"),
  evidenceId: z.string(),
  actorId: z.string(),
  actorDisplayName: z.string(),
  submittedAt: z.string(),
  timezone: z.string(),
  ordinal: z.number().int(),
  excerpt: z.string().optional(),
});

const sourceSchema = z.union([documentSourceSchema, chatSourceSchema]);

const seedMapSchema = z.object({
  facets: z.array(facetSchema),
  sourceTime: z.object({
    sourceTitle: z.string(),
    sourceSha256: z.string(),
    text: z.string().nullable(),
    supportingBlocks: z.array(z.object({
      sourceBlockId: z.string(),
      pages: z.array(z.number()),
    })),
  }).optional(),
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
  higherMemories: z.array(z.object({
    ref: z.string(),
    id: z.string(),
    globalObjectId: z.string(),
    contentMarkdown: z.string(),
    maintainedAt: z.string(),
  })).optional(),
  assertions: z.array(z.object({
    ref: z.string(),
    id: z.string().optional(),
    kind: z.enum(["grounded", "reference"]),
    dereferenceRequired: z.boolean(),
    sourceNodeId: z.string().optional(),
    sourceClaimId: z.string(),
    renderedStatement: z.string(),
    contextDependent: z.boolean(),
    matchedBy: z.array(matchSchema),
    matchedFacets: z.array(z.string()),
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

const evidenceCoverageSchema = z.object({
  level: z.enum(["complete", "partial", "insufficient"]),
  missingAspects: z.array(z.string()),
  observationComplete: z.boolean().optional(),
  contentPresence: z.enum(["present", "absent", "unknown"]).optional(),
});

const memorySearchSchema = z.object({
  mode: z.enum(["disabled", "fixture", "object-assertion"]),
  seedMap: seedMapSchema,
  answerUsedAssertionRefs: z.array(z.string()).optional(),
  answerUsedHigherMemoryRefs: z.array(z.string()).optional(),
  coverage: evidenceCoverageSchema.optional(),
  coverageByLayer: z.object({
    business_view: evidenceCoverageSchema.optional(),
    library: evidenceCoverageSchema.optional(),
    shared_brain: evidenceCoverageSchema.optional(),
    source_document: evidenceCoverageSchema.optional(),
  }).optional(),
  trace: traceSchema.optional(),
});

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

function safeStreamErrorSummary(error: unknown) {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
  const rawMessage = error instanceof Error ? error.message : "Unknown stream error";
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: rawMessage.replace(/\s+/g, " ").slice(0, 1_000),
    ...(typeof record?.statusCode === "number"
      ? { statusCode: record.statusCode }
      : {}),
  };
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
  answerUsedHigherMemoryRefs: string[] = [],
  locateTrace?: MemorySearchTrace,
  coverageByLayer?: EvidenceCoverageByLayer,
): MemorySearchBundle {
  const trace = locateTrace ?? actualSeedTrace(result);
  return {
    mode: result.mode,
    seedMap: result.seedMap,
    answerUsedAssertionRefs,
    answerUsedHigherMemoryRefs,
    ...(coverageByLayer ? { coverageByLayer } : {}),
    ...(trace
      ? { trace }
      : {}),
  };
}

/** Buffer model prose until the final server-side grounding audit has passed. */
function bufferFinalAnswerStream<T extends UIMessageChunk>(
  stream: ReadableStream<UIMessageChunk>,
  resolveFinalText: (rawText: string) => string,
): ReadableStream<T> {
  let currentStepText = "";
  let lastCompletedText = "";
  let pendingFinishStep: UIMessageChunk | undefined;
  let answerEmitted = false;

  const emitAnswer = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
    if (answerEmitted) return;
    answerEmitted = true;
    const text = resolveFinalText(lastCompletedText || currentStepText);
    const id = "grounded-final-answer";
    controller.enqueue({ type: "text-start", id });
    if (text) controller.enqueue({ type: "text-delta", id, delta: text });
    controller.enqueue({ type: "text-end", id });
  };

  return stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (pendingFinishStep && chunk.type !== "finish") {
        controller.enqueue(pendingFinishStep);
        pendingFinishStep = undefined;
      }
      switch (chunk.type) {
        case "start-step":
          currentStepText = "";
          controller.enqueue(chunk);
          return;
        case "text-start":
        case "text-end":
          return;
        case "text-delta":
          currentStepText += chunk.delta;
          return;
        case "finish-step":
          lastCompletedText = currentStepText;
          pendingFinishStep = chunk;
          return;
        case "finish":
          emitAnswer(controller);
          if (pendingFinishStep) controller.enqueue(pendingFinishStep);
          pendingFinishStep = undefined;
          controller.enqueue(chunk);
          return;
        default:
          controller.enqueue(chunk);
      }
    },
    flush(controller) {
      if (!answerEmitted && (lastCompletedText || currentStepText)) emitAnswer(controller);
      if (pendingFinishStep) controller.enqueue(pendingFinishStep);
    },
  })) as ReadableStream<T>;
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
  let authenticatedUser;
  try {
    authenticatedUser = await currentAuthUser();
  } catch (error) {
    console.error("[chat.auth]", error);
    return jsonError("无法验证登录状态。", 500);
  }
  if (!authenticatedUser) return jsonError("请先登录。", 401);

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
  const pageContextInput =
    typeof body === "object" && body !== null
      ? (body as { pageContext?: unknown }).pageContext
      : undefined;
  const conversationIdResult = z.string().uuid().safeParse(
    typeof body === "object" && body !== null
      ? (body as { conversationId?: unknown }).conversationId
      : undefined,
  );
  if (!conversationIdResult.success) return jsonError("对话 ID 格式错误。", 400);
  const conversationId = conversationIdResult.data;
  const pageContextResult = pageContextInput === undefined
    ? { success: true as const, data: undefined }
    : pageContextSchema.safeParse(pageContextInput);
  if (!pageContextResult.success) return jsonError("页面上下文格式错误。", 400);
  const pageContext = pageContextResult.data;
  const validation = await safeValidateUIMessages<ClubChatMessage>({
    messages: messagesInput,
    dataSchemas: {
      memorySearch: zodSchema(memorySearchSchema),
      sourceReferences: zodSchema(sourceDocumentReferenceBundleSchema),
      artifactReferences: zodSchema(artifactReferenceBundleSchema),
      viewReferences: zodSchema(viewReferenceBundleSchema),
      viewCommandProposal: zodSchema(viewCommandProposalNoticeSchema),
      objectChangeProposal: zodSchema(objectChangeProposalPresentationSchema),
      libraryProposal: zodSchema(libraryPlanPresentationSchema),
    },
  });
  if (!validation.success) return jsonError("消息格式错误。", 400);

  const messages = validation.data;
  const query = latestUserQuery(messages);
  if (!query) return jsonError("消息内容不能为空。", 400);
  const latestUserMessageIndex = messages.findLastIndex((message) => message.role === "user");
  const latestUserMessage = messages[latestUserMessageIndex];
  const submittedAt = new Date();
  let requestTimezone: string;
  const requestActor = authenticatedUser.actor;
  try {
    requestTimezone = organizationTimezone();
  } catch (error) {
    console.error("[chat.time-context.config]", error);
    return jsonError("组织时区或 Actor 配置无效，请联系管理员。", 500);
  }
  const debugTrace = createEchoDebugTrace({
    clientMessageId: latestUserMessage?.id ?? "unknown-message",
    submittedAt,
    timezone: requestTimezone,
    actorId: requestActor.id,
    actorDisplayName: requestActor.displayName,
    userMessage: query,
    pageContext,
  });
  if (latestUserMessage) {
    try {
      await saveChatMessage({
        actor: requestActor,
        conversationId,
        message: latestUserMessage,
        position: latestUserMessageIndex,
      });
    } catch (error) {
      console.error("[chat.history.write-user]", error);
      await debugTrace.appendError("保存用户消息失败", error);
      return jsonError("无法保存对话，请稍后重试。", 503);
    }
  }
  const currentTimeInstruction = buildCurrentTimeInstruction(
    submittedAt,
    requestTimezone,
  );
  const semanticConversation: ChatSemanticMessage[] = messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    return [{
      messageId: message.id,
      role: message.role,
      text: message.role === "assistant"
        ? modelHistoryMessageText(message)
        : messageText(message),
      ...(message.id === latestUserMessage?.id
        ? { submittedAt: submittedAt.toISOString() }
        : {}),
    }];
  });
  const conversationUserMessageIds = semanticConversation
    .filter((message) => message.role === "user")
    .map((message) => message.messageId);
  const memoryMaintenance = createChatMemoryMaintenanceScheduler(debugTrace);
  let ambientHigherMemories: AmbientHigherMemorySnapshot[] = [];
  try {
    ambientHigherMemories = await loadAmbientHigherMemories();
    if (ambientHigherMemories.length) {
      await debugTrace.appendJsonSection(
        "主 Chat 自动加载的 Ambient Higher Memory",
        ambientHigherMemories.map((memory) => ({
          scope: memory.scope,
          maintainedAt: memory.maintainedAt,
          contentMarkdown: memory.contentMarkdown,
        })),
      );
    }
  } catch (error) {
    console.error("[chat.ambient-higher-memory.load]", error);
    await debugTrace.appendError("Ambient Higher Memory 加载失败", error);
  }
  const viewOrientationContext = buildViewOrientationContext(extensionRegistry);

  let model;
  try {
    model = getChatModel();
  } catch {
    memoryMaintenance.cancel("Chat 模型配置无效，主回答和后台记忆线路均未启动。");
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
            parts: [{ type: "text", text: modelHistoryMessageText(message) }],
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
      ambientHigherMemories,
    });
  } catch (error) {
    memoryMaintenance.cancel("无法准备主模型上下文，后台记忆线路未启动。");
    await debugTrace.appendError("主 Chat 上下文准备失败", error);
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
  await debugTrace.appendJsonSection("主 Chat 上下文裁剪报告", {
    ...context.report,
    exploreResultTokenBudget,
  });
  const stream = createUIMessageStream<ClubChatMessage>({
    originalMessages: messages,
    execute: async ({ writer }) => {
      const evidence = new MemoryEvidenceAccumulator(context.retrieval);
      const groundingState = new GroundingState(query, pageContext, semanticConversation);
      const artifactReferences = createArtifactReferenceRegistry();
      const openedCapabilities = createOpenedCapabilities();
      let mainModelCallNumber = 0;
      let exposedToolSchemaBytes = 0;
      let firstAuthoritativeTool: string | undefined;
      let libraryQueryCount = 0;
      let memoryQueryCount = 0;
      let libraryQueryTruncated: boolean | undefined;
      let libraryMatchedCount = 0;
      const sourceLayersUsed = new Set<string>();
      const mainModelCalls: ChatMainModelCall[] = [];
      const mainToolExecutions: ChatMainToolExecution[] = [];
      const sharedResultBudget = new ToolResultTokenBudget(exploreResultTokenBudget);
      let hasSearchedMemory = false;
      let latestLocateTrace: MemorySearchTrace | undefined;
      let finalRawText = "";
      let finalAudit: GroundingAudit | undefined;
      const memoryTools = createMemoryExploreToolset({
        evidence,
        resultTokenBudget: exploreResultTokenBudget,
        sharedResultBudget,
        signal: request.signal,
        curatorContext: {
          conversation: semanticConversation,
          originalUserMessage: query,
          currentInstant: submittedAt.toISOString(),
          timezone: requestTimezone,
        },
        curatorTrace: debugTrace,
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
          openedCapabilities.sharedBrain = true;
          hasSearchedMemory = true;
          if (discovered.coverage) {
            groundingState.observeCoverage("shared_brain", discovered.coverage);
          }
          groundingState.observeSemantics(discovered.semantics);
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
            data: searchBundle(
              current,
              [],
              [],
              latestLocateTrace,
              groundingState.contract().coverageByLayer,
            ),
          });
        },
      });
      const viewToolset = createAgentViewToolset({
        actor: {
          actorId: requestActor.id,
          permissions: ["view.read", "view.write"],
        },
        registry: extensionRegistry,
        readPort: viewReadPort,
        commandBus: viewCommandBus,
        onProposal: (proposal) => {
          writer.write({ type: "data-viewCommandProposal", data: proposal });
        },
      });
      const objectManagementToolset = createObjectManagementToolset({
        onProposal: (proposal) => {
          writer.write({ type: "data-objectChangeProposal", data: proposal });
        },
      });
      const libraryToolset = createLibraryToolset({
        onProposal: (proposal) => {
          writer.write({ type: "data-libraryProposal", data: proposal });
        },
        onPreview: (preview) => groundingState.observeLibraryPreview(preview),
      });
      const sourceDocumentToolset = createSourceDocumentToolset({
        evidence,
        resultTokenBudget: exploreResultTokenBudget,
        sharedResultBudget,
        onRead: (sourceRead) => {
          groundingState.observeSourceDocument(sourceRead);
          groundingState.observeSemantics(sourceRead.semantics);
        },
      });
      const validReferenceRefs = () => {
        const snapshot = evidence.snapshot();
        return [
          ...snapshot.seedMap.assertions.map((item) => item.ref),
          ...(snapshot.seedMap.higherMemories ?? []).map((item) => item.ref),
          ...sourceDocumentToolset.availableReferenceRefs(),
          ...viewToolset.availableReferenceRefs(),
          ...artifactReferences.availableRefs(),
        ];
      };
      const auditAnswer = (rawText: string): GroundingAudit => {
        if (finalAudit && rawText.trim() === finalRawText.trim()) return finalAudit;
        return auditGroundedAnswer({
          text: rawText,
          contract: groundingState.contract(),
          validRefs: validReferenceRefs(),
        });
      };
      const exploreSystem = [
        context.system,
        currentTimeInstruction,
        authenticatedUserInstruction(authenticatedUser),
        pageContextInstruction(pageContext),
        TURN_KERNEL_INSTRUCTIONS,
        viewOrientationContext,
      ].filter(Boolean).join("\n\n");
      await debugTrace.appendJsonSection("服务端 View 预读取", {
        requestedViewKeys: [],
        prefetchedViewKeys: [],
        durationMs: 0,
        note: "首轮只注入短 View Compass；Higher Memory 和精确状态在打开业务能力后读取。",
      });
      const assertionQueueToolset = createChatAssertionQueueTool({
        trace: debugTrace,
        onQueued: async (queueDecision, execution) => {
          try {
            if (!latestUserMessage) throw new Error("Assertion 回执缺少当前用户消息");
            await queueChatAssertionReceipt({
              actorId: requestActor.id,
              actorDisplayName: requestActor.displayName,
              clientMessageId: latestUserMessage.id,
              submittedAt: submittedAt.toISOString(),
              execution,
              queueReason: queueDecision.reason,
            });
          } catch (error) {
            console.error("[chat.assertion-receipt.queue]", error);
            await debugTrace.appendError("登记 Assertion 处理回执失败", error);
          }
        },
        captureForeground: async (queueDecision) => {
          if (!latestUserMessage) {
            throw new Error("前台 Assertion 捕获缺少当前用户消息");
          }
          const receiptKey = {
            actorId: requestActor.id,
            clientMessageId: latestUserMessage.id,
          };
          try {
            await markChatAssertionReceiptRunning(receiptKey);
            const captureResult = await captureChatAssertions({
              actor: requestActor,
              conversationId,
              clientMessageId: latestUserMessage.id,
              submittedAt: submittedAt.toISOString(),
              timezone: requestTimezone,
              semanticContext: {
                conversation: semanticConversation.slice(-8),
                systemInstruction: "",
                modelCalls: [],
                toolExecutions: [],
                finalAnswer: "（前台 Assertion/Object 发布发生在主回答完成之前）",
              },
              retrieval: evidence.snapshot(),
              queueDecision,
            }, debugTrace);
            await completeChatAssertionReceipt(receiptKey, captureResult);
            return captureResult;
          } catch (error) {
            try {
              await failChatAssertionReceipt(receiptKey, error);
            } catch (receiptError) {
              console.error("[chat.assertion-receipt.foreground-failed]", receiptError);
              await debugTrace.appendError("前台 Assertion 失败回执写入失败", receiptError);
            }
            throw error;
          }
        },
        onForegroundResult: (captureResult) => {
          objectManagementToolset.registerPublishedMemory(captureResult);
        },
      });
      const knownArtifactNodeIds = new Set<string>();
      const gatewayTools = createCapabilityGatewayTools(openedCapabilities, {
        viewKeySchema: registeredViewKeySchema(extensionRegistry),
        openBusinessContext: async ({ viewKey, focus, targetHints }) => {
          const viewModule = extensionRegistry.getView(viewKey)!;
          const [snapshot, viewHigherMemory] = await Promise.all([
            viewToolset.readView(viewKey),
            loadViewHigherMemory(viewKey),
          ]);
          const refersToCurrentPage = /(这个|这份|这里|当前|该节点|该对象|此处|本页)/u.test(query);
          const pageTargetHints = refersToCurrentPage && pageContext?.activeObjectName
            ? [...new Set([...targetHints, pageContext.activeObjectName])]
            : targetHints;
          const businessContext = await buildViewContext({
            snapshot,
            viewLabel: viewModule.manifest.label,
            viewDescription: viewModule.manifest.description,
            cardTypes: viewModule.schema.cardTypes,
            focus,
            targetHints: pageTargetHints,
            activeCardId: refersToCurrentPage
              ? pageContext?.activeCardId
              : undefined,
          });
          groundingState.observeBusinessContext({
            view: businessContext.view,
            targetHints: pageTargetHints,
            relevantCards: businessContext.relevantCards,
            coverage: businessContext.evidence.coverage,
            semantics: businessContext.semantics,
          });
          const discovered = evidence.merge(businessContext.evidence);
          firstAuthoritativeTool ??= "openBusinessContext";
          sourceLayersUsed.add("business_view");
          if (discovered.higherMemories?.length) {
            sourceLayersUsed.add("shared_brain");
            writer.write({
              type: "data-memorySearch",
              data: searchBundle(
                evidence.snapshot(),
                [],
                [],
                latestLocateTrace,
                groundingState.contract().coverageByLayer,
              ),
            });
          }
          return {
            view: businessContext.view,
            cardTypes: viewModule.schema.cardTypes,
            viewHigherMemory: viewHigherMemory ?? null,
            relevantCards: businessContext.relevantCards,
            cardObjects: discovered.objects,
            objectHigherMemories: discovered.higherMemories ?? [],
            formalCardMissing: businessContext.formalCardMissing,
            unresolvedAspects: businessContext.unresolvedAspects,
            coverage: businessContext.evidence.coverage,
            semantics: businessContext.semantics,
            next: businessContext.formalCardMissing
              ? "当前正式 View 的存在性与收录状态已经可以直接回答：没有匹配 Card。只有用户还要求相关业务事实或补建依据时，才使用 expandEvidence；相关资料不得冒充正式 View。"
              : businessContext.unresolvedAspects.length
                ? "如果缺口会影响回答，使用 expandEvidence；如果用户确认或后续可靠证据已经足以填补一个稳定、可复用的正式 View 缺口，还应使用 openActions(business_view) 生成待审批 Proposal；否则直接回答。"
              : "当前 View + Object Higher Memory 已没有显式缺口，优先直接回答。",
          };
        },
        findArtifacts: async ({ title }) => {
          const result = await findArtifactsByTitle({ title });
          const referencedResult = artifactReferences.attachSearchReferences(result);
          const semantics = artifactSearchEvidenceSemantics(referencedResult);
          referencedResult.items.forEach((item) => knownArtifactNodeIds.add(item.nodeId));
          groundingState.observeArtifactSearch(referencedResult);
          groundingState.observeSemantics(semantics);
          firstAuthoritativeTool ??= "openArtifacts";
          sourceLayersUsed.add("library");
          return { ...referencedResult, semantics };
        },
      });
      const openArtifactKnowledge = tool({
        description:
          "对 openArtifacts 已找到的一个真实文件，按主题读取该文件已发布到 Shared Brain 的 Assertion 和相关 Object。这是文件 provenance 确定性桥梁；默认不混入可能综合其他来源的 Object Higher Memory。",
        inputSchema: z.object({
          nodeId: z.string().uuid()
            .describe("必须原样使用 openArtifacts 本轮返回的 nodeId"),
          query: z.string().trim().min(1).max(500).optional()
            .describe("要在该文件已发布知识中定位的主题；省略时按稳定顺序浏览"),
          topK: z.number().int().min(1).max(40).default(12),
          cursor: z.number().int().min(0).default(0)
            .describe("上一页 nextCursor；首次调用传 0"),
          includeConnections: z.boolean().default(false),
          includeHigherMemory: z.boolean().default(false)
            .describe("默认关闭；开启后返回的是跨来源 Object 背景，不能归因于当前文件"),
        }),
        execute: async ({
          nodeId,
          query: artifactQuery,
          topK,
          cursor,
          includeConnections,
          includeHigherMemory,
        }) => {
          if (!knownArtifactNodeIds.has(nodeId)) {
            throw new Error("必须先用 openArtifacts 定位真实文件 nodeId");
          }
          const result = await getArtifactPublishedKnowledge({
            nodeId,
            query: artifactQuery,
            assertionLimit: topK,
            cursor,
            includeConnections,
            includeHigherMemory,
          });
          const discovered = evidence.merge(result.evidence);
          const semantics = retrievalEvidenceSemantics({
            id: `artifact_knowledge.${nodeId}.${cursor}`,
            layer: "shared_brain",
            scope: `artifact:${nodeId}`,
            subject: result.artifact.name,
            question: artifactQuery ?? `该文件发布了哪些 Shared Brain 知识`,
            coverage: result.evidence.coverage,
            refs: [
              ...(discovered.higherMemories ?? []).map((item) => item.ref),
              ...discovered.assertions.map((item) => item.ref),
            ],
            authority: "supporting",
            presentSummary: "该文件存在已发布且可读取的 Shared Brain 证据。",
            absentSummary: "该文件当前页没有返回可用的已发布 Assertion。",
            unknownSummary: "该文件的已发布知识尚未被完整观察。",
          });
          groundingState.observeArtifactKnowledge({
            nodeId,
            assertionCount: result.evidence.assertions.length,
            coverage: result.evidence.coverage,
          });
          groundingState.observeSemantics(semantics);
          sourceLayersUsed.add("library");
          if (discovered.assertions.length || discovered.higherMemories?.length) {
            sourceLayersUsed.add("shared_brain");
            writer.write({
              type: "data-memorySearch",
              data: searchBundle(
                evidence.snapshot(),
                [],
                [],
                latestLocateTrace,
                groundingState.contract().coverageByLayer,
              ),
            });
          }
          return {
            artifact: {
              ...result.artifact,
              ref: artifactReferences.referenceForNode(nodeId),
            },
            page: result.page,
            publishedObjects: discovered.objects,
            objectHigherMemories: discovered.higherMemories ?? [],
            publishedAssertions: discovered.assertions,
            connections: discovered.connections,
            truncated: discovered.truncated,
            coverage: result.evidence.coverage,
            semantics,
            warnings: discovered.warnings,
          };
        },
      });
      const submitTurnHandoff = tool({
        description:
          "与本轮完整最终回答在同一次响应中调用。只判断当前用户原话是否包含值得独立知识审查的新事实、纠正、决定、计划或状态变化；纯问题和检索过程不审查。",
        inputSchema: turnHandoffSchema,
        execute: async (handoff) => ({ accepted: true, ...handoff }),
      });
      const allTools: ToolSet = {
        ...gatewayTools,
        ...memoryTools,
        expandEvidence: memoryTools.searchMemory,
        readMemoryWriteStatus: createMemoryWriteStatusTool({
          actorId: requestActor.id,
          conversationMessageIds: conversationUserMessageIds,
        }),
        readSourceDocument: sourceDocumentToolset.tool,
        ...viewToolset.tools,
        ...objectManagementToolset.tools,
        ...libraryToolset.tools,
        openArtifactKnowledge,
        queueChatAssertionCapture: assertionQueueToolset.tool,
        submitTurnHandoff,
      };
      const alwaysAvailableToolNames = [
        "searchMemory",
        "readMemoryWriteStatus",
        TURN_HANDOFF_TOOL,
      ];
      const exposedToolNames = [
        ...capabilityGatewayToolNames,
        ...alwaysAvailableToolNames,
      ].filter((name) =>
        Boolean(allTools[name])
      );
      const stepSystem = () => {
        const enabledDetails = [...new Set([
          ...detailedToolNames(openedCapabilities),
          ...alwaysAvailableToolNames,
        ])]
          .filter((name) => Boolean(allTools[name]));
        if (!enabledDetails.length) {
          return [
            exploreSystem,
            groundingState.instruction(),
          ].filter(Boolean).join("\n\n");
        }
        const preferredKnowledgeLayer = openedCapabilities.artifacts &&
            !openedCapabilities.businessContext && !openedCapabilities.sharedBrain
          ? "library" as const
          : openedCapabilities.businessContext
            ? "business_view" as const
            : openedCapabilities.sharedBrain
              ? "shared_brain" as const
              : "unknown" as const;
        return [
          exploreSystem,
          buildCapabilityInstructions({
            preferredKnowledgeLayer,
            toolNames: enabledDetails,
          }),
          groundingState.instruction(),
        ].join("\n\n");
      };
      await debugTrace.appendJsonSection("本轮工具暴露", {
        exposedToolNames,
        note: "首次调用提供三个类别入口、主题语义搜索、记忆状态与 Handoff；其他详细工具按需开放。",
      });
      const result = streamText({
        model,
        system: stepSystem(),
        messages: context.messages,
        tools: allTools,
        toolChoice: "auto",
        stopWhen: [
          stepCountIs(MAX_EXPLORE_STEPS),
          ({ steps }) => {
            const finalStep = steps.at(-1);
            if (!finalStep?.text.trim()) return false;
            // Handoff is optional knowledge-review metadata, not a completion
            // gate. Continue only when this step also requested real work.
            return finalStep.toolCalls.every(
              (call) => call.toolName === TURN_HANDOFF_TOOL,
            );
          },
        ],
        prepareStep: ({ stepNumber, messages: stepMessages }) => {
          const instructions = stepSystem();
          if (stepNumber === MAX_EXPLORE_STEPS - 1 || exploreResultTokenBudget === 0) {
            return {
              ...(stepNumber > 0
                ? { messages: compactExploreStepMessages(stepMessages) }
                : {}),
              activeTools: [] as const,
              toolChoice: "none" as const,
              instructions: stepNumber === MAX_EXPLORE_STEPS - 1
                ? `${instructions}\n\n${FINAL_ANSWER_INSTRUCTION}`
                : instructions,
            };
          }
          return {
            ...(stepNumber > 0
              ? { messages: compactExploreStepMessages(stepMessages) }
              : {}),
            activeTools: [
              ...activeCapabilityToolNames(openedCapabilities),
              ...alwaysAvailableToolNames,
            ]
              .filter((name) => Boolean(allTools[name])),
            toolChoice: "auto" as const,
            instructions,
          };
        },
        temperature: 0.3,
        maxOutputTokens: profile.maxOutputTokens,
        abortSignal: request.signal,
        onLanguageModelCallStart: async (event) => {
          mainModelCallNumber += 1;
          if (mainModelCallNumber === 1) {
            exposedToolSchemaBytes = new TextEncoder().encode(
              debugJson(event.tools ?? []),
            ).length;
          }
          mainModelCalls.push({
            callId: event.callId,
            callNumber: mainModelCallNumber,
            instructions: typeof event.instructions === "string"
              ? event.instructions
              : debugJson(event.instructions),
            messages: renderDebugMessages(event.messages),
          });
          const instructions = typeof event.instructions === "string"
            ? debugCodeBlock(event.instructions)
            : debugCodeBlock(debugJson(event.instructions), "json");
          await debugTrace.appendSection(
            `主回答模型调用 ${mainModelCallNumber} · 实际输入`,
            [
              `- Provider：\`${event.provider}\``,
              `- Model：\`${event.modelId}\``,
              `- Call ID：\`${event.callId}\``,
              `- Temperature：${event.temperature ?? "默认"}`,
              `- 最大输出 tokens：${event.maxOutputTokens ?? "默认"}`,
              "",
              "### System / Instructions",
              "",
              instructions,
              "",
              "### Messages",
              "",
              renderDebugMessages(event.messages),
              "",
              "### 本次可用工具",
              "",
              renderDebugTools(event.tools),
            ].join("\n"),
          );
        },
        onLanguageModelCallEnd: async (event) => {
          const transcript = mainModelCalls.find((call) => call.callId === event.callId);
          if (transcript) transcript.output = renderDebugModelOutput(event.content);
          await debugTrace.appendSection(
            `主回答模型调用 ${mainModelCallNumber} · 实际输出`,
            [
              `- Provider：\`${event.provider}\``,
              `- Model：\`${event.modelId}\``,
              `- Call ID：\`${event.callId}\``,
              `- Finish reason：\`${String(event.finishReason)}\``,
              `- 响应耗时：${event.performance.responseTimeMs} ms`,
              "- Token usage：",
              "",
              debugCodeBlock(debugJson(event.usage), "json"),
              "",
              "### 模型返回内容",
              "",
              renderDebugModelOutput(event.content),
            ].join("\n"),
          );
        },
        onToolExecutionEnd: async (event) => {
          const output = event.toolOutput.type === "tool-result"
            ? event.toolOutput.output
            : event.toolOutput.error;
          const toolName = event.toolCall.toolName;
          if (toolName === "listLibrary" || toolName === "openArtifacts") {
            libraryQueryCount += 1;
          }
          if (toolName === "searchMemory" || toolName === "expandEvidence") {
            memoryQueryCount += 1;
          }
          if (event.toolOutput.type === "tool-result") {
            const toolLayer = toolName === "readView" || toolName === "openBusinessContext"
              ? "business_view"
              : toolName === "searchMemory" || toolName === "expandEvidence" ||
                  toolName === "followObject"
                ? "shared_brain"
                : toolName === "readSourceDocument"
                  ? "source_document"
                  : [
                      "listLibrary",
                      "inspectLibraryNodes",
                      "previewLibraryFiles",
                      "readLibraryCompilation",
                      "openArtifacts",
                      "openArtifactKnowledge",
                    ].includes(toolName)
                    ? "library"
                    : undefined;
            if (toolLayer) {
              firstAuthoritativeTool ??= toolName;
              sourceLayersUsed.add(toolLayer);
            }
            if (toolName === "listLibrary" || toolName === "openArtifacts") {
              const libraryResult = objectValue(output);
              if (typeof libraryResult?.matchedCount === "number") {
                libraryMatchedCount = Math.max(
                  libraryMatchedCount,
                  libraryResult.matchedCount,
                );
              } else if (Array.isArray(libraryResult?.items)) {
                libraryMatchedCount = Math.max(
                  libraryMatchedCount,
                  libraryResult.items.length,
                );
              }
              if (typeof libraryResult?.truncated === "boolean") {
                libraryQueryTruncated = libraryResult.truncated;
              }
            }
          }
          const semanticToolOutput = ["searchMemory", "expandEvidence", "followObject"]
              .includes(toolName)
            ? { note: "完整合并结果见本轮 retrieval snapshot。" }
            : toolName === "openBusinessContext" && objectValue(output)
              ? (() => {
                  const businessResult = objectValue(output)!;
                  const view = objectValue(businessResult.view);
                  return {
                    viewKey: view?.viewKey,
                    viewHigherMemory: businessResult.viewHigherMemory,
                    relevantCards: businessResult.relevantCards,
                    formalCardMissing: businessResult.formalCardMissing,
                    unresolvedAspects: businessResult.unresolvedAspects,
                    semantics: businessResult.semantics,
                    next: businessResult.next,
                  };
                })()
              : output;
          mainToolExecutions.push({
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            input: event.toolCall.input,
            output: semanticToolOutput,
            success: event.toolOutput.type === "tool-result",
          });
          await debugTrace.appendSection(
            `工具执行 · ${event.toolCall.toolName}`,
            [
              `- Tool call ID：\`${event.toolCall.toolCallId}\``,
              `- 执行结果：${event.toolOutput.type === "tool-result" ? "成功" : "失败"}`,
              `- 执行耗时：${event.toolExecutionMs} ms`,
              "",
              "### 输入参数",
              "",
              debugCodeBlock(debugJson(event.toolCall.input), "json"),
              "",
              "### 输出结果",
              "",
              debugCodeBlock(debugJson(output), "json"),
            ].join("\n"),
          );
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
        onFinish: async ({ text, finishReason, totalUsage, steps }) => {
          finalRawText = text;
          finalAudit = auditGroundedAnswer({
            text,
            contract: groundingState.contract(),
            validRefs: validReferenceRefs(),
          });
          const finalAnswer = finalAudit.text;
          await debugTrace.appendSection(
            "主回答完成",
            [
              `- Finish reason：\`${String(finishReason)}\``,
              "- 总 token usage：",
              "",
              debugCodeBlock(debugJson(totalUsage), "json"),
              "",
              "### 模型原始回答",
              "",
              debugCodeBlock(text),
              "",
              "### Grounding Gate",
              "",
              debugCodeBlock(debugJson({
                contract: groundingState.contract(),
                changed: finalAudit.changed,
                mode: finalAudit.mode,
                issues: finalAudit.issues,
              }), "json"),
              "",
              "### 实际发送回答",
              "",
              debugCodeBlock(finalAnswer),
            ].join("\n"),
          );
          const citedSourceReferences = sourceDocumentToolset.citedReferences(finalAnswer);
          if (citedSourceReferences.references.length) {
            writer.write({
              type: "data-sourceReferences",
              data: citedSourceReferences,
            });
          }
          const citedViewReferences = viewToolset.citedReferences(finalAnswer);
          if (citedViewReferences.references.length) {
            writer.write({
              type: "data-viewReferences",
              data: citedViewReferences,
            });
          }
          const citedArtifactReferences = artifactReferences.citedReferences(finalAnswer);
          if (citedArtifactReferences.references.length) {
            writer.write({
              type: "data-artifactReferences",
              data: citedArtifactReferences,
            });
          }
          const accumulatedRetrieval = evidence.snapshot();
          const assertionQueueDecision = assertionQueueToolset.decision();
          const foregroundAssertionDecision = assertionQueueToolset.foregroundDecision();
          const foregroundAssertionResult = assertionQueueToolset.foregroundResult();
          const handoffCall = steps
            .flatMap((step) => step.toolCalls)
            .findLast((call) => call.toolName === TURN_HANDOFF_TOOL);
          const parsedHandoff = turnHandoffSchema.safeParse(handoffCall?.input);
          const handoff = parsedHandoff.success ? parsedHandoff.data : undefined;
          const handoffIsValid = Boolean(
            handoff &&
              handoff.candidateQuotes.every((quote) => query.includes(quote)) &&
              (handoff.reviewNeeded
                ? handoff.candidateQuotes.length > 0
                : handoff.candidateQuotes.length === 0),
          );
          const reviewNeeded = handoffIsValid && Boolean(handoff?.reviewNeeded);
          const candidateQuotes = handoffIsValid
            ? handoff!.candidateQuotes
            : [];
          await debugTrace.appendJsonSection("Turn Handoff", {
            valid: handoffIsValid,
            reviewNeeded,
            candidateQuotes,
            fallbackReason: handoffIsValid
              ? null
              : "未提交有效 Handoff；本轮跳过自动知识审查，避免未验证内容回灌。",
          });
          const semanticContext = {
            conversation: semanticConversation.slice(-8),
            systemInstruction: "",
            pageContext,
            modelCalls: [],
            toolExecutions: mainToolExecutions,
            finalAnswer,
          };
          const automaticWritebackDecision = !foregroundAssertionResult && reviewNeeded
            ? {
                reason: candidateQuotes.length
                  ? `主模型 Handoff 建议审查用户原话：${candidateQuotes.join("；")}`
                  : "主模型 Handoff 缺失、无效或判断本轮可能包含值得审查的组织知识。",
              }
            : undefined;
          const backgroundAssertionDecision = assertionQueueDecision ?? automaticWritebackDecision;
          const consolidationNeeded = Boolean(
            foregroundAssertionResult || backgroundAssertionDecision,
          );
          const receiptKey = latestUserMessage
            ? {
                actorId: requestActor.id,
                clientMessageId: latestUserMessage.id,
              }
            : undefined;
          const assertionInput = (queueDecision: { reason: string }) => ({
              actor: requestActor,
              conversationId,
              clientMessageId: latestUserMessage!.id,
              submittedAt: submittedAt.toISOString(),
              timezone: requestTimezone,
              semanticContext,
              retrieval: accumulatedRetrieval,
              queueDecision,
            });
          const consolidationInput = latestUserMessage && consolidationNeeded
            ? {
                actorId: requestActor.id,
                actorDisplayName: requestActor.displayName,
                clientMessageId: latestUserMessage.id,
                submittedAt: submittedAt.toISOString(),
                timezone: requestTimezone,
                semanticContext,
                retrieval: accumulatedRetrieval,
              }
            : undefined;
          let writebackStatus = !reviewNeeded
            ? handoffIsValid ? "skipped_by_handoff" : "skipped_invalid_handoff"
            : "eligible";
          let durableBackgroundJob = false;
          let writebackPersistenceDurationMs = 0;
          if (latestUserMessage && backgroundAssertionDecision) {
            const persistentInput = assertionInput(backgroundAssertionDecision);
            const persistenceStartedAt = performance.now();
            try {
              await queueChatAssertionReceipt({
                actorId: requestActor.id,
                actorDisplayName: requestActor.displayName,
                clientMessageId: latestUserMessage.id,
                submittedAt: persistentInput.submittedAt,
                execution: "background",
                queueReason: backgroundAssertionDecision.reason,
                conversationId,
                timezone: requestTimezone,
                semanticContext,
                retrieval: accumulatedRetrieval,
              });
              durableBackgroundJob = true;
              writebackStatus = "queued_persisted";
            } catch (error) {
              writebackStatus = "persistence_failed";
              console.error("[chat.assertion-job.persist]", error);
              await debugTrace.appendError("持久化 Assertion 写回任务失败", error);
              try {
                await failChatAssertionReceipt({
                  actorId: requestActor.id,
                  clientMessageId: latestUserMessage.id,
                }, error);
              } catch (receiptError) {
                console.error("[chat.assertion-job.persist-failed-receipt]", receiptError);
                await debugTrace.appendError(
                  "Assertion 写回任务失败状态落库失败",
                  receiptError,
                );
              }
            } finally {
              writebackPersistenceDurationMs = Math.round(
                performance.now() - persistenceStartedAt,
              );
            }
          } else if (foregroundAssertionResult) {
            writebackStatus = "completed_foreground";
          }

          const hasBackgroundWork = Boolean(
            latestUserMessage && backgroundAssertionDecision && durableBackgroundJob,
          );
          const hasForegroundWork = Boolean(
            latestUserMessage && foregroundAssertionResult && foregroundAssertionDecision,
          );
          const hasConsolidationWork = Boolean(consolidationInput);
          if (latestUserMessage && (hasBackgroundWork || hasForegroundWork || hasConsolidationWork)) {
            memoryMaintenance.publish({
              ...(hasBackgroundWork && receiptKey
                ? {
                    assertionReceipt: receiptKey,
                  }
                : {}),
              ...(hasBackgroundWork && receiptKey
                ? { assertionJob: receiptKey }
                : {}),
              ...(foregroundAssertionResult && foregroundAssertionDecision
                ? {
                    completedAssertion: {
                      input: assertionInput(foregroundAssertionDecision),
                      result: foregroundAssertionResult,
                    },
                  }
                : {}),
              ...(consolidationInput ? { consolidation: consolidationInput } : {}),
            });
          } else {
            await debugTrace.appendSection(
              "Assertion 入口判断",
              writebackStatus === "persistence_failed"
                ? "结果：本轮值得尝试写回，但持久化任务失败，未启动不可恢复的局部后台任务。"
                : "结果：服务端事后门控未登记 Assertion 写回任务。",
            );
            await debugTrace.appendSection(
              "Higher Memory 入口判断",
              "结果：本轮没有新事实审查意图，也没有实际打开知识或业务能力，因此不启动 Consolidator。",
            );
            memoryMaintenance.cancel(
              "本轮没有可执行的 Assertion 或 Higher Memory Consolidation 工作。",
            );
          }
          const answerSourceLayers = new Set<string>();
          if (citedRefs(finalAnswer, "V").length) answerSourceLayers.add("business_view");
          if (citedRefs(finalAnswer, "H").length || citedRefs(finalAnswer, "A").length) {
            answerSourceLayers.add("shared_brain");
          }
          if (citedRefs(finalAnswer, "S").length) answerSourceLayers.add("source_document");
          if (libraryQueryCount > 0) {
            answerSourceLayers.add("library");
          }
          if (!answerSourceLayers.size && sourceLayersUsed.size === 1) {
            sourceLayersUsed.forEach((layer) => answerSourceLayers.add(layer));
          }
          const sourceLayerUsedForAnswer = answerSourceLayers.size
            ? [...answerSourceLayers].join("+")
            : "none";
          const fileExistenceClaim = libraryMatchedCount > 0
            ? "found"
            : libraryQueryCount > 0 && libraryQueryTruncated === false
              ? "not_found_in_index"
              : "unknown";
          const fileExistenceEvidence = libraryQueryCount === 0
            ? "none"
            : libraryQueryTruncated === false
              ? "library_complete_query"
              : "library_partial_query";
          await debugTrace.appendJsonSection("Turn Runtime Summary", {
            prefetchedViewKeys: [],
            exposedToolNames,
            exposedToolCount: exposedToolNames.length,
            finalActiveToolNames: [
              ...activeCapabilityToolNames(openedCapabilities),
              ...alwaysAvailableToolNames,
            ],
            openedCapabilities: {
              businessContext: openedCapabilities.businessContext,
              artifacts: openedCapabilities.artifacts,
              sharedBrain: openedCapabilities.sharedBrain,
              actionAreas: [...openedCapabilities.actionAreas],
            },
            exposedToolSchemaBytes,
            firstAuthoritativeTool: firstAuthoritativeTool ?? null,
            libraryQueryCount,
            memoryQueryCount,
            libraryQueryTruncated: libraryQueryTruncated ?? null,
            libraryMatchedCount,
            mainModelCallCount: mainModelCallNumber,
            sourceLayerUsedForAnswer,
            fileExistenceClaim,
            fileExistenceEvidence,
            writebackEligibility: reviewNeeded ? "possible" : "none",
            handoffValid: handoffIsValid,
            handoffCandidateCount: candidateQuotes.length,
            writebackStatus,
            viewPrefetchDurationMs: 0,
            writebackPersistenceDurationMs,
          });
          const usedRefs = citedAssertionRefs(finalAnswer, accumulatedRetrieval.seedMap);
          const usedHigherMemoryRefs = citedRefs(finalAnswer, "H")
            .filter((ref, index, refs) =>
              (accumulatedRetrieval.seedMap.higherMemories ?? []).some((item) => item.ref === ref) &&
              refs.indexOf(ref) === index
            );
          if (hasSearchedMemory) {
            const returnedAssertionIds = new Set(
              accumulatedRetrieval.seedMap.assertions.flatMap((assertion) =>
                assertion.id ? [assertion.id] : []
              ),
            );
            const returnedObjectIds = new Set(
              accumulatedRetrieval.seedMap.objects.map((object) => object.id),
            );
            await debugTrace.appendSection(
              "Retrieval Curator · 本轮检索利用率",
              [
                `- 进入主对话的去重 Object：${returnedObjectIds.size}`,
                `- 进入主对话的去重 Assertion：${returnedAssertionIds.size}`,
                `- 最终引用的 Assertion：${usedRefs.length}`,
                `- 未被最终回答引用：${Math.max(0, returnedAssertionIds.size - usedRefs.length)}`,
                usedRefs.length
                  ? `- 最终引用 refs：${usedRefs.join("、")}`
                  : "- 最终引用 refs：无",
                "> 未引用不等于无效；冲突、限定与供模型排除的证据也可能是必要上下文。",
              ].join("\n"),
            );
          }
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
              data: searchBundle(
                citedRetrieval,
                usedRefs,
                usedHigherMemoryRefs,
                latestLocateTrace,
                groundingState.contract().coverageByLayer,
              ),
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

      const modelUIStream = result.toUIMessageStream({
        sendReasoning: true,
        onError: (error) => {
          console.error(
            "[chat.model-stream]",
            JSON.stringify(safeStreamErrorSummary(error)),
          );
          void debugTrace.appendError("主回答模型流失败", error);
          return "AI 服务响应失败，请稍后重试。";
        },
      });
      writer.merge(bufferFinalAnswerStream(modelUIStream, (rawText) =>
        auditAnswer(rawText).text
      ));
    },
    onEnd: async ({ messages: completedMessages, responseMessage }) => {
      const persistedResponse = withoutTurnHandoff(responseMessage);
      if (!modelHistoryMessageText(persistedResponse).trim()) return;
      const responsePosition = completedMessages.findLastIndex(
        (message) => message.id === responseMessage.id,
      );
      if (responsePosition < 0) return;

      try {
        await saveChatMessage({
          actor: requestActor,
          conversationId,
          message: persistedResponse,
          position: responsePosition,
        });
      } catch (error) {
        console.error("[chat.history.write-assistant]", error);
        await debugTrace.appendError("保存助手消息失败", error);
      }
    },
    onError: (error) => {
      console.error(
        "[chat.ui-stream]",
        JSON.stringify(safeStreamErrorSummary(error)),
      );
      void debugTrace.appendError("Chat UI 流失败", error);
      memoryMaintenance.cancel("主回答流失败，因此后台记忆线路未启动。");
      return "AI 服务响应失败，请稍后重试。";
    },
  });

  return createUIMessageStreamResponse({ stream });
}
