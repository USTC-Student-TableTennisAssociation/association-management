import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  getToolName,
  isToolUIPart,
  type ModelMessage,
  pruneMessages,
  safeValidateUIMessages,
  streamText,
  tool,
  type ToolSet,
  zodSchema,
} from "ai";
import { z } from "zod";

import {
  latestUserQuery,
  messageText,
} from "@/ai/chat-policy";
import { citedRefs } from "@/ai/citation-refs";
import {
  buildAnswerRepairPrompt,
  verificationFailureAnswer,
  verifyGroundedAnswer,
  type AnswerVerification,
} from "@/ai/answer-verifier";
import { ANSWER_PRESENTATION_INSTRUCTIONS } from "@/ai/answer-presentation";
import { governFinalAnswerStream } from "@/ai/answer-stream-governor";
import {
  createCapabilityGatewayTools,
  createOpenedCapabilities,
  TURN_KERNEL_INSTRUCTIONS,
} from "@/ai/capability-gates";
import { CapabilityLedger } from "@/ai/capability-ledger";
import { aiInvocationSchema } from "@/ai/ai-invocation";
import {
  evaluateAgentRunGuard,
  incompleteRunInstruction,
  type AgentRunInterruptionReason,
} from "@/ai/agent-run-guard";
import { buildCapabilityInstructions } from "@/ai/capability-instructions";
import { ContextPackingError, packContext } from "@/ai/context-packer";
import { buildCurrentTimeInstruction } from "@/ai/current-time-context";
import {
  createDebugTrace,
  debugCodeBlock,
  debugJson,
  renderDebugMessages,
  renderDebugModelOutput,
  renderDebugTools,
} from "@/ai/debug-trace";
import { createModelProfile } from "@/ai/model-profile";
import { getChatModel } from "@/ai/provider";
import {
  chatStreamStatusSchema,
  classifyChatStreamFailureCode,
  classifyChatStreamStatus,
  createModelCallAttemptTracker,
  summarizeChatStreamError,
  type ChatStreamObservation,
} from "@/ai/chat-stream-status";
import { ToolResultTokenBudget } from "@/ai/tool-result-budget";
import {
  buildRuntimeAnswerContract,
  runtimeAnswerContractInstruction,
} from "@/ai/runtime-answer-contract";
import { compileActiveToolNames } from "@/ai/tool-policy";
import type { ChatPageContext, ClubChatMessage } from "@/ai/types";
import { modelHistoryMessageText } from "@/ai/ui-message-text";
import { buildViewCatalogContext } from "@/agent-runtime/view-catalog";
import { createViewStateRuntime } from "@/agent-runtime/view-state-runtime";
import { createAgentViewToolset, registeredViewKeySchema } from "@/agent-runtime/view-toolset";
import { createAgentToolProviderToolset } from "@/agent-runtime/tool-provider-toolset";
import {
  AgentSkillSession,
  createAgentSkillToolset,
} from "@/agent-runtime/skill-runtime";
import {
  viewCommandProposalNoticeSchema,
  viewReferenceBundleSchema,
} from "@/agent-runtime/view-types";
import { currentAuthUser } from "@/auth/session";
import { getDatabase } from "@/db";
import {
  extensionRegistry,
  toolRuntime,
  viewCommandBus,
  viewReadPort,
} from "@/shell/composition-root";
import { hasPersistableChatContent, saveChatMessage } from "@/chat/persistence";
import {
  artifactSearchEvidenceSemantics,
  retrievalEvidenceSemantics,
} from "@/evidence/tool-semantics";
import { TurnEvidenceContext } from "@/evidence/turn-context";
import {
  findArtifactsByTitle,
  getArtifactPublishedKnowledge,
} from "@/library/artifact-knowledge";
import { artifactReferenceBundleSchema } from "@/library/artifact-reference-ui-schema";
import { createArtifactReferenceRegistry } from "@/library/artifact-references";
import { createLibraryToolset } from "@/library/toolset";
import { libraryPlanPresentationSchema } from "@/library/ui-schema";
import { createKnowledgeEnvironmentTool } from "@/knowledge-environment/toolset";
import {
  citedAssertionRefs,
  hydrateCitedSourceExcerpts,
} from "@/memory/citation-sources";
import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import {
  captureChatAssertions,
  environmentTimezone,
  type ChatAssertionCaptureResult,
  type ChatMainModelCall,
  type ChatMainToolExecution,
  type ChatSemanticMessage,
} from "@/memory/chat-assertion";
import { createChatAssertionQueueTool } from "@/memory/chat-assertion-queue";
import {
  claimChatAssertionReceipt,
  completeChatAssertionReceipt,
  createMemoryWriteStatusTool,
  failChatAssertionReceipt,
  queueChatAssertionReceipt,
} from "@/memory/chat-assertion-receipt";
import {
  createChatMemoryMaintenanceScheduler,
  resumePendingChatAssertionReceipts,
} from "@/memory/chat-assertion-lifecycle";
import {
  loadAmbientHigherMemories,
  type AmbientHigherMemorySnapshot,
} from "@/memory/ambient-higher-memory";
import {
  emptyActorPrivateMemory,
  loadActorPrivateMemory,
  type ActorPrivateMemorySnapshot,
} from "@/memory/actor-higher-memory";
import {
  createActorHigherMemoryQueueTool,
} from "@/memory/actor-higher-memory-queue";
import { createActorHigherMemoryWriteToolset } from "@/memory/actor-higher-memory-write";
import { createMemoryExploreToolset } from "@/memory/explore-toolset";
import {
  addObjectTargetsToQueueDecision,
  createHigherMemoryQueueTool,
} from "@/memory/higher-memory-queue";
import { getMemoryRetriever } from "@/memory/retriever";
import { createObjectManagementToolset } from "@/memory/object-management-toolset";
import { objectChangeProposalPresentationSchema } from "@/memory/object-management-types";
import { createSourceDocumentToolset } from "@/memory/source-document-toolset";
import { sourceDocumentReferenceBundleSchema } from "@/memory/source-document-ui-schema";
import { memorySearchBundleSchema } from "@/memory/ui-schema";
import type {
  EvidenceCoverageByLayer,
  MemoryRetrievalResult,
  MemorySearchBundle,
  MemorySearchTrace,
} from "@/memory/types";
import { emptySeedMap } from "@/memory/types";

