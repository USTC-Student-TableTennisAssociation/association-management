"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type ChatStatus,
} from "ai";
import {
  FormEvent,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AIInvocation } from "@sydaris/plugin-sdk";

import type { ChatPageContext, ClubChatMessage } from "@/ai/types";
import type { ArtifactReference } from "@/library/artifact-references";
import type { ViewInformationReference } from "@/agent-runtime/view-types";
import {
  compactChatRequestMessages,
  finalStepMessageText,
} from "@/ai/ui-message-text";
import { LibraryWorkspace } from "@/library/components/library-workspace";
import { LibraryProposalCard } from "@/library/components/library-proposal-card";
import { CompilationWorkspace } from "@/library/components/compilation-workspace";
import { KnowledgeGraphWorkspace } from "@/memory/components/knowledge-graph-workspace";
import type {
  MemoryChannelTrace,
  StructuredSeedMap,
} from "@/memory/types";
import type {
  SourceDocumentBlock,
  SourceDocumentReference,
} from "@/memory/source-document-types";
import { ObjectChangeProposalCard } from "@/memory/object-management-components";
import { GenericViewInspector } from "@/view-runtime/generic-ui/generic-view-inspector";
import { ViewCommandProposalCard } from "@/view-runtime/generic-ui/view-command-proposal-card";
import { WorkPresentationHost } from "@/view-runtime/presentation-host/work-presentation-host";

const initialMessages: ClubChatMessage[] = [];

type ChatHistoryState = "loading" | "ready" | "error";
type CurrentUser = {
  userId: string;
  loginName: string;
  role: "ADMIN" | "MEMBER";
  actor: { id: string; displayName: string };
  actorObject: {
    id: string;
    canonicalName: string;
  } | null;
};

type ConversationSummary = {
  id: string;
  title: string;
  archivedAt: string | null;
  lastMessageAt: string;
  createdAt: string;
};

type InstalledViewSummary = {
  viewKey: string;
  label: string;
  specializedLabel?: string;
  description: string;
  pluginVersion: string;
  schemaVersion: string;
  stateVersion: string;
  status: "enabled" | "incompatible";
  presentation?: {
    key: string;
    label: string;
    loader: string;
  };
};

type SurfaceMode = "work" | "knowledge" | "library";
type LibraryMode = "files" | "processing";
type LayoutMode = "focus" | "collaborate" | "conversation";
const layoutModeStorageKey = "sydaris.layoutMode";

function storedLayoutMode(value: string | null): LayoutMode | undefined {
  return value === "focus" || value === "collaborate" || value === "conversation"
    ? value
    : undefined;
}

function messageReasoning(message: ClubChatMessage) {
  return message.parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
}

type ToolActivity = {
  id: string;
  label: string;
  state: "running" | "complete" | "error";
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactText(value: unknown, maxLength = 72) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function resultCount(
  output: unknown,
  collection: "objects" | "assertions" | "connections",
) {
  const root = record(output);
  if (!root) return undefined;

  const candidates = [
    record(root.counts),
    root,
    record(root.seedMap),
    record(root.summary),
    record(record(root.result)?.seedMap),
    record(root.result),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const items = candidate[collection];
    if (Array.isArray(items)) return items.length;
    if (typeof items === "number" && Number.isFinite(items) && items >= 0) {
      return Math.floor(items);
    }

    const singular = collection === "objects" ? "object" : collection.slice(0, -1);
    for (const key of [`${singular}Count`, `${collection}Count`]) {
      const count = candidate[key];
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
        return Math.floor(count);
      }
    }
  }

  return undefined;
}

function completedToolLabel(toolName: string, output: unknown) {
  if (toolName === "readView") {
    const root = record(output);
    const cards = Array.isArray(root?.cards) ? root.cards.length : 0;
    const cardTypes = Array.isArray(root?.cardTypes) ? root.cardTypes.length : 0;
    return `业务视图读取完成 · ${cardTypes} 种卡片 · ${cards} 张正式卡片`;
  }
  if (toolName === "readSourceDocument") {
    const root = record(output);
    const document = record(root?.document);
    const selection = record(root?.selection);
    const blocks = Array.isArray(root?.blocks) ? root.blocks.length : 0;
    const outline = Array.isArray(root?.outline) ? root.outline.length : 0;
    const title = compactText(document?.title, 36) ?? "原文";
    const label = compactText(selection?.label, 48);
    return outline
      ? `${title} · 目录读取完成 · ${outline} 个章节`
      : `${title} · ${label ?? "原文读取完成"} · ${blocks} 个 Block`;
  }
  const objectCount = resultCount(output, "objects");
  const assertionCount = resultCount(output, "assertions");
  const connectionCount = resultCount(output, "connections");
  const counts = [
    objectCount === undefined ? undefined : `${objectCount} 个对象`,
    assertionCount === undefined ? undefined : `${assertionCount} 条 Assertion`,
    connectionCount === undefined ? undefined : `${connectionCount} 个连接`,
  ].filter((item): item is string => item !== undefined);
  const action = toolName === "searchMemory" ? "搜索完成" : "对象查找完成";

  return counts.length ? `${action} · 找到 ${counts.join("、")}` : action;
}

function toolActivities(
  message: ClubChatMessage,
  isActiveAssistant: boolean,
): ToolActivity[] {
  return message.parts.flatMap<ToolActivity>((part): ToolActivity[] => {
    if (!isToolUIPart(part)) return [];

    const toolName = getToolName(part);
    if (
      toolName !== "searchMemory" &&
      toolName !== "followObject" &&
      toolName !== "readView" &&
      toolName !== "readSourceDocument"
    ) return [];

    const input = record(part.input);
    const query = compactText(input?.query);
    const globalObjectId = compactText(input?.globalObjectId, 48);
    const focus = compactText(input?.focus, 56);
    const sourceMode = compactText(input?.mode, 16);
    const sourceModeLabel = sourceMode === "outline"
      ? "目录"
      : sourceMode === "around"
        ? "上下文"
        : sourceMode === "section"
          ? "章节"
          : sourceMode === "range"
            ? "连续范围"
            : sourceMode === "full"
              ? "全文"
              : "后续内容";
    const runningLabel =
      toolName === "readView"
        ? "正在读取业务视图…"
        : toolName === "readSourceDocument"
          ? `正在读取原文${sourceModeLabel}…`
        : toolName === "searchMemory"
        ? query
          ? `正在搜索：${query}`
          : "正在搜索记忆…"
        : [globalObjectId ? `正在沿对象 ${globalObjectId} 查找` : "正在沿对象查找", focus]
            .filter(Boolean)
            .join("：");

    switch (part.state) {
      case "output-available":
        return [{
          id: part.toolCallId,
          label: completedToolLabel(toolName, part.output),
          state: "complete",
        }];
      case "output-error":
      case "output-denied":
        return [{
          id: part.toolCallId,
          label: toolName === "readView"
            ? "业务视图读取失败"
            : toolName === "readSourceDocument"
              ? "原文读取失败"
            : toolName === "searchMemory"
              ? "搜索失败"
              : "对象查找失败",
          state: "error",
        }];
      case "approval-responded":
        if (!part.approval.approved) {
          return [{
            id: part.toolCallId,
            label: toolName === "readView"
              ? "业务视图读取未执行"
              : toolName === "readSourceDocument"
                ? "原文读取未执行"
              : toolName === "searchMemory"
                ? "搜索未执行"
                : "对象查找未执行",
            state: "error",
          }];
        }
        return [{
          id: part.toolCallId,
          label: isActiveAssistant
            ? runningLabel
            : toolName === "readView"
              ? "业务视图读取已中断"
              : toolName === "readSourceDocument"
                ? "原文读取已中断"
              : toolName === "searchMemory"
              ? "搜索已中断"
              : "对象查找已中断",
          state: isActiveAssistant ? "running" : "error",
        }];
      default:
        return [{
          id: part.toolCallId,
          label: isActiveAssistant
            ? runningLabel
            : toolName === "readView"
              ? "业务视图读取已中断"
              : toolName === "readSourceDocument"
                ? "原文读取已中断"
              : toolName === "searchMemory"
              ? "搜索已中断"
              : "对象查找已中断",
          state: isActiveAssistant ? "running" : "error",
        }];
    }
  });
}

