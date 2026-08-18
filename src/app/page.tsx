"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type ChatStatus,
} from "ai";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ChatPageContext, ClubChatMessage } from "@/ai/types";
import type { ArtifactReference } from "@/library/artifact-references";
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
import {
  SemanticViewWorkspace,
  ViewProposalCard,
} from "@/semantic-view/components";
import { proposalChangeFocus } from "@/semantic-view/proposal-preview";
import {
  ACTIVITY_OPERATIONS_VIEW,
  SOCIETY_INFORMATION_VIEW,
  type BusinessViewKey,
  type BusinessViewPresentation,
  type SemanticViewFocus,
  type SemanticViewReference,
  type ViewProposalPresentation,
} from "@/semantic-view/types";

const initialMessages: ClubChatMessage[] = [];

type ChatHistoryState = "loading" | "ready" | "error";
type WorkspaceKey = "chat" | "knowledge-graph" | "library" | "compilation" | BusinessViewKey;

type CurrentUser = {
  userId: string;
  loginName: string;
  role: "ADMIN" | "MEMBER";
  actor: { id: string; displayName: string };
  personObject: {
    id: string;
    canonicalName: string;
    personCardId: string | null;
  } | null;
};

type ConversationSummary = {
  id: string;
  title: string;
  archivedAt: string | null;
  lastMessageAt: string;
  createdAt: string;
};

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
  if (toolName === "readSemanticView") {
    const root = record(output);
    const cards = Array.isArray(root?.cards) ? root.cards.length : 0;
    const cardTypes = Array.isArray(root?.cardTypes) ? root.cardTypes.length : 0;
    return `社团信息读取完成 · ${cardTypes} 种卡片 · ${cards} 张正式卡片`;
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
      toolName !== "readSemanticView" &&
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
      toolName === "readSemanticView"
        ? "正在读取社团信息…"
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
          label: toolName === "readSemanticView"
            ? "社团信息读取失败"
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
            label: toolName === "readSemanticView"
              ? "社团信息读取未执行"
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
            : toolName === "readSemanticView"
              ? "社团信息读取已中断"
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
            : toolName === "readSemanticView"
              ? "社团信息读取已中断"
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
  references?: SemanticViewReference[];
  sourceReferences?: SourceDocumentReference[];
  artifactReferences?: ArtifactReference[];
  onOpenViewReference?: (reference: SemanticViewReference) => void;
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
    "[$1](echo-ref:$1)",
  );

  return (
    <div className={`echo-markdown ${inverse ? "echo-markdown-inverse" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url.startsWith("echo-ref:") ? url : defaultUrlTransform(url)}
        components={{
          a: ({ href, children }) => {
            const referenceRef = href?.startsWith("echo-ref:")
              ? href.slice("echo-ref:".length)
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
                <span className="echo-reference" title={artifactReference.label}>
                  {artifactReference.ref} · 资料库
                </span>
              );
            }
            if (sourceReference) {
              return (
                <button
                  type="button"
                  onClick={() => onOpenSourceReference?.(sourceReference)}
                  className="echo-reference"
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
                  className="echo-reference"
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
  onPreviewProposal,
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
  onOpenViewReference: (reference: SemanticViewReference) => void;
  onOpenSourceReference: (reference: SourceDocumentReference) => void;
  onPreviewProposal: (proposal: ViewProposalPresentation) => void;
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
            const proposals = message.parts.filter((part) => part.type === "data-viewProposal");
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
                    E
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
                  {search ? <SeedMapPanel seedMap={search.seedMap} /> : null}
                  {proposals.map((part) => (
                    <ViewProposalCard
                      key={part.data.id}
                      proposal={part.data}
                      onPreview={onPreviewProposal}
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
                        <p>快照：{trace.snapshot.sourceTitle} · {trace.snapshot.globalObjectCount} Global Objects · {trace.snapshot.assertionCount} Assertions</p>
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
              <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-[9px] font-semibold text-white">E</div>
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
          <label className="sr-only" htmlFor={textareaId}>向 Echo 提问</label>
          <textarea
            id={textareaId}
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isSending || !canInteract}
            className="min-h-8 max-h-40 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-1 text-[14px] leading-6 text-zinc-950 outline-none [field-sizing:content] placeholder:text-zinc-400 disabled:opacity-60"
            placeholder={compact ? "继续提问" : "向 Echo 提问"}
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
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceKey>("chat");
  const [activeLibraryFolderId, setActiveLibraryFolderId] = useState<string>();
  const [activePresentation, setActivePresentation] = useState<BusinessViewPresentation>("overview");
  const [semanticViewFocus, setSemanticViewFocus] = useState<SemanticViewFocus>();
  const [activePageEntity, setActivePageEntity] = useState<{
    activeCardId: string;
    activeNodeId?: string;
    activeObjectName: string;
  }>();
  const [previewProposal, setPreviewProposal] = useState<ViewProposalPresentation>();
  const [previewChangeIndex, setPreviewChangeIndex] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
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
            : "无法初始化 Echo。",
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

  const pageContext: ChatPageContext = activeWorkspace === "chat" || activeWorkspace === "knowledge-graph"
    ? { activePresentation: "full_chat" }
    : activeWorkspace === "library" || activeWorkspace === "compilation"
      ? { activePresentation: "library", activeFolderId: activeLibraryFolderId }
      : {
          activeViewKey: activeWorkspace,
          activePresentation,
          ...(activePresentation === "playbook" && activePageEntity
            ? activePageEntity
            : semanticViewFocus?.cardId
              ? { activeCardId: semanticViewFocus.cardId }
              : {}),
        };

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
    setActiveWorkspace("chat");
    setDrawerOpen(false);
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

  function openFullChat() {
    setActiveWorkspace("chat");
    setDrawerOpen(false);
    setPreviewProposal(undefined);
  }

  function openBusinessView(viewKey: BusinessViewKey) {
    setActiveWorkspace(viewKey);
    setActivePresentation("overview");
    setSemanticViewFocus(undefined);
    setActivePageEntity(undefined);
    setPreviewProposal(undefined);
  }

  function openKnowledgeGraph() {
    setActiveWorkspace("knowledge-graph");
    setSemanticViewFocus(undefined);
    setActivePageEntity(undefined);
    setPreviewProposal(undefined);
  }

  function openLibrary() {
    setActiveWorkspace("library");
    setSemanticViewFocus(undefined);
    setPreviewProposal(undefined);
  }

  function openCompilation() {
    setActiveWorkspace("compilation");
    setSemanticViewFocus(undefined);
    setPreviewProposal(undefined);
  }

  function openViewReference(reference: SemanticViewReference) {
    setActiveWorkspace(reference.target.viewKey);
    setActivePresentation("cards");
    setDrawerOpen(true);
    setPreviewProposal(undefined);
    setSemanticViewFocus(
      reference.target.kind === "view"
        ? undefined
        : reference.target.kind === "card"
          ? { cardId: reference.target.cardId }
          : reference.target.kind === "dimension"
            ? {
                cardId: reference.target.cardId,
                dimensionName: reference.target.dimensionName,
              }
            : {
                cardId: reference.target.cardId,
                slotKey: reference.target.slotKey,
              },
    );
  }

  function showProposalChange(proposal: ViewProposalPresentation, index: number) {
    const boundedIndex = Math.max(0, Math.min(index, proposal.changes.length - 1));
    const change = proposal.changes[boundedIndex];
    if (!change) return;
    setPreviewProposal(proposal);
    setPreviewChangeIndex(boundedIndex);
    setSemanticViewFocus(proposalChangeFocus(change));
    setActiveWorkspace(proposal.viewKey);
    setActivePresentation("cards");
    setDrawerOpen(true);
  }

  function handlePreviewProposalChange(proposal: ViewProposalPresentation) {
    if (proposal.status === "pending") {
      showProposalChange(proposal, previewChangeIndex);
      return;
    }
    setPreviewProposal(undefined);
    setPreviewChangeIndex(0);
    setSemanticViewFocus(undefined);
  }

  function exitProposalPreview() {
    setPreviewProposal(undefined);
    setPreviewChangeIndex(0);
    setSemanticViewFocus(undefined);
  }

  if (!currentUser) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#eef2ef] px-5 text-zinc-700">
        <div className="max-w-md rounded-xl border border-zinc-200 bg-white px-6 py-5 text-center shadow-sm">
          <p className="font-medium">{historyState === "error" ? "Echo 初始化失败" : "正在进入 Echo…"}</p>
          {historyError ? <p className="mt-2 text-sm text-red-700">{historyError}</p> : null}
          {historyState === "error" ? <button onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-emerald-800 px-4 py-2 text-sm text-white">重试</button> : null}
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-dvh min-h-0 overflow-hidden bg-white text-zinc-950">
      <nav className="hidden w-[244px] shrink-0 flex-col overflow-hidden border-r border-[#e8e8e8] bg-[#f9f9f9] px-2.5 pb-2.5 pt-2 md:flex">
        <div className="flex h-11 items-center justify-center">
          <p className="text-[16px] font-semibold tracking-[-0.02em] text-zinc-900">Echo</p>
        </div>

        <button
          type="button"
          disabled={isSending}
          onClick={() => void createConversation()}
          className="mt-0.5 flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12px] font-medium text-zinc-800 transition hover:bg-[#ececec] disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M12 20H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10" strokeLinecap="round" strokeLinejoin="round" />
            <path d="m14 4 6 6m-7 1 6.5-6.5a1.4 1.4 0 0 0-2-2L11 9l-1 3 3-1Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          新对话
        </button>

        <div className="mt-2">
          <p className="px-2 pb-1 text-[10px] font-medium tracking-wide text-zinc-400">组织认知</p>
          <button type="button" onClick={openKnowledgeGraph} className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12px] transition ${activeWorkspace === "knowledge-graph" ? "bg-[#e5ece9] font-medium text-zinc-950" : "text-zinc-700 hover:bg-[#ececec]"}`}>
            <svg viewBox="0 0 24 24" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="6" cy="12" r="2.25" /><circle cx="17.5" cy="6" r="2.25" /><circle cx="18" cy="17.5" r="2.25" /><path d="m8 11 7.3-3.8M8.1 13l7.7 3.4M17.7 8.3l.2 7" strokeLinecap="round" /></svg>
            知识图谱
          </button>
        </div>

        <div className="mt-2 border-t border-zinc-200/70 pt-2">
          <div className="px-2 pb-1">
            <p className="text-[10px] font-medium tracking-wide text-zinc-400">资料工程</p>
          </div>
          <div className="space-y-px">
            <button type="button" onClick={openLibrary} className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12px] transition ${activeWorkspace === "library" ? "bg-[#e9e9e9] font-medium text-zinc-950" : "text-zinc-700 hover:bg-[#ececec]"}`}>
              <svg viewBox="0 0 24 24" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10l2 2h5.5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-10Z" strokeLinejoin="round" /></svg>
              资料库
            </button>
            <button type="button" onClick={openCompilation} className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12px] transition ${activeWorkspace === "compilation" ? "bg-[#e9e9e9] font-medium text-zinc-950" : "text-zinc-700 hover:bg-[#ececec]"}`}>
              <svg viewBox="0 0 24 24" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M7 3.5h8l3 3v14H7v-17Z" strokeLinejoin="round" /><path d="M10 11h5m-5 4h5M15 3.5V7h3" strokeLinecap="round" /></svg>
              基础编译
            </button>
          </div>
        </div>

        <div className="mt-2 border-t border-zinc-200/70 pt-2">
          <div className="px-2 pb-1">
            <p className="text-[10px] font-medium tracking-wide text-zinc-400">业务视图</p>
          </div>
          <div className="space-y-px">
            <button type="button" onClick={() => openBusinessView(SOCIETY_INFORMATION_VIEW)} className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12px] transition ${activeWorkspace === SOCIETY_INFORMATION_VIEW ? "bg-[#e9e9e9] font-medium text-zinc-950" : "text-zinc-700 hover:bg-[#ececec]"}`}>
              <svg viewBox="0 0 24 24" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M15 7.5a2.5 2.5 0 0 1 0 5M16.5 15a4 4 0 0 1 4 4" strokeLinecap="round" /></svg>
              社团信息
            </button>
            <button type="button" onClick={() => openBusinessView(ACTIVITY_OPERATIONS_VIEW)} className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12px] transition ${activeWorkspace === ACTIVITY_OPERATIONS_VIEW ? "bg-[#e9e9e9] font-medium text-zinc-950" : "text-zinc-700 hover:bg-[#ececec]"}`}>
              <svg viewBox="0 0 24 24" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 5h14v14H5z" strokeLinejoin="round" /><path d="M8 3v4m8-4v4M8 11h8m-8 4h5" strokeLinecap="round" /></svg>
              活动运营
            </button>
          </div>
        </div>

        <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-zinc-200/80 pt-3">
          <p className="px-2 text-[11px] font-medium text-zinc-500">最近对话</p>
          <div className="mt-1 min-h-0 space-y-px overflow-y-auto pr-0.5">
            {conversations.map((conversation) => (
              <div key={conversation.id} className={`group flex items-center rounded-lg transition ${activeWorkspace === "chat" && activeConversationId === conversation.id ? "bg-[#e9e9e9] text-zinc-950" : "text-zinc-700 hover:bg-[#ececec]"}`}>
                <button
                  type="button"
                  onClick={() => {
                    if (isSending || conversation.id === activeConversationId) {
                      openFullChat();
                      return;
                    }
                    activateConversation(conversation.id);
                    openFullChat();
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

        <div className="border-t border-zinc-200/80 pt-2">
          <div className="flex items-center gap-2 rounded-lg px-1.5 py-1.5">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#d9dfdc] text-[10px] font-semibold text-zinc-700">
              {currentUser.actor.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium leading-4 text-zinc-800">{currentUser.actor.displayName}</p>
              <p className="truncate text-[10px] leading-4 text-zinc-500">{currentUser.personObject?.canonicalName ?? currentUser.loginName}</p>
            </div>
          </div>
          <div className="flex gap-0.5 px-1">
            {currentUser.role === "ADMIN" ? <button onClick={() => window.location.assign("/admin/users")} className="rounded-md px-1.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800">账号管理</button> : null}
            <button onClick={() => void logout()} className="rounded-md px-1.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800">退出登录</button>
          </div>
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1">
        <section className={`min-h-0 min-w-0 flex-1 ${
          activeWorkspace === "chat" || activeWorkspace === "knowledge-graph" ? "overflow-hidden" : "overflow-y-auto"
        }`}>
          {activeWorkspace === "chat" ? (
            <div className="flex h-full min-h-0 w-full flex-col bg-white">
              <ChatSurface messages={messages} status={status} error={error} historyState={historyState} historyError={historyError} input={input} textareaId="full-chat-input" onInputChange={setInput} onSubmit={submit} onStop={stop} onOpenViewReference={openViewReference} onOpenSourceReference={setSourceReference} onPreviewProposal={(proposal) => showProposalChange(proposal, 0)} />
            </div>
          ) : activeWorkspace === "knowledge-graph" ? (
            <KnowledgeGraphWorkspace
              assistantOpen={drawerOpen}
              onAskAI={(prompt) => {
                setInput(prompt);
                setDrawerOpen(true);
              }}
            />
          ) : activeWorkspace === "library" ? (
            <LibraryWorkspace
              initialFolderId={activeLibraryFolderId}
              onFolderChange={setActiveLibraryFolderId}
              onOpenAI={() => setDrawerOpen(true)}
              onAskAI={(prompt) => {
                setInput(prompt);
                setDrawerOpen(true);
              }}
            />
          ) : activeWorkspace === "compilation" ? (
            <CompilationWorkspace
              onOpenLibrary={openLibrary}
              onAskAI={(prompt) => {
                setInput(prompt);
                setDrawerOpen(true);
              }}
            />
          ) : (
            <SemanticViewWorkspace
              key={activeWorkspace}
              viewKey={activeWorkspace}
              presentation={activePresentation}
              focus={semanticViewFocus}
              proposalPreview={previewProposal}
              proposalChangeIndex={previewChangeIndex}
              onFocusChange={setSemanticViewFocus}
              onProposalChangeIndex={(index) => {
                if (previewProposal) showProposalChange(previewProposal, index);
              }}
              onProposalChange={handlePreviewProposalChange}
              onExitProposalPreview={exitProposalPreview}
              onPresentationChange={setActivePresentation}
              onPageContextChange={setActivePageEntity}
              onOpenAI={() => setDrawerOpen(true)}
              onAskAI={(prompt) => {
                setInput(prompt);
                setDrawerOpen(true);
              }}
            />
          )}
        </section>

        {activeWorkspace !== "chat" && drawerOpen ? (
          <aside className="flex h-dvh w-[26rem] shrink-0 flex-col border-l border-zinc-200 bg-white shadow-[-8px_0_28px_rgba(0,0,0,0.04)]">
            <header className="flex min-h-12 items-center justify-between gap-3 border-b border-zinc-100 px-3.5 py-2">
              <div>
                <p className="text-[11px] font-medium text-zinc-400">当前上下文</p>
                <h2 className="mt-0.5 text-sm font-medium text-zinc-800">
                  {activeWorkspace === "library"
                    ? "资料库 · 当前文件夹"
                    : activeWorkspace === "compilation"
                      ? "资料库 · 基础编译"
                      : activeWorkspace === "knowledge-graph"
                        ? "组织认知 · 知识图谱"
                        : `${activeWorkspace === ACTIVITY_OPERATIONS_VIEW ? "活动运营" : "社团信息"} · ${activePresentation === "overview" ? "概览" : activePresentation === "playbook" ? "操作手册" : "卡片"}`}
                </h2>
              </div>
              <button type="button" onClick={() => setDrawerOpen(false)} aria-label="收起 AI 对话" className="flex size-7 items-center justify-center rounded-lg text-lg font-light text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">×</button>
            </header>
            <ChatSurface compact messages={messages} status={status} error={error} historyState={historyState} historyError={historyError} input={input} textareaId="drawer-chat-input" onInputChange={setInput} onSubmit={submit} onStop={stop} onOpenViewReference={openViewReference} onOpenSourceReference={setSourceReference} onPreviewProposal={(proposal) => showProposalChange(proposal, 0)} />
          </aside>
        ) : null}
      </div>
      {sourceReference ? (
        <SourceDocumentDialog
          reference={sourceReference}
          onClose={() => setSourceReference(undefined)}
        />
      ) : null}
    </main>
  );
}