export const maxDuration = 3_600;

const EXPLORE_PROTOCOL_RESERVE_TOKENS = 4_000;
const LEGACY_TURN_HANDOFF_TOOL = "submitTurnHandoff";

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function isContextCapacityError(error: unknown): boolean {
  const record = objectValue(error);
  const name = error instanceof Error
    ? error.name
    : typeof record?.name === "string"
      ? record.name
      : "";
  return name === "MemoryExploreContextBudgetError" ||
    name === "SourceDocumentContextBudgetError";
}

function withoutTurnHandoff(message: ClubChatMessage): ClubChatMessage {
  return {
    ...message,
    parts: message.parts.filter((part) =>
      !isToolUIPart(part) || getToolName(part) !== LEGACY_TURN_HANDOFF_TOOL
    ),
  };
}

const pageContextSchema = z.object({
  activeViewKey: registeredViewKeySchema(extensionRegistry).optional(),
  activePresentation: z.enum(["work", "inspector", "full_chat", "knowledge", "library"]),
  activeFolderId: z.string().uuid().optional(),
  activeCardId: z.string().uuid().optional(),
  activeNodeId: z.string().uuid().optional(),
  activeObjectName: z.string().trim().min(1).max(200).optional(),
}).refine(
  (context) => ["full_chat", "knowledge", "library"].includes(context.activePresentation) || Boolean(context.activeViewKey),
  { message: "Business View presentation 必须提供 activeViewKey" },
);