function ToolActivityList({ activities }: { activities: ToolActivity[] }) {
  if (!activities.length) return null;

  return (
    <div
      className="mt-3 space-y-1.5 border-t border-zinc-200 pt-2 text-xs"
      aria-live="polite"
      aria-label="记忆检索进度"
    >
      {activities.map((activity) => (
        <div
          key={activity.id}
          className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 ${
            activity.state === "error"
              ? "bg-red-50 text-red-700"
              : activity.state === "complete"
                ? "bg-emerald-50 text-emerald-800"
                : "bg-sky-50 text-sky-800"
          }`}
        >
          <span
            className={`mt-2 size-1.5 shrink-0 rounded-full ${
              activity.state === "error"
                ? "bg-red-500"
                : activity.state === "complete"
                  ? "bg-emerald-500"
                  : "animate-pulse bg-sky-500"
            }`}
            aria-hidden="true"
          />
          <span>{activity.label}</span>
        </div>
      ))}
    </div>
  );
}

function MarkdownText({
  text,
  references = [],
  sourceReferences = [],
  artifactReferences = [],
  onOpenViewReference,
  onOpenSourceReference,
  inverse = false,
}: {
  text: string;
  references?: ViewInformationReference[];
  sourceReferences?: SourceDocumentReference[];
  artifactReferences?: ArtifactReference[];
  onOpenViewReference?: (reference: ViewInformationReference) => void;
  onOpenSourceReference?: (reference: SourceDocumentReference) => void;
  inverse?: boolean;
}) {
  const referencesByRef = new Map(
    references.map((reference) => [reference.ref, reference]),
  );
  const sourceReferencesByRef = new Map(
    sourceReferences.map((reference) => [reference.ref, reference]),
  );
  const artifactReferencesByRef = new Map(
    artifactReferences.map((reference) => [reference.ref, reference]),
  );

  const markdown = text.replace(
    /\[((?:V|S|F)\d+)\]/g,
    "[$1](sydaris-ref:$1)",
  );

  return (
    <div className={`sydaris-markdown ${inverse ? "sydaris-markdown-inverse" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url.startsWith("sydaris-ref:") ? url : defaultUrlTransform(url)}
        components={{
          a: ({ href, children }) => {
            const referenceRef = href?.startsWith("sydaris-ref:")
              ? href.slice("sydaris-ref:".length)
              : undefined;
            const reference = referenceRef
              ? referencesByRef.get(referenceRef)
              : undefined;
            const sourceReference = referenceRef
              ? sourceReferencesByRef.get(referenceRef)
              : undefined;
            const artifactReference = referenceRef
              ? artifactReferencesByRef.get(referenceRef)
              : undefined;

            if (artifactReference) {
              return (
                <span className="sydaris-reference" title={artifactReference.label}>
                  {artifactReference.ref} · 资料库
                </span>
              );
            }
            if (sourceReference) {
              return (
                <button
                  type="button"
                  onClick={() => onOpenSourceReference?.(sourceReference)}
                  className="sydaris-reference"
                  title={`查看 ${sourceReference.label}`}
                >
                  {sourceReference.ref} · 原文 ↗
                </button>
              );
            }
            if (reference) {
              return (
                <button
                  type="button"
                  onClick={() => onOpenViewReference?.(reference)}
                  className="sydaris-reference"
                  title={`打开 ${reference.label}`}
                >
                  {reference.label} ↗
                </button>
              );
            }
            if (referenceRef) return <span>{children}</span>;
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function score(value: number) {
  return Number.isFinite(value) ? value.toFixed(4) : String(value);
}

function TraceChannel({
  title,
  channels,
}: {
  title: string;
  channels: MemoryChannelTrace[];
}) {
  const count = channels.reduce((total, item) => total + item.hits.length, 0);
  return (
    <details>
      <summary className="cursor-pointer font-medium text-zinc-700">
        {title}（{count}）
      </summary>
      <div className="mt-2 space-y-3">
        {channels.map((channel) => (
          <div key={channel.facetId}>
            <p className="font-medium text-zinc-600">
              {channel.facetId} · {channel.facetText}
            </p>
            {channel.hits.length ? (
              <ul className="mt-1 space-y-1">
                {channel.hits.map((hit) => (
                  <li
                    key={`${channel.facetId}-${hit.targetRef}-${hit.rank}`}
                    className={hit.selected ? "text-zinc-700" : "text-zinc-400"}
                  >
                    #{hit.rank} {hit.targetRef} · {hit.method} · score {score(hit.score)}
                    {hit.distance === undefined ? "" : ` · distance ${score(hit.distance)}`}
                    {" · "}
                    {hit.label}
                    {hit.selected ? "" : "（未进入最终 Seed Map）"}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-zinc-400">无命中</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function SeedMapPanel({ seedMap }: { seedMap: StructuredSeedMap }) {
  const higherMemories = seedMap.higherMemories ?? [];
  return (
    <details className="mt-3 border-t border-zinc-200 pt-2 text-xs text-zinc-600">
      <summary className="cursor-pointer font-medium text-emerald-800">
        Structured Seed Map（{seedMap.objects.length} Global Objects · {higherMemories.length} Higher Memories · {seedMap.assertions.length} Assertions）
      </summary>
      <div className="mt-2 space-y-3 rounded-md bg-white p-3">
        <details>
          <summary className="cursor-pointer font-medium text-zinc-700">
            Global Object Seeds（{seedMap.objects.length}）
          </summary>
          <ul className="mt-2 space-y-2">
            {seedMap.objects.map((object) => (
              <li key={object.ref}>
                <span className="font-medium text-zinc-800">
                  {object.ref} · {object.canonicalName}
                </span>
                <span>
                  {" · "}
                  {object.lexicalMatch ? "lexical" : ""}
                  {object.lexicalMatch && object.semanticMatch ? " + " : ""}
                  {object.semanticMatch ? "assertion-derived" : ""}
                  {object.supportingAssertions.length
                    ? ` · supports ${object.supportingAssertions.join(", ")}`
                    : ""}
                </span>
                {object.surfaceForms.length ? (
                  <span className="block text-zinc-500">
                    Surface forms：{object.surfaceForms.join("、")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>

        <details>
          <summary className="cursor-pointer font-medium text-zinc-700">
            Object Higher Memories（{higherMemories.length}）
          </summary>
          <ul className="mt-2 space-y-2">
            {higherMemories.map((memory) => (
              <li key={memory.ref} className="rounded bg-emerald-50 p-2">
                <p className="font-medium text-emerald-900">
                  {memory.ref} · {seedMap.objects.find((object) => object.id === memory.globalObjectId)?.canonicalName ?? memory.globalObjectId}
                </p>
                <p className="whitespace-pre-wrap text-zinc-700">{memory.contentMarkdown}</p>
                <p className="mt-1 text-zinc-500">维护时间：{memory.maintainedAt}</p>
              </li>
            ))}
          </ul>
        </details>

        <details>
          <summary className="cursor-pointer font-medium text-zinc-700">
            Assertion Seeds（{seedMap.assertions.length}）
          </summary>
          <ul className="mt-2 space-y-2">
            {seedMap.assertions.map((assertion) => (
              <li key={assertion.ref} className="rounded bg-zinc-50 p-2">
                <p className="font-medium text-zinc-800">
                  {assertion.ref} · {assertion.renderedStatement}
                </p>
                <p>
                  {assertion.contextDependent ? "上下文依赖" : "自足命题"} · Facets：
                  {assertion.matchedFacets.join(", ") || "无"} · 来源：
                  {assertion.sources.map((source) =>
                    source.kind === "chat" ? `聊天 ${source.evidenceId}` : source.sourceBlockId
                  ).join(", ") || "无"}
                </p>
              </li>
            ))}
          </ul>
        </details>

        <details>
          <summary className="cursor-pointer font-medium text-zinc-700">
            Connections（{seedMap.connections.length}）
          </summary>
          <ul className="mt-2 space-y-1">
            {seedMap.connections.map((connection) => (
              <li key={`${connection.assertionRef}-${connection.objectRef}`}>
                {connection.assertionRef} ↔ {connection.objectRef}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </details>
  );
}

function ChatSurface({
  messages,
  status,
  error,
  historyState,
  historyError,
  input,
  compact = false,
  textareaId,
  onInputChange,
  onSubmit,
  onStop,
  onOpenViewReference,
  onOpenSourceReference,
  onViewProposalApplied,
}: {
  messages: ClubChatMessage[];
  status: ChatStatus;
  error?: Error;
  historyState: ChatHistoryState;
  historyError?: string;
  input: string;
  compact?: boolean;
  textareaId: string;
  onInputChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onStop: () => void;
  onOpenViewReference: (reference: ViewInformationReference) => void;
  onOpenSourceReference: (reference: SourceDocumentReference) => void;
  onViewProposalApplied: (viewKey: string) => void;
}) {
  const isSending = status === "submitted" || status === "streaming";
  const canInteract = historyState === "ready";
  const canSend = input.trim().length > 0 && !isSending && canInteract;
  const isEmptyChat = !compact && messages.length === 0 && historyState === "ready";
  const statusMessage = historyState === "loading"
    ? "正在恢复对话…"
    : historyState === "error"
      ? historyError
      : error?.message;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit(input);
    }
  }

  return (
    <div className={`flex min-h-0 flex-1 flex-col bg-white ${isEmptyChat ? "justify-center pb-16" : ""}`}>
      <div className={isEmptyChat ? "shrink-0 overflow-visible" : "min-h-0 flex-1 overflow-y-auto overscroll-contain"}>
        {messages.length === 0 && historyState === "ready" ? (
          <div className={isEmptyChat ? "mb-4 px-6 text-center" : `flex min-h-full items-center justify-center px-6 text-center ${compact ? "pb-24" : "pb-36"}`}>
            <div>
              <h2 className={`font-medium tracking-[-0.025em] text-zinc-950 ${compact ? "text-lg" : "text-[21px]"}`}>
                今天想一起完成什么？
              </h2>
            </div>
          </div>
        ) : (
        <div className={`mx-auto flex w-full flex-col ${compact ? "gap-4 px-3.5 py-4" : "max-w-[46rem] gap-5 px-5 py-7 sm:px-6 sm:py-8"}`}>
          {messages.map((message, messageIndex) => {
            const isUser = message.role === "user";
            const text = finalStepMessageText(message);
            const reasoning = messageReasoning(message);
            const isActiveAssistant = !isUser && isSending && messageIndex === messages.length - 1;
            const activities = toolActivities(message, isActiveAssistant);
            const search = message.parts.filter((part) => part.type === "data-memorySearch").at(-1)?.data;
            const proposals = message.parts.filter((part) => part.type === "data-viewCommandProposal");
            const objectChangeProposals = message.parts.filter(
              (part) => part.type === "data-objectChangeProposal",
            );
            const libraryProposals = message.parts.filter(
              (part) => part.type === "data-libraryProposal",
            );
            const viewReferences = message.parts
              .filter((part) => part.type === "data-viewReferences")
              .at(-1)?.data.references ?? [];
            const sourceReferences = message.parts
              .filter((part) => part.type === "data-sourceReferences")
              .at(-1)?.data.references ?? [];
            const artifactReferences = message.parts
              .filter((part) => part.type === "data-artifactReferences")
              .at(-1)?.data.references ?? [];
            const streamStatus = message.parts
              .filter((part) => part.type === "data-streamStatus")
              .at(-1)?.data;
            const trace = search?.trace;
            const answerUsedAssertionRefs = search?.answerUsedAssertionRefs ?? trace?.answerUsedAssertionRefs ?? [];
            const usedAssertionRefs = new Set(answerUsedAssertionRefs);
            const sources = search?.seedMap.assertions
              .filter((assertion) => usedAssertionRefs.has(assertion.ref))
              .flatMap((assertion) => assertion.sources.map((source) => ({ assertion, source }))) ?? [];

            return (
              <article key={message.id} className={`flex items-start ${isUser ? "justify-end" : "gap-2.5"}`}>
                {!isUser ? (
                  <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-[9px] font-semibold text-white">
                    S
                  </div>
                ) : null}
                <div className={`${isUser
                  ? `${compact ? "max-w-[88%]" : "max-w-[75%]"} rounded-[18px] bg-[#f4f4f4] px-3.5 py-2 text-zinc-900`
                  : "min-w-0 flex-1 text-zinc-800"
                } text-[14px] leading-6`}>
                  {text || (isActiveAssistant && !activities.length) ? (
                    <MarkdownText
                      text={text || "正在回答…"}
                      references={viewReferences}
                      sourceReferences={sourceReferences}
                      artifactReferences={artifactReferences}
                      onOpenViewReference={onOpenViewReference}
                      onOpenSourceReference={onOpenSourceReference}
                      inverse={isUser}
                    />
                  ) : null}
                  <ToolActivityList activities={activities} />
                  {reasoning ? (
                    <details className="mt-3 border-t border-zinc-200 pt-2 text-xs text-zinc-600">
                      <summary className="cursor-pointer font-medium text-zinc-700">模型思考（调试信息）</summary>
                      <p className="mt-1 text-zinc-500">这是模型生成的中间过程，不作为组织事实依据。</p>
                      <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-100 p-3 font-mono leading-5 text-zinc-700">{reasoning}</div>
                    </details>
                  ) : null}
                  {streamStatus && streamStatus.status !== "completed" ? (
                    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                      本轮回答未完整完成：{streamStatus.status === "failed"
                        ? streamStatus.failureCode === "timeout"
                          ? "模型响应超时"
                          : streamStatus.failureCode === "stream_aborted"
                            ? "连接或请求被中断"
                            : streamStatus.failureCode === "upstream_error"
                              ? "上游模型服务返回错误"
                              : "模型流异常结束"
                        : streamStatus.completionKind === "tool_call"
                          ? "模型停在工具调用阶段，未生成最终正文"
                          : "模型未生成完整正文"}。
                      已保留中间内容
                      {streamStatus.retryCount > 0
                        ? `，模型层已自动重试 ${streamStatus.retryCount} 次`
                        : ""}
                      ，可重新发起请求。
                    </div>
                  ) : null}
                  {search ? <SeedMapPanel seedMap={search.seedMap} /> : null}
                  {proposals.map((part) => (
                    <ViewCommandProposalCard
                      key={part.data.proposalId}
                      proposal={part.data}
                      onApplied={onViewProposalApplied}
                    />
                  ))}
                  {objectChangeProposals.map((part) => (
                    <ObjectChangeProposalCard
                      key={part.data.id}
                      proposal={part.data}
                    />
                  ))}
                  {libraryProposals.map((part) => (
                    <LibraryProposalCard
                      key={part.data.id}
                      proposal={part.data}
                    />
                  ))}
                  {sources.length ? (
                    <details className="mt-3 border-t border-zinc-200 pt-2 text-xs text-zinc-600">
                      <summary className="cursor-pointer font-medium text-emerald-800">Assertion / Sources（{sources.length}）</summary>
                      <ul className="mt-2 space-y-2">
                        {sources.map(({ assertion, source }) => (
                          <li key={`${assertion.ref}-${source.kind === "chat" ? source.evidenceId : source.sourceBlockId}-${source.ordinal}`} className="rounded-md bg-white p-2">
                            <p className="font-medium text-zinc-800">{assertion.ref} · {assertion.renderedStatement}</p>
                            <p className="text-zinc-500">
                              {source.kind === "chat"
                                ? `${source.actorDisplayName} 的聊天陈述 · ${source.submittedAt} · ${source.timezone}`
                                : `${source.sourceTitle} · ${source.sourceBlockId}${source.pages.length ? ` · p.${source.pages.join(",")}` : ""}`}
                            </p>
                            {source.excerpt ? <p className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap text-zinc-500">{source.excerpt}</p> : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {trace ? (
                    <details className="mt-3 border-t border-zinc-200 pt-2 text-xs text-zinc-600">
                      <summary className="cursor-pointer font-medium text-sky-800">Locate Trace（{trace.durationMs} ms）</summary>
                      <div className="mt-2 space-y-3 rounded-md bg-white p-3">
                        <p>Query：{trace.query}</p>
                        <p>Shared Brain：{trace.snapshot.globalObjectCount} Global Objects · {trace.snapshot.assertionCount} Assertions</p>
                        <p>Source IR：{trace.snapshot.objectFragmentCount} Fragments · {trace.snapshot.surfaceFormCount} Surface forms · {trace.snapshot.fragmentReferenceCount} References</p>
                        <p>Assertion embeddings：{trace.snapshot.embeddingModel ? `${trace.snapshot.embeddingModel}@${trace.snapshot.embeddingRevision ?? "unknown"}/${trace.snapshot.embeddingDimension ?? "unknown"} · ${trace.snapshot.embeddingAssertionCount}` : `未建立 · ${trace.snapshot.embeddingAssertionCount}`}</p>
                        <div>
                          <p className="font-medium text-zinc-700">Facets</p>
                          <ul className="mt-1 list-disc pl-5">{trace.facets.map((facet) => <li key={facet.id}>{facet.id} · {facet.text}（{facet.source}）</li>)}</ul>
                        </div>
                        <TraceChannel title="Global Object lexical" channels={trace.objectLexical} />
                        <TraceChannel title="Assertion lexical" channels={trace.assertionLexical} />
                        <TraceChannel title="Assertion vector" channels={trace.assertionVector} />
                        <details>
                          <summary className="cursor-pointer font-medium text-zinc-700">Semantic-derived Global Objects（{trace.semanticDerivedObjects.length}）</summary>
                          <ul className="mt-1 space-y-1">{trace.semanticDerivedObjects.map((object) => <li key={object.objectRef}>{object.objectRef} · {object.canonicalName} ← {object.supportingAssertions.join(", ")}</li>)}</ul>
                        </details>
                        <p>该次 Locate Seed Map：{trace.finalSeedMap.objectRefs.length} Global Objects · {trace.finalSeedMap.assertionRefs.length} Assertions · {trace.finalSeedMap.connections} Connections</p>
                        <p>回答实际引用：{answerUsedAssertionRefs.join(", ") || "未检测到 [A#] 引用"}</p>
                        {trace.warnings.map((warning) => <p key={warning} className="text-amber-700">{warning}</p>)}
                      </div>
                    </details>
                  ) : null}
                </div>
              </article>
            );
          })}
          {status === "submitted" ? (
            <article className="flex items-center gap-2.5 text-[13px] text-zinc-500">
              <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-[9px] font-semibold text-white">S</div>
              <span>正在思考</span>
              <span className="flex gap-1" aria-hidden="true">
                <span className="size-1 animate-pulse rounded-full bg-zinc-400" />
                <span className="size-1 animate-pulse rounded-full bg-zinc-400 [animation-delay:120ms]" />
                <span className="size-1 animate-pulse rounded-full bg-zinc-400 [animation-delay:240ms]" />
              </span>
            </article>
          ) : null}
        </div>
        )}
      </div>

      <div className={isEmptyChat
        ? "shrink-0 bg-white px-4 pb-0 pt-0 sm:px-6"
        : `shrink-0 bg-gradient-to-t from-white via-white to-white/0 px-4 pb-3 pt-2 ${compact ? "" : "sm:px-6 sm:pb-4"}`
      }>
        <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-[46rem] items-end gap-1.5 rounded-[24px] border border-zinc-200 bg-white p-2 shadow-[0_5px_22px_rgba(0,0,0,0.07)] transition-shadow focus-within:border-zinc-300 focus-within:shadow-[0_7px_26px_rgba(0,0,0,0.09)]">
          <label className="sr-only" htmlFor={textareaId}>向 Sydaris 提问</label>
          <textarea
            id={textareaId}
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isSending || !canInteract}
            className="min-h-8 max-h-40 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-1 text-[14px] leading-6 text-zinc-950 outline-none [field-sizing:content] placeholder:text-zinc-400 disabled:opacity-60"
            placeholder={compact ? "继续提问" : "向 Sydaris 提问"}
          />
          {isSending ? (
            <button type="button" onClick={onStop} aria-label="停止生成" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white transition hover:bg-zinc-700">
              <span className="size-2.5 rounded-[2px] bg-white" />
            </button>
          ) : (
            <button type="submit" disabled={!canSend} aria-label="发送" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white transition hover:bg-zinc-700 disabled:bg-zinc-200 disabled:text-zinc-400">
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                <path d="M12 19V5m0 0-5 5m5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </form>
        {statusMessage ? (
          <p className={`mx-auto mt-1.5 max-w-[46rem] truncate px-2 text-center text-[10px] ${historyState === "error" || error ? "text-red-600" : "text-zinc-400"}`} role="status">{statusMessage}</p>
        ) : null}
      </div>
    </div>
  );
}

function SourceDocumentDialog({
  reference,
  onClose,
}: {
  reference: SourceDocumentReference;
  onClose: () => void;
}) {
  const referenceKey = `${reference.document.id}\u0000${reference.startBlockId}\u0000${reference.endBlockId}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    blocks?: SourceDocumentBlock[];
    error?: string;
  }>({ key: referenceKey });
  const blocks = loaded.key === referenceKey ? loaded.blocks : undefined;
  const loadError = loaded.key === referenceKey ? loaded.error : undefined;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      startBlockId: reference.startBlockId,
      endBlockId: reference.endBlockId,
    });
    void fetch(
      `/api/source-documents/${encodeURIComponent(reference.document.id)}/excerpt?${params}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const body = await response.json() as {
          blocks?: SourceDocumentBlock[];
          error?: string;
        };
        if (!response.ok || !body.blocks) {
          throw new Error(body.error || "无法读取原文");
        }
        setLoaded({ key: referenceKey, blocks: body.blocks });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({
          key: referenceKey,
          error: error instanceof Error ? error.message : "无法读取原文",
        });
      });
    return () => controller.abort();
  }, [reference.document.id, reference.endBlockId, reference.startBlockId, referenceKey]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/45 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label={`查看原文 ${reference.document.title}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="flex max-h-[88dvh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">
              {reference.ref} · Source Document
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold text-zinc-950">
              {reference.document.title}
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              {reference.selection.label}
              {reference.pages.length ? ` · p.${reference.pages.join(", ")}` : ""}
              {` · ${reference.blockCount} 个 SourceBlock`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭原文"
            className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
          >
            ×
          </button>
        </header>
        <div className="overflow-y-auto bg-[#fafaf8] px-5 py-4">
          {!blocks && !loadError ? (
            <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500">
              正在按需读取原文…
            </p>
          ) : null}
          {loadError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {loadError}
            </p>
          ) : null}
          <div className="space-y-3">
            {blocks?.map((block) => (
              <article
                key={`${reference.ref}-${block.sourceBlockId}`}
                className="rounded-lg border border-zinc-200 bg-white p-4"
              >
                <p className="mb-2 text-[11px] font-medium text-zinc-400">
                  {block.sourceBlockId} · order {block.order}
                  {block.pages.length ? ` · p.${block.pages.join(", ")}` : ""}
                  {block.headingPath.length ? ` · ${block.headingPath.join(" / ")}` : ""}
                </p>
                <div className="break-words text-sm leading-6 text-zinc-800">
                  <MarkdownText text={block.markdown} />
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export default function Home() {
  const [input, setInput] = useState("");
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>("work");
  const [libraryMode, setLibraryMode] = useState<LibraryMode>("files");
  const [activeWorkViewKey, setActiveWorkViewKey] = useState<string>();
  const [activeLibraryFolderId, setActiveLibraryFolderId] = useState<string>();
  const [viewFocusCardId, setViewFocusCardId] = useState<string>();
  const [installedViews, setInstalledViews] = useState<InstalledViewSummary[]>([]);
  const [installedViewsLoaded, setInstalledViewsLoaded] = useState(false);
  const [workInspectorOpen, setWorkInspectorOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() =>
    typeof window === "undefined"
      ? "focus"
      : storedLayoutMode(window.localStorage.getItem(layoutModeStorageKey)) ?? "focus"
  );
  const [surfaceShare, setSurfaceShare] = useState(66);
  const [viewRefreshRevisions, setViewRefreshRevisions] = useState<Record<string, number>>({});
  const [paneDragging, setPaneDragging] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const paneDragRef = useRef<{
    pointerId: number;
    bounds: DOMRect;
    samples: Array<{ x: number; time: number }>;
  } | undefined>(undefined);
  const [sourceReference, setSourceReference] = useState<SourceDocumentReference>();
  const [currentUser, setCurrentUser] = useState<CurrentUser>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const transport = useMemo(() => new DefaultChatTransport<ClubChatMessage>({
    api: "/api/chat",
    prepareSendMessagesRequest: ({ messages, body }) => ({
      body: {
        ...body,
        messages: compactChatRequestMessages(messages),
      },
    }),
  }), []);
  const { messages, sendMessage, status, stop, error, clearError, setMessages } = useChat<ClubChatMessage>({
    messages: initialMessages,
    transport,
  });
  const [historyState, setHistoryState] = useState<ChatHistoryState>("loading");
  const [historyError, setHistoryError] = useState<string>();
  const isSending = status === "submitted" || status === "streaming";

  useEffect(() => {
    window.localStorage.setItem(layoutModeStorageKey, layoutMode);
  }, [layoutMode]);

  const refreshViewAfterProposal = useCallback((viewKey: string) => {
    setViewRefreshRevisions((current) => ({
      ...current,
      [viewKey]: (current[viewKey] ?? 0) + 1,
    }));
  }, []);

  const refreshConversations = useCallback(async () => {
    const response = await fetch("/api/chat/conversations", { cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/login");
      return [];
    }
    const body = await response.json() as {
      conversations?: ConversationSummary[];
      error?: string;
    };
    if (!response.ok || !body.conversations) {
      throw new Error(body.error ?? "无法读取对话列表。");
    }
    setConversations(body.conversations);
    return body.conversations;
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function bootstrap() {
      try {
        const meResponse = await fetch("/api/auth/me", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (meResponse.status === 401) {
          window.location.assign("/login");
          return;
        }
        const meBody = await meResponse.json() as {
          user?: CurrentUser;
          error?: string;
        };
        if (!meResponse.ok || !meBody.user) {
          throw new Error(meBody.error ?? "无法读取登录状态。");
        }
        setCurrentUser(meBody.user);
        let items = await refreshConversations();
        if (!items.length) {
          const createResponse = await fetch("/api/chat/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
            signal: controller.signal,
          });
          const createBody = await createResponse.json() as {
            conversation?: ConversationSummary;
            error?: string;
          };
          if (!createResponse.ok || !createBody.conversation) {
            throw new Error(createBody.error ?? "无法创建初始对话。");
          }
          items = [createBody.conversation];
          setConversations(items);
        }
        setActiveConversationId(items[0].id);
      } catch (bootstrapError) {
        if (controller.signal.aborted) return;
        setHistoryError(
          bootstrapError instanceof Error
            ? bootstrapError.message
            : "无法初始化 Sydaris。",
        );
        setHistoryState("error");
      }
    }

    void bootstrap();
    return () => controller.abort();
  }, [refreshConversations]);

  useEffect(() => {
    if (!activeConversationId) return;
    const controller = new AbortController();
    void fetch(`/api/chat/conversations/${activeConversationId}/messages`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as {
        messages?: ClubChatMessage[];
        error?: string;
      };
      if (!response.ok || !Array.isArray(body.messages)) {
        throw new Error(body.error ?? "无法从服务器恢复对话。");
      }
      setMessages([
        ...initialMessages,
        ...body.messages.filter((message) => message.id !== "welcome"),
      ]);
      setHistoryState("ready");
    }).catch((loadError) => {
      if (controller.signal.aborted) return;
      setHistoryError(loadError instanceof Error ? loadError.message : "无法恢复对话。");
      setHistoryState("error");
    });
    return () => controller.abort();
  }, [activeConversationId, setMessages]);

  useEffect(() => {
    if (!currentUser) return;
    const controller = new AbortController();
    void fetch("/api/views", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { views?: InstalledViewSummary[]; error?: string };
        if (!response.ok || !body.views) throw new Error(body.error ?? "无法读取 View 列表");
        const enabledViews = body.views.filter((view) => view.status === "enabled");
        setInstalledViews(enabledViews);
        setActiveWorkViewKey((current) => {
          const restored = current ?? window.localStorage.getItem("sydaris.activeWorkView") ?? undefined;
          return enabledViews.some((view) => view.viewKey === restored)
            ? restored
            : enabledViews[0]?.viewKey;
        });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) console.error("[views.list]", cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setInstalledViewsLoaded(true);
      });
    return () => controller.abort();
  }, [currentUser]);

  const surfacePaneVisible = layoutMode !== "conversation";
  const aiPaneVisible = layoutMode !== "focus";

  const pageContext: ChatPageContext = !surfacePaneVisible
    ? { activePresentation: "full_chat" }
    : surfaceMode === "knowledge"
      ? { activePresentation: "knowledge" }
      : surfaceMode === "library"
        ? { activePresentation: "library", activeFolderId: activeLibraryFolderId }
        : activeWorkViewKey
          ? {
              activeViewKey: activeWorkViewKey,
              activePresentation: workInspectorOpen ? "inspector" : "work",
              ...(viewFocusCardId ? { activeCardId: viewFocusCardId } : {}),
            }
          : { activePresentation: "full_chat" };

  function submit(content: string) {
    const text = content.trim();
    if (!text || !activeConversationId || isSending || historyState !== "ready") return;
    clearError();
    setInput("");
    void sendMessage(
      { text },
      { body: { pageContext, conversationId: activeConversationId } },
    ).finally(() => void refreshConversations());
  }

  function invokeAI(invocation: AIInvocation) {
    const message = invocation.message.trim();
    if (!message || !activeConversationId || isSending || historyState !== "ready") return;
    clearError();
    setInput("");
    setLayoutMode("collaborate");
    void sendMessage(
      {
        parts: [
          { type: "text", text: message },
          {
            type: "data-aiInvocation",
            data: { ...invocation, message },
          },
        ],
      },
      { body: { pageContext, conversationId: activeConversationId } },
    ).finally(() => void refreshConversations());
  }

  function activateConversation(conversationId: string) {
    setHistoryState("loading");
    setHistoryError(undefined);
    setMessages(initialMessages);
    setActiveConversationId(conversationId);
  }

  async function createConversation() {
    if (isSending) return;
    const response = await fetch("/api/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json() as {
      conversation?: ConversationSummary;
      error?: string;
    };
    if (!response.ok || !body.conversation) {
      setHistoryError(body.error ?? "无法创建对话。");
      return;
    }
    setConversations((current) => [body.conversation!, ...current]);
    activateConversation(body.conversation.id);
    setLayoutMode((current) => current === "conversation" ? current : "collaborate");
  }

  async function renameConversation(conversation: ConversationSummary) {
    const title = window.prompt("输入新的对话标题：", conversation.title)?.trim();
    if (!title) return;
    const response = await fetch(`/api/chat/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (response.ok) await refreshConversations();
  }

  async function archiveConversation(conversation: ConversationSummary) {
    if (isSending) return;
    const response = await fetch(`/api/chat/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    if (!response.ok) return;
    const remaining = conversations.filter((item) => item.id !== conversation.id);
    setConversations(remaining);
    if (activeConversationId === conversation.id) {
      if (remaining[0]) activateConversation(remaining[0].id);
      else await createConversation();
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  function openWorkView(viewKey: string) {
    setSurfaceMode("work");
    setActiveWorkViewKey(viewKey);
    window.localStorage.setItem("sydaris.activeWorkView", viewKey);
    setViewFocusCardId(undefined);
    setWorkInspectorOpen(false);
    setLayoutMode("focus");
  }

  function openViewReference(reference: ViewInformationReference) {
    setSurfaceMode("work");
    setActiveWorkViewKey(reference.target.viewKey);
    window.localStorage.setItem("sydaris.activeWorkView", reference.target.viewKey);
    setWorkInspectorOpen(false);
    setLayoutMode("collaborate");
    setViewFocusCardId(reference.target.kind === "card" ? reference.target.cardId : undefined);
  }

  function selectSurfaceMode(mode: SurfaceMode) {
    setSurfaceMode(mode);
    setViewFocusCardId(undefined);
    if (mode === "work") setWorkInspectorOpen(false);
    if (layoutMode === "conversation") setLayoutMode("focus");
  }

  function beginPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (layoutMode !== "collaborate") return;
    event.preventDefault();
    const bounds = splitContainerRef.current?.getBoundingClientRect();
    if (!bounds || !bounds.width) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    paneDragRef.current = {
      pointerId: event.pointerId,
      bounds,
      samples: [{ x: event.clientX, time: event.timeStamp }],
    };
    setPaneDragging(true);
    const body = document.body;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
  }

  function movePaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = paneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const share = (event.clientX - drag.bounds.left) / drag.bounds.width * 100;
    setSurfaceShare(Math.min(96, Math.max(4, share)));
    drag.samples.push({ x: event.clientX, time: event.timeStamp });
    if (drag.samples.length > 5) drag.samples.shift();
  }

  function finishPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = paneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const first = drag.samples[0];
    const last = drag.samples.at(-1) ?? first;
    const elapsed = Math.max(1, last.time - first.time);
    const velocity = (last.x - first.x) / elapsed;
    const projectedX = last.x + velocity * 180;
    const projectedShare = (projectedX - drag.bounds.left) / drag.bounds.width * 100;

    paneDragRef.current = undefined;
    setPaneDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (projectedShare >= 84) {
      setLayoutMode("focus");
      setSurfaceShare(66);
    } else if (projectedShare <= 16) {
      setLayoutMode("conversation");
      setSurfaceShare(66);
    } else {
      setSurfaceShare(66);
    }
  }

  function cancelPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = paneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    paneDragRef.current = undefined;
    setPaneDragging(false);
    setSurfaceShare(66);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    setSurfaceShare((current) =>
      Math.min(80, Math.max(20, current + direction * 5))
    );
  }

  if (!currentUser) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#eef2ef] px-5 text-zinc-700">
        <div className="max-w-md rounded-xl border border-zinc-200 bg-white px-6 py-5 text-center shadow-sm">
          <p className="font-medium">{historyState === "error" ? "Sydaris 初始化失败" : "正在进入 Sydaris…"}</p>
          {historyError ? <p className="mt-2 text-sm text-red-700">{historyError}</p> : null}
          {historyState === "error" ? <button onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-emerald-800 px-4 py-2 text-sm text-white">重试</button> : null}
        </div>
      </main>
    );
  }

  const bothPanesVisible = layoutMode === "collaborate";
  const activeWorkView = installedViews.find((view) => view.viewKey === activeWorkViewKey);
  const surfaceStyle = {
    flexBasis: 0,
    flexGrow: layoutMode === "focus" ? 100 : layoutMode === "conversation" ? 0 : surfaceShare,
  };
  const aiStyle = {
    flexBasis: 0,
    flexGrow: layoutMode === "conversation" ? 100 : layoutMode === "focus" ? 0 : 100 - surfaceShare,
  };

  const navigationRail = (
    <aside
      aria-label="Sydaris 主导航"
      className={`group absolute inset-y-0 left-0 z-40 flex flex-col overflow-hidden border-r backdrop-blur-2xl transition-[width,padding,background-color,border-color,box-shadow] duration-500 ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none hover:w-48 hover:border-zinc-200/80 hover:bg-white/94 hover:px-2 hover:shadow-[18px_0_48px_rgba(0,0,0,0.14)] focus-within:w-48 focus-within:border-zinc-200/80 focus-within:bg-white/94 focus-within:px-2 focus-within:shadow-[18px_0_48px_rgba(0,0,0,0.14)] ${
        layoutMode === "focus"
          ? "w-2 border-transparent bg-transparent px-0"
          : "w-12 border-zinc-200/80 bg-white/90 px-1.5"
      }`}
    >
      <div className={`flex h-full w-44 flex-col gap-2 py-2 transition-opacity duration-200 ${
        layoutMode === "focus"
          ? "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          : "opacity-100"
      }`}>
        <div className="flex h-9 shrink-0 items-center gap-3 rounded-[10px] px-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-[8px] bg-zinc-950 text-[10px] font-semibold text-white shadow-sm">S</span>
          <span className="text-[14px] font-semibold tracking-[-0.02em] text-zinc-950 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">Sydaris</span>
        </div>

        <nav className="space-y-1" aria-label="工作空间">
          {([
            ["work", "工作"],
            ["knowledge", "知识"],
            ["library", "资料"],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => selectSurfaceMode(mode)}
              aria-current={surfaceMode === mode ? "page" : undefined}
              aria-label={label}
              className={`flex h-9 w-full items-center gap-3 rounded-[10px] px-2 text-left text-[12px] font-medium transition ${
                surfaceMode === mode
                  ? "bg-sky-50 text-sky-700"
                  : "text-zinc-500 hover:bg-zinc-100/90 hover:text-zinc-900"
              }`}
            >
              {mode === "work" ? (
                <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <path d="M4 8.5h16v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M9 8.5V6.8A1.8 1.8 0 0 1 10.8 5h2.4A1.8 1.8 0 0 1 15 6.8v1.7M4 12h16" strokeLinecap="round" />
                </svg>
              ) : mode === "knowledge" ? (
                <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <circle cx="6" cy="12" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="18" cy="18" r="2.2" />
                  <path d="m8 11 7.8-4M8 13l7.8 4" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <path d="M3.5 7.5h6l1.7 2H20.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              <span className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">{label}</span>
            </button>
          ))}
        </nav>

        {surfaceMode === "work" ? (
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-zinc-200/70 pt-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            <p className="px-2 text-[10px] font-semibold tracking-[0.08em] text-zinc-400">工作视图</p>
            <div className="mt-1.5 space-y-1">
              {installedViews.map((view) => (
                <button
                  key={view.viewKey}
                  type="button"
                  onClick={() => openWorkView(view.viewKey)}
                  className={`w-full rounded-lg px-2 py-2 text-left text-[12px] transition ${
                    activeWorkViewKey === view.viewKey
                      ? "bg-zinc-100 font-medium text-zinc-950"
                      : "text-zinc-500 hover:bg-zinc-100/80 hover:text-zinc-900"
                  }`}
                >
                  {view.specializedLabel ?? view.label}
                </button>
              ))}
            </div>
          </div>
        ) : <div className="flex-1" />}

        <div className="space-y-1 border-t border-zinc-200/70 pt-2">
          {currentUser.role === "ADMIN" ? (
            <button
              type="button"
              onClick={() => window.location.assign("/admin/users")}
              aria-label="账号管理"
              className="flex h-9 w-full items-center gap-3 rounded-[10px] px-2 text-[12px] text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
            >
              <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <circle cx="12" cy="8" r="3" /><path d="M5.5 19a6.5 6.5 0 0 1 13 0" strokeLinecap="round" />
              </svg>
              <span className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">账号管理</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void logout()}
            aria-label="退出登录"
            className="flex h-9 w-full items-center gap-3 rounded-[10px] px-2 text-[12px] text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[9px] font-semibold text-zinc-700">{currentUser.actor.displayName.slice(0, 1).toUpperCase()}</span>
            <span className="truncate opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">{currentUser.actor.displayName} · 退出</span>
          </button>
        </div>
      </div>
    </aside>
  );

  const surfaceMain = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
      {surfaceMode === "work" ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {activeWorkViewKey ? (
            workInspectorOpen ? (
              <GenericViewInspector
                key={activeWorkViewKey}
                viewKey={activeWorkViewKey}
                refreshRevision={viewRefreshRevisions[activeWorkViewKey] ?? 0}
                focusCardId={viewFocusCardId}
                onClose={() => setWorkInspectorOpen(false)}
                onOpenAI={() => setLayoutMode("collaborate")}
                onInvokeAI={invokeAI}
              />
            ) : (
              <WorkPresentationHost
                key={activeWorkViewKey}
                viewKey={activeWorkViewKey}
                refreshRevision={viewRefreshRevisions[activeWorkViewKey] ?? 0}
                presentationLoader={activeWorkView?.presentation?.loader}
                focusCardId={viewFocusCardId}
                activeConversationId={activeConversationId}
                onOpenInspector={() => setWorkInspectorOpen(true)}
                onInvokeAI={invokeAI}
              />
            )
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-zinc-400">
              {installedViewsLoaded ? "没有可用的 Work View。" : "正在恢复 Work View…"}
            </div>
          )}
        </div>
      ) : surfaceMode === "knowledge" ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <KnowledgeGraphWorkspace
              assistantOpen={aiPaneVisible}
              onInvokeAI={invokeAI}
            />
          </div>
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {libraryMode === "files" ? (
              <LibraryWorkspace
                initialFolderId={activeLibraryFolderId}
                onFolderChange={setActiveLibraryFolderId}
                onOpenProcessing={() => setLibraryMode("processing")}
                onOpenAI={() => setLayoutMode("collaborate")}
                onInvokeAI={invokeAI}
              />
            ) : (
              <CompilationWorkspace
                onOpenLibrary={() => setLibraryMode("files")}
                onInvokeAI={invokeAI}
              />
            )}
          </div>
        )}
    </div>
  );

  const surfacePane = (
    <section
      aria-label="工作区"
      aria-hidden={!surfacePaneVisible}
      inert={!surfacePaneVisible}
      className={`flex h-full min-h-0 min-w-0 overflow-hidden bg-white motion-reduce:transition-none ${
        paneDragging ? "" : "transition-[flex-grow] duration-500 ease-[cubic-bezier(.16,1,.3,1)]"
      }`}
      style={surfaceStyle}
    >
      {surfaceMain}
    </section>
  );

  const aiSidebar = (
    <nav
      aria-label="AI 对话"
      className="flex w-[236px] shrink-0 flex-col overflow-hidden border-r border-[#e8e8e8] bg-[#f7f7f8] px-2.5 pb-2.5 pt-2"
    >
      <div className="flex h-11 shrink-0 items-center justify-center">
        <p className="text-[16px] font-semibold tracking-[-0.02em] text-zinc-900">Sydaris</p>
      </div>

      <button
        type="button"
        disabled={isSending}
        onClick={() => void createConversation()}
        className="mt-0.5 flex h-[34px] w-full shrink-0 items-center gap-2.5 rounded-lg px-2 text-left text-[12px] font-medium text-zinc-800 transition hover:bg-[#ececec] disabled:opacity-40"
      >
        <svg viewBox="0 0 24 24" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <path d="M12 20H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m14 4 6 6m-7 1 6.5-6.5a1.4 1.4 0 0 0-2-2L11 9l-1 3 3-1Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        新对话
      </button>

      <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-zinc-200/80 pt-3">
        <p className="px-2 text-[11px] font-medium text-zinc-500">最近对话</p>
        <div className="mt-1 min-h-0 space-y-px overflow-y-auto pr-0.5">
          {conversations.map((conversation) => (
            <div key={conversation.id} className={`group flex items-center rounded-lg transition ${
              activeConversationId === conversation.id
                ? "bg-[#e9e9e9] text-zinc-950"
                : "text-zinc-700 hover:bg-[#ececec]"
            }`}>
              <button
                type="button"
                onClick={() => {
                  if (isSending || conversation.id === activeConversationId) return;
                  activateConversation(conversation.id);
                }}
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[12px] leading-5"
                title={conversation.title}
              >
                {conversation.title}
              </button>
              <button type="button" aria-label="重命名对话" title="重命名" onClick={() => void renameConversation(conversation)} className="hidden px-1 py-1.5 text-[11px] text-zinc-500 hover:text-zinc-950 group-hover:block">✎</button>
              <button type="button" aria-label="归档对话" title="归档" onClick={() => void archiveConversation(conversation)} className="hidden px-1.5 py-1.5 text-sm leading-none text-zinc-500 hover:text-zinc-950 group-hover:block">×</button>
            </div>
          ))}
        </div>
      </div>

    </nav>
  );

  const aiChat = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-white">
      <ChatSurface compact={bothPanesVisible} messages={messages} status={status} error={error} historyState={historyState} historyError={historyError} input={input} textareaId="ai-pane-input" onInputChange={setInput} onSubmit={submit} onStop={stop} onOpenViewReference={openViewReference} onOpenSourceReference={setSourceReference} onViewProposalApplied={refreshViewAfterProposal} />
    </div>
  );

  const aiPane = (
    <section
      aria-label="AI Pane"
      aria-hidden={!aiPaneVisible}
      inert={!aiPaneVisible}
      className={`flex h-full min-h-0 min-w-0 overflow-hidden bg-white motion-reduce:transition-none ${
        paneDragging ? "" : "transition-[flex-grow] duration-500 ease-[cubic-bezier(.16,1,.3,1)]"
      }`}
      style={aiStyle}
    >
      {layoutMode === "conversation" ? aiSidebar : null}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-white">
        <header className={layoutMode === "conversation"
          ? "pointer-events-none absolute right-3 top-2 z-20 flex items-center"
          : "flex h-12 shrink-0 items-center justify-between bg-white/88 px-3 backdrop-blur-xl"
        }>
          {layoutMode === "collaborate" ? (
            <div className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em] text-zinc-900">
              <span className="flex size-6 items-center justify-center rounded-full bg-zinc-950 text-[9px] text-white">S</span>
              Sydaris
            </div>
          ) : null}
          <div className={`pointer-events-auto flex items-center gap-1 ${
            layoutMode === "conversation"
              ? "rounded-xl border border-zinc-200/80 bg-white/88 p-1 shadow-sm backdrop-blur-xl"
              : ""
          }`}>
            {layoutMode === "collaborate" ? (
              <button
                type="button"
                onClick={() => setLayoutMode("conversation")}
                aria-label="展开为对话视图"
                title="展开为对话"
                className="flex size-8 items-center justify-center rounded-[9px] text-zinc-500 transition active:scale-95 hover:bg-zinc-100 hover:text-zinc-900"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setLayoutMode("collaborate")}
                aria-label="缩回协作视图"
                title="缩回协作"
                className="flex size-8 items-center justify-center rounded-[9px] text-zinc-500 transition active:scale-95 hover:bg-zinc-100 hover:text-zinc-900"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
                  <path d="M14.5 4.5v15M11.5 12h-4m0 0 2-2m-2 2 2 2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={() => setLayoutMode("focus")}
              aria-label="关闭 Sydaris，进入专注视图"
              title="关闭 Sydaris"
              className="flex size-8 items-center justify-center rounded-[9px] text-zinc-500 transition active:scale-95 hover:bg-zinc-100 hover:text-zinc-900"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="m7 7 10 10M17 7 7 17" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1">{aiChat}</div>
      </div>
    </section>
  );

  const divider = bothPanesVisible ? (
    <div
      role="separator"
      aria-label="调整工作区与 AI 宽度"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(surfaceShare)}
      tabIndex={0}
      onPointerDown={beginPaneResize}
      onPointerMove={movePaneResize}
      onPointerUp={finishPaneResize}
      onPointerCancel={cancelPaneResize}
      onKeyDown={resizeWithKeyboard}
      onDoubleClick={() => setSurfaceShare(66)}
      className="group/divider relative z-20 w-2.5 shrink-0 touch-none cursor-col-resize bg-zinc-100 outline-none focus-visible:bg-sky-50"
    >
      <span className={`absolute left-1/2 top-1/2 flex h-14 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-white text-zinc-400 shadow-[0_8px_24px_rgba(0,0,0,0.15)] transition-[color,transform,border-color] motion-reduce:transition-none group-hover/divider:border-sky-300 group-hover/divider:text-sky-600 ${
        paneDragging ? "scale-105 border-sky-300 text-sky-600" : "border-zinc-200"
      }`}>
        <svg viewBox="0 0 16 24" className="h-5 w-3" fill="currentColor" aria-hidden="true">
          <circle cx="6" cy="7" r="1" /><circle cx="10" cy="7" r="1" />
          <circle cx="6" cy="12" r="1" /><circle cx="10" cy="12" r="1" />
          <circle cx="6" cy="17" r="1" /><circle cx="10" cy="17" r="1" />
        </svg>
      </span>
    </div>
  ) : null;

  return (
    <main className="relative flex h-dvh min-h-0 overflow-hidden bg-white text-zinc-950">
      {navigationRail}
      <div
        ref={splitContainerRef}
        className={`flex min-h-0 min-w-0 flex-1 transition-[margin-left] duration-500 ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none ${
          layoutMode === "focus" ? "ml-0" : "ml-12"
        }`}
      >
        {surfacePane}
        {divider}
        {aiPane}
      </div>
      {layoutMode === "focus" ? (
        <button
          type="button"
          onClick={() => setLayoutMode("collaborate")}
          aria-label="打开 Sydaris，与当前工作区协作"
          title="打开 Sydaris"
          className="absolute bottom-5 right-5 z-30 flex size-12 items-center justify-center rounded-full border border-white/25 bg-sky-600 text-[11px] font-semibold text-white shadow-[0_14px_36px_rgba(2,82,153,0.38),inset_0_1px_0_rgba(255,255,255,0.3)] backdrop-blur-xl transition active:scale-95 hover:bg-sky-500"
        >
          Sydaris
        </button>
      ) : null}
      {sourceReference ? (
        <SourceDocumentDialog
          reference={sourceReference}
          onClose={() => setSourceReference(undefined)}
        />
      ) : null}
    </main>
  );
}