function pageContextInstruction(context?: ChatPageContext): string {
  if (!context || context.activePresentation === "full_chat") {
    return "页面 soft context：用户当前位于全屏 AI 对话。不要因此限制 Shared Brain 检索范围。";
  }
  if (context.activePresentation === "knowledge") {
    return "页面 soft context：用户当前正在查看 Knowledge Graph。这只用于理解当前工作位置；图谱可帮助选择检索方向，但不能替代本轮实际读取的事实证据。";
  }
  if (context.activePresentation === "library") {
    return [
      `页面 soft context：用户当前正在查看资料库${context.activeFolderId ? `，当前文件夹 id 为 ${context.activeFolderId}` : ""}。`,
      "这只用于理解当前工作位置；文件索引不是事实证据。",
    ].join("\n");
  }
  return [
    context.activePresentation === "inspector"
      ? `页面 soft context：用户当前正在查看 ${context.activeViewKey} 的高级只读 Generic View Inspector。`
      : `页面 soft context：用户当前正在查看 Work View ${context.activeViewKey}。`,
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
    user.actorObject
      ? `用户对自身的指称对应已认证 Actor Object“${user.actorObject.canonicalName}”；内部 ID 由服务端处理。`
      : "当前账号尚未关联 Actor Object，不要猜测用户对自身的指称对应哪个 Object。",
  ].join("\n");
}

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
      memorySearch: zodSchema(memorySearchBundleSchema),
      aiInvocation: zodSchema(aiInvocationSchema),
      sourceReferences: zodSchema(sourceDocumentReferenceBundleSchema),
      artifactReferences: zodSchema(artifactReferenceBundleSchema),
      viewReferences: zodSchema(viewReferenceBundleSchema),
      viewCommandProposal: zodSchema(viewCommandProposalNoticeSchema),
      objectChangeProposal: zodSchema(objectChangeProposalPresentationSchema),
      libraryProposal: zodSchema(libraryPlanPresentationSchema),
      streamStatus: zodSchema(chatStreamStatusSchema),
    },
  });
  if (!validation.success) return jsonError("消息格式错误。", 400);

  const messages = validation.data;
  const query = latestUserQuery(messages);
  if (!query) return jsonError("消息内容不能为空。", 400);
  const latestUserMessageIndex = messages.findLastIndex((message) => message.role === "user");
  const latestUserMessage = messages[latestUserMessageIndex];
  const invocationParts = latestUserMessage?.parts.filter((part) =>
    part.type === "data-aiInvocation"
  ) ?? [];
  if (invocationParts.length > 1) return jsonError("一条消息只能发起一个 AI Action。", 400);
  const requestedInvocation = invocationParts[0]?.data;
  if (requestedInvocation && requestedInvocation.message !== query.trim()) {
    return jsonError("AI Action 的可见意图与用户消息不一致。", 400);
  }
  const submittedAt = new Date();
  let requestTimezone: string;
  const requestActor = authenticatedUser.actor;
  try {
    requestTimezone = environmentTimezone();
  } catch (error) {
    console.error("[chat.time-context.config]", error);
    return jsonError("环境时区或 Actor 配置无效，请联系管理员。", 500);
  }
  const debugTrace = createDebugTrace({
    clientMessageId: latestUserMessage?.id ?? "unknown-message",
    submittedAt,
    timezone: requestTimezone,
    actorId: requestActor.id,
    actorDisplayName: requestActor.displayName,
    userMessage: query,
    pageContext,
  });
  const skillSession = new AgentSkillSession(extensionRegistry, toolRuntime);
  if (requestedInvocation?.skill) {
    try {
      const activation = skillSession.activate(
        requestedInvocation.skill.id,
        requestedInvocation.skill.input,
      );
      if (pageContext?.activeViewKey && !skillSession.canReadView(pageContext.activeViewKey)) {
        return jsonError(
          `Skill ${activation.extension.id} 不允许从当前 View ${pageContext.activeViewKey} 发起。`,
          400,
        );
      }
      await debugTrace.appendJsonSection("Skill 预激活", {
        actionId: requestedInvocation.actionId,
        id: activation.extension.id,
        version: activation.extension.version,
        input: activation.input,
        viewAccess: activation.extension.viewAccess,
        resourceAccess: activation.extension.resourceAccess ?? [],
      });
    } catch (error) {
      await debugTrace.appendError("Skill 预激活失败", error);
      return jsonError(error instanceof Error ? error.message : "Skill 无法激活。", 400);
    }
  }
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
  const conversationUserMessages = semanticConversation
    .filter((message) => message.role === "user")
    .map((message) => ({
      messageId: message.messageId,
      text: message.text,
    }));
  const memoryMaintenance = createChatMemoryMaintenanceScheduler(debugTrace);
  await resumePendingChatAssertionReceipts({ actorId: requestActor.id });
  let actorPrivateMemory: ActorPrivateMemorySnapshot = emptyActorPrivateMemory();
  try {
    actorPrivateMemory = await loadActorPrivateMemory(requestActor.id);
    await debugTrace.appendJsonSection("主 Chat 自动加载的 Actor 私有记忆", {
      higherMemoryScopes: actorPrivateMemory.higherMemories.map((item) => item.scope),
      note: "调试摘要不复制 Actor 私有 Higher Memory 正文。",
    });
  } catch (error) {
    console.error("[chat.actor-private-memory.load]", error);
    await debugTrace.appendError("Actor 私有记忆加载失败", error);
  }
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
  const viewCatalogContext = buildViewCatalogContext(extensionRegistry);

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
      actorPrivateMemory,
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
      const turnEvidence = new TurnEvidenceContext(pageContext);
      const capabilityLedger = new CapabilityLedger();
      if (actorPrivateMemory.higherMemories.length > 0) {
        turnEvidence.observeActorPrivateMemory();
      }
      const artifactReferences = createArtifactReferenceRegistry();
      const openedCapabilities = createOpenedCapabilities();
      const skillToolset = createAgentSkillToolset({
        session: skillSession,
        onActivate: (activation) => {
          void debugTrace.appendJsonSection("Skill 激活", {
            id: activation.extension.id,
            version: activation.extension.version,
            input: activation.input,
            viewAccess: activation.extension.viewAccess,
            resourceAccess: activation.extension.resourceAccess ?? [],
            activeSkills: skillSession.activeSkillIds(),
          });
        },
      });
      let mainModelCallNumber = 0;
      let exposedToolSchemaBytes = 0;
      let firstAuthoritativeTool: string | undefined;
      let libraryQueryCount = 0;
      let memoryQueryCount = 0;
      let libraryQueryTruncated: boolean | undefined;
      let libraryMatchedCount = 0;
      const sourceLayersUsed = new Set<string>();
      const higherMemoryQueueToolset = createHigherMemoryQueueTool({
        trace: debugTrace,
        hasObject: (globalObjectId) => evidence.hasObject(globalObjectId),
        canQueueAmbient: () => {
          const snapshot = evidence.snapshot();
          return ambientHigherMemories.length > 0 ||
            snapshot.seedMap.assertions.length > 0 ||
            Boolean(snapshot.seedMap.higherMemories?.length) ||
            sourceLayersUsed.has("business_view") ||
            sourceLayersUsed.has("source_document");
        },
      });
      const mainModelCalls: ChatMainModelCall[] = [];
      const mainToolExecutions: ChatMainToolExecution[] = [];
      const sharedResultBudget = new ToolResultTokenBudget(exploreResultTokenBudget);
      let hasSearchedMemory = false;
      const coldHigherMemoryTargetIds = new Set<string>();
      let latestLocateTrace: MemorySearchTrace | undefined;
      let proposalReceiptCount = 0;
      let viewCommandAttemptCount = 0;
      let finalRawText = "";
      let finalAnswer = "";
      let finalVerification: AnswerVerification | undefined;
      let verificationRepairAttempted = false;
      let verificationRepairSucceeded = false;
      let answerWasStreamed = false;
      let streamedVerificationWarning = false;
      const actorHigherMemoryWriteToolset = createActorHigherMemoryWriteToolset({
        actorId: requestActor.id,
        currentMessageId: latestUserMessage.id,
        currentUserMessage: query,
        trace: debugTrace,
        onCommitted: (summary) => {
          if (summary.replacedScopes.length + summary.clearedScopes.length > 0) {
            turnEvidence.observeDurableMemoryWrite();
          }
          if (summary.replacedScopes.length > 0) {
            turnEvidence.observeActorPrivateMemory();
          }
        },
      });
      const actorHigherMemoryQueueToolset = createActorHigherMemoryQueueTool({
        trace: debugTrace,
      });
      const streamObservation: ChatStreamObservation = {
        reasoningChars: 0,
        contentChars: 0,
        toolCallCount: 0,
        modelCallCount: 0,
        retryCount: 0,
        streamEnded: false,
      };
      let runInterruption: {
        reason: AgentRunInterruptionReason;
        detail: string;
      } | undefined;
      const interruptRun = (
        reason: AgentRunInterruptionReason,
        detail: string,
      ) => {
        if (runInterruption) return;
        runInterruption = { reason, detail };
        streamObservation.interruptionReason = runInterruption.reason;
        void debugTrace.appendJsonSection("Agent RunGuard 熔断", runInterruption);
      };
      const modelCallAttempts = createModelCallAttemptTracker();
      let currentStepTextChars = 0;
      let lastCompletedStepTextChars = 0;
      let lastStreamStatusJson: string | undefined;
      const writeStreamStatus = () => {
        const status = classifyChatStreamStatus(streamObservation);
        const statusJson = JSON.stringify(status);
        if (statusJson === lastStreamStatusJson) return;
        lastStreamStatusJson = statusJson;
        writer.write({ type: "data-streamStatus", data: status });
        void debugTrace.appendJsonSection("Chat Stream Status", status);
      };
      const memoryTools = createMemoryExploreToolset({
        evidence,
        resultTokenBudget: exploreResultTokenBudget,
        sharedResultBudget,
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
          openedCapabilities.sharedBrain = true;
          hasSearchedMemory = true;
          turnEvidence.observeSharedBrainTarget();
          if (discovered.coverage) {
            turnEvidence.observeCoverage({
              layer: "shared_brain",
              scope: discovered.globalObjectId
                ? `object:${discovered.globalObjectId}`
                : `query:${discovered.query ?? discovered.focus ?? "unknown"}`,
              coverage: discovered.coverage,
            });
          }
          turnEvidence.observeSemantics(discovered.semantics);
          if (discovered.knowledgeState?.higherMemory === "absent") {
            coldHigherMemoryTargetIds.add(discovered.knowledgeState.targetObjectId);
          }
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
              turnEvidence.contract().coverageByLayer,
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
        skillSession,
        findExistingObjectsByCanonicalName: async (canonicalName) => {
          return getDatabase().memoryGlobalObject.findMany({
            where: {
              OR: [
                { canonicalName },
                {
                  surfaceMemberships: {
                    some: {
                      objectFragment: { surfaceForms: { has: canonicalName } },
                    },
                  },
                },
              ],
            },
            select: { id: true, canonicalName: true },
            take: 2,
          });
        },
        resolveObjectReference: (reference) => {
          return evidence.objectForModelReference(reference);
        },
        onQueryResult: ({
          viewKey,
          queryKey,
          complete,
          sourceCardCount,
          semantics,
          reason,
        }) => {
          turnEvidence.observeCoverage({
            layer: "business_view",
            scope: `view:${viewKey}:query:${queryKey}`,
            coverage: {
              level: complete ? "complete" : "partial",
              missingAspects: reason ? [reason] : [],
              observationComplete: complete,
              contentPresence: sourceCardCount > 0
                ? "present"
                : complete
                  ? "absent"
                  : "unknown",
            },
          });
          turnEvidence.observeSemantics(semantics);
        },
        onCommandAttempt: () => {
          viewCommandAttemptCount += 1;
          turnEvidence.observeViewActionRequest();
        },
        onProposal: (proposal) => {
          proposalReceiptCount += 1;
          writer.write({ type: "data-viewCommandProposal", data: proposal });
        },
      });
      const objectManagementToolset = createObjectManagementToolset({
        onProposal: (proposal) => {
          proposalReceiptCount += 1;
          writer.write({ type: "data-objectChangeProposal", data: proposal });
        },
      });
      const libraryToolset = createLibraryToolset({
        onList: () => {
          openedCapabilities.libraryIndexRead = true;
        },
        onProposal: (proposal) => {
          proposalReceiptCount += 1;
          writer.write({ type: "data-libraryProposal", data: proposal });
        },
        onPreview: (preview) => turnEvidence.observeLibraryPreview(preview),
      });
      const knowledgeEnvironmentTool = createKnowledgeEnvironmentTool({
        dependencies: {
          database: getDatabase(),
          registry: extensionRegistry,
          canReadView: (viewKey) => skillSession.canReadView(viewKey),
        },
        onInspect: (inventory) => {
          firstAuthoritativeTool ??= "inspectKnowledgeEnvironment";
          turnEvidence.observeKnowledgeInventory();
          if (inventory.sharedBrain) {
            sourceLayersUsed.add("shared_brain");
            turnEvidence.observeCoverage({
              layer: "shared_brain",
              scope: "inventory",
              coverage: {
                level: "complete",
                missingAspects: [],
                observationComplete: true,
                contentPresence:
                  inventory.sharedBrain.objects +
                      inventory.sharedBrain.assertions.total +
                      inventory.sharedBrain.higherMemories.object +
                      inventory.sharedBrain.higherMemories.ambient > 0
                    ? "present"
                    : "absent",
              },
            });
          }
          if (inventory.library) {
            sourceLayersUsed.add("library");
            turnEvidence.observeCoverage({
              layer: "library",
              scope: "inventory",
              coverage: {
                level: "complete",
                missingAspects: [],
                observationComplete: true,
                contentPresence: inventory.library.files + inventory.library.folders > 0
                  ? "present"
                  : "absent",
              },
            });
          }
          if (inventory.businessViews) {
            sourceLayersUsed.add("business_view");
            turnEvidence.observeCoverage({
              layer: "business_view",
              scope: "inventory",
              coverage: {
                level: "complete",
                missingAspects: [],
                observationComplete: true,
                contentPresence:
                  inventory.businessViews.totalCards +
                      inventory.businessViews.views.filter((view) => view.higherMemory).length > 0
                    ? "present"
                    : "absent",
              },
            });
          }
        },
      });
      const sourceDocumentToolset = createSourceDocumentToolset({
        evidence,
        resultTokenBudget: exploreResultTokenBudget,
        sharedResultBudget,
        onRead: (sourceRead) => {
          turnEvidence.observeSourceDocument(sourceRead);
          turnEvidence.observeSemantics(sourceRead.semantics);
        },
      });
      const globalToolProviderToolset = createAgentToolProviderToolset({
        runtime: toolRuntime,
        actor: {
          actorId: requestActor.id,
          permissions: toolRuntime.listContracts().flatMap((contract) =>
            contract.sideEffect === "none" && contract.allowedCallers.includes("agent")
              ? contract.requiredPermissions
              : []
          ),
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
      const resolvedAnswerText = (rawText: string) =>
        finalAnswer && rawText.trim() === finalRawText.trim()
          ? finalAnswer
          : rawText;
      const exploreSystem = [
        context.system,
        currentTimeInstruction,
        authenticatedUserInstruction(authenticatedUser),
        pageContextInstruction(pageContext),
        TURN_KERNEL_INSTRUCTIONS,
        ANSWER_PRESENTATION_INSTRUCTIONS,
        viewCatalogContext,
      ].filter(Boolean).join("\n\n");
      await debugTrace.appendJsonSection("服务端 View 预读取", {
        requestedViewKeys: [],
        prefetchedViewKeys: [],
        durationMs: 0,
        note: "首轮注入权威静态 View Catalog；当前 Card 清单由 listViewCards 读取，Higher Memory 和具体 Card 的详细状态只在 readViewState 后读取。",
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
          const claim = await claimChatAssertionReceipt(receiptKey);
          if (!claim) {
            throw new Error("Assertion 回执已由另一个处理者领取或不再等待处理");
          }
          let captureResult: ChatAssertionCaptureResult;
          try {
            captureResult = await captureChatAssertions({
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
          } catch (error) {
            try {
              await failChatAssertionReceipt(claim, error);
            } catch (receiptError) {
              console.error("[chat.assertion-receipt.foreground-failed]", receiptError);
              await debugTrace.appendError("前台 Assertion 失败回执写入失败", receiptError);
            }
            throw error;
          }
          await completeChatAssertionReceipt(claim, captureResult);
          return captureResult;
        },
        onForegroundResult: (captureResult) => {
          if (captureResult.publishedAssertions > 0) {
            turnEvidence.observeDurableMemoryWrite();
          }
          objectManagementToolset.registerPublishedMemory(captureResult);
          viewToolset.registerPublishedObjects(captureResult.affectedObjects);
        },
      });
      const knownArtifactNodeIds = new Set<string>();
      const viewStateRuntime = createViewStateRuntime({
        registry: extensionRegistry,
        evidence,
        userQuery: query,
        pageContext,
        readSnapshot: viewToolset.readSnapshot,
        resolveCardReference: viewToolset.resolveCardReference,
        presentCards: viewToolset.presentCards,
        onObserved: (observation) => turnEvidence.observeViewState(observation),
        onListObserved: (observation) => turnEvidence.observeViewCardList(observation),
      });
      const gatewayTools = createCapabilityGatewayTools(openedCapabilities, {
        viewKeySchema: registeredViewKeySchema(extensionRegistry),
        describeBusinessViewActions: (viewKey) => viewToolset.describeCommands(viewKey),
        locateObjectViews: ({ objectRef }) => viewToolset.locateObjectViews(objectRef),
        authorizeAction: (area, viewKey) => ({
          allowed: skillSession.canOpenAction(area, viewKey),
          reason: skillSession.activations().length
            ? `已激活 Skills ${skillSession.activeSkillIds().join("、")} 未声明该 Action 权限。`
            : undefined,
        }),
        listViewCards: async (request) => {
          const { output } = await viewStateRuntime.list(request);
          firstAuthoritativeTool ??= "listViewCards";
          sourceLayersUsed.add("business_view");
          return output;
        },
        readViewState: async (request) => {
          const { output, discovered } = await viewStateRuntime.read(request);
          firstAuthoritativeTool ??= "readViewState";
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
                turnEvidence.contract().coverageByLayer,
              ),
            });
          }
          return output;
        },
        findArtifacts: async ({ title, purpose }) => {
          const result = await findArtifactsByTitle({ title });
          const referencedResult = artifactReferences.attachSearchReferences(result);
          const semantics = artifactSearchEvidenceSemantics(referencedResult);
          referencedResult.items.forEach((item) => knownArtifactNodeIds.add(item.nodeId));
          turnEvidence.observeArtifactSearch({ ...referencedResult, purpose });
          turnEvidence.observeSemantics(semantics);
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
          turnEvidence.observeArtifactKnowledge({
            nodeId,
            assertionCount: result.evidence.assertions.length,
            coverage: result.evidence.coverage,
          });
          turnEvidence.observeSemantics(semantics);
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
                turnEvidence.contract().coverageByLayer,
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
      const allTools: ToolSet = {
        ...skillToolset.tools,
        ...gatewayTools,
        ...memoryTools,
        expandEvidence: memoryTools.searchMemory,
        readMemoryWriteStatus: createMemoryWriteStatusTool({
          actorId: requestActor.id,
          conversationMessages: conversationUserMessages,
          currentMessageId: latestUserMessage.id,
        }),
        readSourceDocument: sourceDocumentToolset.tool,
        ...viewToolset.tools,
        ...objectManagementToolset.tools,
        ...libraryToolset.tools,
        inspectKnowledgeEnvironment: knowledgeEnvironmentTool,
        ...globalToolProviderToolset.tools,
        openArtifactKnowledge,
        publishUserFactForView: assertionQueueToolset.foregroundTool,
        updateActorHigherMemory: actorHigherMemoryWriteToolset.tool,
      };
      const activeViewQueryToolNames = () =>
        viewToolset.queryToolNames(openedCapabilities.openedViewKeys);
      const compiledActiveToolNames = () => compileActiveToolNames({
        availableToolNames: Object.keys(allTools),
        state: {
          viewStateOpened: openedCapabilities.viewStateOpened,
          artifactsOpened: openedCapabilities.artifacts,
          libraryIndexRead: openedCapabilities.libraryIndexRead,
          sharedBrainOpened: openedCapabilities.sharedBrain,
          memoryPurpose: openedCapabilities.memoryPurpose,
          actionAreas: openedCapabilities.actionAreas,
          objectEvidenceAvailable: evidence.snapshot().seedMap.objects.length > 0,
        },
        skillToolNames: skillToolset.toolNames,
        viewQueryToolNames: activeViewQueryToolNames(),
        providerToolNames: globalToolProviderToolset.toolNames,
      });
      const exposedToolNames = compiledActiveToolNames();
      capabilityLedger.recordExposure(exposedToolNames);
      const currentRuntimeAnswerContract = () => buildRuntimeAnswerContract({
        evidence: turnEvidence.contract(),
        capabilities: capabilityLedger.snapshot(),
      });
      const stepSystem = () => {
        const enabledDetails = compiledActiveToolNames();
        if (!enabledDetails.length) {
          return exploreSystem;
        }
        const preferredKnowledgeLayer = (openedCapabilities.artifacts ||
            openedCapabilities.libraryIndexRead) &&
            !openedCapabilities.viewStateOpened && !openedCapabilities.sharedBrain
          ? "library" as const
          : openedCapabilities.viewStateOpened
            ? "business_view" as const
            : openedCapabilities.sharedBrain
              ? "shared_brain" as const
              : "unknown" as const;
        const answerContract = runtimeAnswerContractInstruction(
          currentRuntimeAnswerContract(),
        );
        return [
          exploreSystem,
          skillSession.instructions(),
          buildCapabilityInstructions({
            preferredKnowledgeLayer,
            toolNames: enabledDetails,
          }),
          answerContract,
        ].join("\n\n");
      };
      await debugTrace.appendJsonSection("本轮工具暴露", {
        exposedToolNames,
        note: "主模型负责语义工具选择；Runtime Capability Compiler 只暴露满足权限、Evidence 和工作流前置条件的能力。后台记忆治理与 Handoff 不进入前台工具面。",
      });
      const result = streamText({
        model,
        system: stepSystem(),
        messages: context.messages,
        tools: allTools,
        toolChoice: "auto",
        stopWhen: ({ steps }) => {
          const finalStep = steps.at(-1);
          if (runInterruption && finalStep?.toolCalls.length === 0) return true;
          if (!finalStep?.text.trim()) return false;
          // Tool-calling steps always get a following answer step. A short
          // pre-tool preamble is not a completed action plan.
          if (finalStep.toolCalls.length > 0) return false;
          if (
            openedCapabilities.actionAreas.has("business_view") &&
            viewCommandAttemptCount === 0 &&
            !runInterruption
          ) return false;
          return true;
        },
        prepareStep: ({ stepNumber, steps, messages: stepMessages }) => {
          const instructions = stepSystem();
          if (!runInterruption && exploreResultTokenBudget === 0) {
            interruptRun(
              "context_capacity_exhausted",
              "当前请求已没有可安全容纳工具结果的上下文容量",
            );
          }
          if (!runInterruption) {
            const guardDecision = evaluateAgentRunGuard({
              stepNumber,
              toolCalls: steps.flatMap((step) => step.toolCalls.map((call) => ({
                toolName: call.toolName,
                input: call.input,
              }))),
              emergencyStepLimit: profile.agentEmergencyStepLimit,
              repeatedToolCallLimit: profile.agentRepeatedToolCallLimit,
            });
            if (guardDecision.interrupted) {
              interruptRun(guardDecision.reason, guardDecision.detail);
            }
          }
          if (runInterruption) {
            return {
              ...(stepNumber > 0
                ? { messages: compactExploreStepMessages(stepMessages) }
                : {}),
              activeTools: [] as const,
              toolChoice: "none" as const,
              instructions: `${instructions}\n\n${incompleteRunInstruction({
                ...runInterruption,
                missingProposal:
                  openedCapabilities.actionAreas.has("business_view") &&
                  viewCommandAttemptCount === 0,
              })}`,
            };
          }
          if (
            openedCapabilities.actionAreas.has("business_view") &&
            viewCommandAttemptCount === 0
          ) {
            capabilityLedger.recordExposure(["runViewCommand"]);
            return {
              ...(stepNumber > 0
                ? { messages: compactExploreStepMessages(stepMessages) }
                : {}),
              activeTools: ["runViewCommand"] as const,
              toolChoice: "required" as const,
              instructions: [
                instructions,
                "已经打开 Business View 写入能力，但尚未实际调用 View Command。文字说明不能代替真实 Proposal。",
                "使用 runViewCommand 的 commands 批次提交本轮全部能够提交的条目。创建关联 Card 时填写 Command 声明的自然语言实体名称，由 Runtime 绑定已有 Object；不要把 Chat Assertion Capture 当作来源资料的 Object 创建器。",
              ].join("\n\n"),
            };
          }
          const activeTools = compiledActiveToolNames();
          capabilityLedger.recordExposure(activeTools);
          return {
            ...(stepNumber > 0
              ? { messages: compactExploreStepMessages(stepMessages) }
              : {}),
            activeTools,
            toolChoice: "auto" as const,
            instructions,
          };
        },
        temperature: 0.3,
        maxOutputTokens: profile.maxOutputTokens,
        maxRetries: profile.maxRetries,
        timeout: {
          firstChunkMs: profile.modelFirstChunkTimeoutMs,
          chunkMs: profile.modelChunkTimeoutMs,
        },
        abortSignal: request.signal,
        onChunk: ({ chunk }) => {
          switch (chunk.type) {
            case "start-step":
              currentStepTextChars = 0;
              // A new model step after an error means the SDK recovered and
              // supplied the tool result back to the model for repair.
              streamObservation.error = undefined;
              streamObservation.failureCode = undefined;
              break;
            case "text-delta":
              currentStepTextChars += chunk.text.length;
              streamObservation.contentChars = currentStepTextChars;
              break;
            case "finish-step":
              lastCompletedStepTextChars = currentStepTextChars;
              break;
            case "reasoning-delta":
              streamObservation.reasoningChars += chunk.text.length;
              break;
            case "tool-call":
              streamObservation.toolCallCount += 1;
              break;
            case "error":
              streamObservation.error = summarizeChatStreamError(chunk.error);
              streamObservation.failureCode = classifyChatStreamFailureCode(chunk.error);
              streamObservation.contentChars = lastCompletedStepTextChars || currentStepTextChars;
              break;
            case "abort":
              streamObservation.streamEnded = false;
              streamObservation.failureCode = chunk.reason
                ? classifyChatStreamFailureCode(new Error(chunk.reason))
                : "stream_aborted";
              streamObservation.contentChars = lastCompletedStepTextChars || currentStepTextChars;
              writeStreamStatus();
              break;
          }
        },
        onLanguageModelCallStart: async (event) => {
          mainModelCallNumber += 1;
          Object.assign(streamObservation, modelCallAttempts.started());
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
          modelCallAttempts.ended();
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
          if (
            event.toolOutput.type !== "tool-result" &&
            isContextCapacityError(event.toolOutput.error)
          ) {
            interruptRun(
              "context_capacity_exhausted",
              "工具结果已达到本轮可安全使用的上下文容量",
            );
          }
          const toolName = event.toolCall.toolName;
          const queryRejected = toolName.startsWith("query_") &&
            event.toolOutput.type === "tool-result" &&
            objectValue(objectValue(output)?.error)?.code === "INVALID_VIEW_QUERY_INPUT";
          const toolSucceeded = event.toolOutput.type === "tool-result" && !queryRejected;
          capabilityLedger.recordExecution(
            toolName,
            toolSucceeded,
            output,
            globalToolProviderToolset.toolNames.includes(toolName) ? "none" : undefined,
          );
          if (toolName === "listLibrary" || toolName === "openArtifacts") {
            libraryQueryCount += 1;
          }
          if (toolName === "searchMemory" || toolName === "expandEvidence") {
            memoryQueryCount += 1;
          }
          if (event.toolOutput.type === "tool-result" && !queryRejected) {
            const toolLayer = toolName === "readViewState" || toolName === "listViewCards" ||
                toolName === "locateObjectViews" || toolName.startsWith("query_")
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
            : toolName === "readViewState" && objectValue(output)
              ? (() => {
                  const businessResult = objectValue(output)!;
                  const view = objectValue(businessResult.view);
                  return {
                    viewKey: view?.key,
                    targets: businessResult.targets,
                    viewHigherMemory: businessResult.viewHigherMemory,
                    matchingCards: businessResult.matchingCards,
                    relatedObjects: businessResult.relatedObjects,
                    missingDetails: businessResult.missingDetails,
                  };
                })()
              : output;
          mainToolExecutions.push({
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            input: event.toolCall.input,
            output: semanticToolOutput,
            success: toolSucceeded,
          });
          await debugTrace.appendSection(
            `工具执行 · ${event.toolCall.toolName}`,
            [
              `- Tool call ID：\`${event.toolCall.toolCallId}\``,
              `- 执行结果：${queryRejected
                ? "输入被 Query 契约拒绝"
                : event.toolOutput.type === "tool-result"
                  ? "成功"
                  : "失败"}`,
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
        onFinish: async ({ text, finishReason, totalUsage }) => {
          finalRawText = text;
          streamObservation.terminalMetadataOnlyToolCalls = false;
          streamObservation.finishReason = finishReason;
          streamObservation.streamEnded = true;
          streamObservation.contentChars = text.length;
          const terminalStatus = classifyChatStreamStatus(streamObservation);
          if (terminalStatus.status !== "completed") {
            writeStreamStatus();
            memoryMaintenance.cancel("主回答未完整完成，因此后台记忆线路未启动。");
            await debugTrace.appendJsonSection("主回答未完整完成", {
              finishReason,
              status: terminalStatus.status,
              completionKind: terminalStatus.completionKind,
              failureCode: terminalStatus.failureCode,
              reasoningChars: streamObservation.reasoningChars,
              contentChars: streamObservation.contentChars,
              modelCallCount: streamObservation.modelCallCount,
              retryCount: streamObservation.retryCount,
            });
            return;
          }
          const evidenceContract = turnEvidence.contract();
          const validRefs = validReferenceRefs();
          finalVerification = verifyGroundedAnswer({
            text,
            contract: evidenceContract,
            validRefs,
          });
          finalAnswer = text.trim();
          if (!finalVerification.accepted && !answerWasStreamed) {
            verificationRepairAttempted = true;
            try {
              const repaired = await generateText({
                model,
                system: [
                  "你是 Sydaris Answer Verifier 的修正步骤。只能依据提供的 Evidence Contract 和真实引用修正答案，不得调用工具或引入新事实。",
                  ANSWER_PRESENTATION_INSTRUCTIONS,
                ].join("\n\n"),
                prompt: buildAnswerRepairPrompt({
                  originalText: text,
                  verification: finalVerification,
                  contract: evidenceContract,
                  validRefs,
                }),
                temperature: 0.1,
                maxOutputTokens: profile.maxOutputTokens,
                maxRetries: profile.maxRetries,
                timeout: {
                  firstChunkMs: profile.modelFirstChunkTimeoutMs,
                  chunkMs: profile.modelChunkTimeoutMs,
                },
                abortSignal: request.signal,
              });
              const repairedVerification = verifyGroundedAnswer({
                text: repaired.text,
                contract: evidenceContract,
                validRefs,
              });
              await debugTrace.appendSection(
                "Answer Verifier · 修正尝试",
                [
                  "### 修正后回答",
                  "",
                  debugCodeBlock(repaired.text),
                  "",
                  "### 再验证",
                  "",
                  debugCodeBlock(debugJson(repairedVerification), "json"),
                ].join("\n"),
              );
              finalVerification = repairedVerification;
              if (repairedVerification.accepted) {
                verificationRepairSucceeded = true;
                finalAnswer = repaired.text.trim();
              }
            } catch (error) {
              await debugTrace.appendError("Answer Verifier 修正调用失败", error);
            }
          }
          if (!finalVerification.accepted && answerWasStreamed) {
            streamedVerificationWarning = true;
            await debugTrace.appendJsonSection("Answer Verifier · 流式回答告警", {
              mode: currentRuntimeAnswerContract().mode,
              violations: finalVerification.violations,
              note: "direct/evidence_envelope 已发送，Verifier 只记录告警，不执行不可见替换。",
            });
          } else if (!finalVerification.accepted) {
            finalAnswer = verificationFailureAnswer(finalVerification);
            streamObservation.interruptionReason = "verification_failed";
          }
          streamObservation.finishReason = finishReason;
          streamObservation.streamEnded = true;
          streamObservation.contentChars = finalAnswer.length;
          streamObservation.error = undefined;
          streamObservation.failureCode = undefined;
          writeStreamStatus();
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
              "### Answer Verifier",
              "",
              debugCodeBlock(debugJson({
                contract: evidenceContract,
                verification: finalVerification,
                repairAttempted: verificationRepairAttempted,
                repairSucceeded: verificationRepairSucceeded,
                answerWasStreamed,
                streamedVerificationWarning,
              }), "json"),
              "",
              "### 实际发送回答",
              "",
              debugCodeBlock(finalAnswer),
            ].join("\n"),
          );
          if (!finalVerification.accepted && !streamedVerificationWarning) {
            memoryMaintenance.cancel("主回答未通过证据校验，因此后台记忆线路未启动。");
            return;
          }
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
          const foregroundAssertionDecision = assertionQueueToolset.foregroundDecision();
          const foregroundAssertionResult = assertionQueueToolset.foregroundResult();
          let higherMemoryQueueDecision = higherMemoryQueueToolset.decision();
          const actorHigherMemoryQueueDecision = actorHigherMemoryWriteToolset.hasCommit()
            ? undefined
            : actorHigherMemoryQueueToolset.decision();
          await debugTrace.appendJsonSection("Post-turn Runtime Policy", {
            modelHandoff: "disabled",
            assertionReviewSource: foregroundAssertionResult
              ? "completed_foreground_tool_receipt"
              : "automatic_post_turn_sidecar",
            note: "普通事实审查由 Post-turn Runtime 自动执行并允许空结果，不依赖主模型提交 Handoff 或后台排队意图。",
          });
          const semanticContext = {
            conversation: semanticConversation.slice(-8),
            systemInstruction: "",
            pageContext,
            modelCalls: [],
            toolExecutions: mainToolExecutions,
            finalAnswer,
          };
          const backgroundAssertionDecision = foregroundAssertionResult
            ? undefined
            : {
                reason:
                  "Post-turn Runtime 自动审查当前用户原话是否包含可安全固化的组织事实；允许提交空结果。",
              };
          const consolidationNeeded = Boolean(
            foregroundAssertionResult ||
            backgroundAssertionDecision,
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
          let writebackStatus = backgroundAssertionDecision
            ? "eligible"
            : "not_requested";
          let durableBackgroundReceipt = false;
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
              durableBackgroundReceipt = true;
              writebackStatus = "queued_persisted";
            } catch (error) {
              writebackStatus = "persistence_failed";
              console.error("[chat.assertion-receipt.persist]", error);
              await debugTrace.appendError("持久化 Assertion 回执失败", error);
            } finally {
              writebackPersistenceDurationMs = Math.round(
                performance.now() - persistenceStartedAt,
              );
            }
          } else if (foregroundAssertionResult) {
            writebackStatus = "completed_foreground";
          }

          const hasBackgroundWork = Boolean(
            latestUserMessage && backgroundAssertionDecision && durableBackgroundReceipt,
          );
          const hasForegroundWork = Boolean(
            latestUserMessage && foregroundAssertionResult && foregroundAssertionDecision,
          );
          const hasConsolidationWork = Boolean(consolidationInput);
          const hasColdHigherMemoryWork = coldHigherMemoryTargetIds.size > 0;
          if (hasColdHigherMemoryWork) {
            higherMemoryQueueDecision = addObjectTargetsToQueueDecision({
              decision: higherMemoryQueueDecision,
              objectIds: [...coldHigherMemoryTargetIds],
              reason: "用户首次实质性检索了尚无 Higher Memory 的唯一目标 Object；基于本轮真实 Assertion 与来源建立第一版 Cognitive Memory 和 Operational Memory Index。",
            });
          }
          const higherMemoryInput = higherMemoryQueueDecision
            ? {
                clientMessageId: latestUserMessage.id,
                submittedAt: submittedAt.toISOString(),
                timezone: requestTimezone,
                semanticContext,
                retrieval: accumulatedRetrieval,
                queueDecision: higherMemoryQueueDecision,
              }
            : undefined;
          const hasHigherMemoryWork = Boolean(higherMemoryInput);
          const actorHigherMemoryInput = actorHigherMemoryQueueDecision
            ? {
                actorId: requestActor.id,
                actorDisplayName: requestActor.displayName,
                clientMessageId: latestUserMessage.id,
                submittedAt: submittedAt.toISOString(),
                timezone: requestTimezone,
                semanticContext,
                queueDecision: actorHigherMemoryQueueDecision,
              }
            : undefined;
          const hasActorHigherMemoryWork = Boolean(actorHigherMemoryInput);
          if (
            latestUserMessage &&
            (
              hasBackgroundWork ||
              hasForegroundWork ||
              hasConsolidationWork ||
              hasHigherMemoryWork ||
              hasActorHigherMemoryWork
            )
          ) {
            memoryMaintenance.publish({
              ...(hasBackgroundWork && receiptKey
                ? {
                    assertionReceipt: receiptKey,
                  }
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
              ...(higherMemoryInput ? { higherMemory: higherMemoryInput } : {}),
              ...(actorHigherMemoryInput
                ? { actorHigherMemory: actorHigherMemoryInput }
                : {}),
            });
          } else {
            await debugTrace.appendSection(
              "Assertion 入口判断",
              writebackStatus === "persistence_failed"
                ? "结果：本轮值得尝试写回，但持久化任务失败，未启动不可恢复的局部后台任务。"
                : "结果：服务端事后门控未登记 Assertion 回执。",
            );
            await debugTrace.appendSection(
              "Higher Memory 入口判断",
              "结果：本轮没有新事实审查意图、显式 Higher Memory 维护意图或冷启动 Object 目标，因此不启动维护链。",
            );
            memoryMaintenance.cancel(
              "本轮没有可执行的 Assertion、共享 Higher Memory 或 Actor 私有 Higher Memory 工作。",
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
            finalActiveToolNames: compiledActiveToolNames(),
            openedCapabilities: {
              viewStateOpened: openedCapabilities.viewStateOpened,
              artifacts: openedCapabilities.artifacts,
              libraryIndexRead: openedCapabilities.libraryIndexRead,
              sharedBrain: openedCapabilities.sharedBrain,
              memoryPurpose: openedCapabilities.memoryPurpose ?? null,
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
            writebackEligibility: backgroundAssertionDecision ? "automatic_sidecar" : "foreground_completed",
            handoffMode: "disabled",
            proposalReceiptCount,
            viewCommandAttemptCount,
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
              "Shared Brain · 本轮检索利用率",
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
                turnEvidence.contract().coverageByLayer,
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
          streamObservation.error = summarizeChatStreamError(error);
          streamObservation.failureCode = classifyChatStreamFailureCode(error);
          streamObservation.streamEnded = false;
          streamObservation.contentChars = lastCompletedStepTextChars || currentStepTextChars;
          console.error(
            "[chat.model-stream]",
            JSON.stringify(summarizeChatStreamError(error)),
          );
          void debugTrace.appendError("主回答流错误事件（可能由后续步骤恢复）", error);
          return "AI 服务响应失败，请稍后重试。";
        },
      });
      writer.merge(governFinalAnswerStream(
        modelUIStream,
        resolvedAnswerText,
        () => {
          const mode = currentRuntimeAnswerContract().mode;
          return mode === "claim_frame" || mode === "proposal_receipt" ||
            mode === "write_receipt";
        },
        () => {
          answerWasStreamed = true;
        },
      ));
    },
    onEnd: async ({ messages: completedMessages, responseMessage }) => {
      const persistedResponse = withoutTurnHandoff(responseMessage);
      if (!hasPersistableChatContent(persistedResponse)) return;
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
        JSON.stringify(summarizeChatStreamError(error)),
      );
      void debugTrace.appendError("Chat UI 流失败", error);
      memoryMaintenance.cancel("主回答流失败，因此后台记忆线路未启动。");
      return "AI 服务响应失败，请稍后重试。";
    },
  });

  return createUIMessageStreamResponse({ stream });
}
