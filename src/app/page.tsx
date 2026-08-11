"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";
import { FormEvent, KeyboardEvent, useMemo, useState } from "react";

import type { ClubChatMessage } from "@/ai/types";
import { finalStepMessageText } from "@/ai/ui-message-text";
import type {
  MemoryChannelTrace,
  StructuredSeedMap,
} from "@/memory/types";

const initialMessages: ClubChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "你好。我可以通过 Object–Assertion 基础视图检索并理解社团资料。",
      },
    ],
  },
];

const quickPrompts = [
  "新闻稿应该怎么写？",
  "继往开来是什么活动？",
  "2024 年继往开来什么时候举办？",
];

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
    if (toolName !== "searchMemory" && toolName !== "followObject") return [];

    const input = record(part.input);
    const query = compactText(input?.query);
    const globalObjectId = compactText(input?.globalObjectId, 48);
    const focus = compactText(input?.focus, 56);
    const runningLabel =
      toolName === "searchMemory"
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
          label: toolName === "searchMemory" ? "搜索失败" : "对象查找失败",
          state: "error",
        }];
      case "approval-responded":
        if (!part.approval.approved) {
          return [{
            id: part.toolCallId,
            label: toolName === "searchMemory" ? "搜索未执行" : "对象查找未执行",
            state: "error",
          }];
        }
        return [{
          id: part.toolCallId,
          label: isActiveAssistant
            ? runningLabel
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
  return (
    <details className="mt-3 border-t border-zinc-200 pt-2 text-xs text-zinc-600">
      <summary className="cursor-pointer font-medium text-emerald-800">
        Structured Seed Map（{seedMap.objects.length} Global Objects · {seedMap.assertions.length} Assertions）
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
                  {assertion.sources.map((source) => source.sourceBlockId).join(", ") || "无"}
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

export default function Home() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, stop, error, clearError } =
    useChat<ClubChatMessage>({
      messages: initialMessages,
      transport: new DefaultChatTransport({ api: "/api/chat" }),
    });
  const isSending = status === "submitted" || status === "streaming";
  const canSend = useMemo(
    () => input.trim().length > 0 && !isSending,
    [input, isSending],
  );

  function submit(content: string) {
    const text = content.trim();
    if (!text || isSending) return;
    clearError();
    setInput("");
    void sendMessage({ text });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(input);
    }
  }

  return (
    <main className="flex min-h-dvh bg-[#f6f7f4] text-zinc-950">
      <section className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between border-b border-zinc-200/80 py-4">
          <div>
            <p className="text-sm font-medium text-emerald-700">Club Management</p>
            <h1 className="mt-1 text-xl font-semibold text-zinc-950 sm:text-2xl">
              高校社团管理助手
            </h1>
          </div>
          <div className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-600 shadow-sm sm:text-sm">
            {isSending ? "AI 回答中" : "AI Chat"}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 py-4">
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 shadow-sm sm:p-5">
            <div className="flex flex-col gap-4">
              {messages.map((message, messageIndex) => {
                const isUser = message.role === "user";
                const text = finalStepMessageText(message);
                const reasoning = messageReasoning(message);
                const isActiveAssistant =
                  !isUser && isSending && messageIndex === messages.length - 1;
                const activities = toolActivities(message, isActiveAssistant);
                const searchParts = message.parts.filter(
                  (part) => part.type === "data-memorySearch",
                );
                const search = searchParts.at(-1)?.data;
                const trace = search?.trace;
                const answerUsedAssertionRefs =
                  search?.answerUsedAssertionRefs ?? trace?.answerUsedAssertionRefs ?? [];
                const usedAssertionRefs = new Set(answerUsedAssertionRefs);
                const sources = search?.seedMap.assertions
                  .filter((assertion) => usedAssertionRefs.has(assertion.ref))
                  .flatMap((assertion) =>
                    assertion.sources.map((source) => ({ assertion, source })),
                  ) ?? [];

                return (
                  <article
                    key={message.id}
                    className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[92%] rounded-lg px-4 py-3 text-sm leading-6 sm:max-w-[86%] sm:text-base ${
                        isUser
                          ? "bg-emerald-700 text-white"
                          : "border border-zinc-200 bg-zinc-50 text-zinc-800"
                      }`}
                    >
                      <div className="whitespace-pre-wrap">
                        {text || (isActiveAssistant && !activities.length ? "正在回答…" : "")}
                      </div>

                      <ToolActivityList activities={activities} />

                      {reasoning ? (
                        <details open className="mt-3 border-t border-zinc-200 pt-2 text-xs text-zinc-600">
                          <summary className="cursor-pointer font-medium text-zinc-700">
                            模型思考（调试信息）
                          </summary>
                          <p className="mt-1 text-zinc-500">
                            这是模型生成的中间过程，不作为组织事实依据。
                          </p>
                          <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-100 p-3 font-mono leading-5 text-zinc-700">
                            {reasoning}
                          </div>
                        </details>
                      ) : null}

                      {search ? <SeedMapPanel seedMap={search.seedMap} /> : null}

                      {sources.length ? (
                        <details className="mt-3 border-t border-zinc-200 pt-2 text-xs text-zinc-600">
                          <summary className="cursor-pointer font-medium text-emerald-800">
                            Assertion / Sources（{sources.length}）
                          </summary>
                          <ul className="mt-2 space-y-2">
                            {sources.map(({ assertion, source }) => (
                              <li
                                key={`${assertion.ref}-${source.sourceBlockId}-${source.ordinal}`}
                                className="rounded-md bg-white p-2"
                              >
                                <p className="font-medium text-zinc-800">
                                  {assertion.ref} · {assertion.renderedStatement}
                                </p>
                                <p className="text-zinc-500">
                                  {source.sourceTitle} · {source.sourceBlockId}
                                  {source.pages.length ? ` · p.${source.pages.join(",")}` : ""}
                                </p>
                                {source.excerpt ? (
                                  <p className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap text-zinc-500">
                                    {source.excerpt}
                                  </p>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}

                      {trace ? (
                        <details className="mt-3 border-t border-zinc-200 pt-2 text-xs text-zinc-600">
                          <summary className="cursor-pointer font-medium text-sky-800">
                            Locate Trace（{trace.durationMs} ms）
                          </summary>
                          <div className="mt-2 space-y-3 rounded-md bg-white p-3">
                            <p>
                              Query：{trace.query}
                            </p>
                            <p>
                              快照：{trace.snapshot.sourceTitle} · {trace.snapshot.globalObjectCount} Global Objects ·{" "}
                              {trace.snapshot.assertionCount} Assertions
                            </p>
                            <p>
                              Source IR：{trace.snapshot.objectFragmentCount} Fragments ·{" "}
                              {trace.snapshot.surfaceFormCount} Surface forms ·{" "}
                              {trace.snapshot.fragmentReferenceCount} References
                            </p>
                            <p>
                              Assertion embeddings：
                              {trace.snapshot.embeddingModel
                                ? `${trace.snapshot.embeddingModel}@${trace.snapshot.embeddingRevision ?? "unknown"}/${trace.snapshot.embeddingDimension ?? "unknown"} · ${trace.snapshot.embeddingAssertionCount}`
                                : `未建立 · ${trace.snapshot.embeddingAssertionCount}`}
                            </p>
                            <div>
                              <p className="font-medium text-zinc-700">Facets</p>
                              <ul className="mt-1 list-disc pl-5">
                                {trace.facets.map((facet) => (
                                  <li key={facet.id}>
                                    {facet.id} · {facet.text}（{facet.source}）
                                  </li>
                                ))}
                              </ul>
                            </div>
                            <TraceChannel title="Global Object lexical" channels={trace.objectLexical} />
                            <TraceChannel title="Assertion lexical" channels={trace.assertionLexical} />
                            <TraceChannel title="Assertion vector" channels={trace.assertionVector} />
                            <details>
                              <summary className="cursor-pointer font-medium text-zinc-700">
                                Semantic-derived Global Objects（{trace.semanticDerivedObjects.length}）
                              </summary>
                              <ul className="mt-1 space-y-1">
                                {trace.semanticDerivedObjects.map((object) => (
                                  <li key={object.objectRef}>
                                    {object.objectRef} · {object.canonicalName} ← {object.supportingAssertions.join(", ")}
                                  </li>
                                ))}
                              </ul>
                            </details>
                            <p>
                              该次 Locate Seed Map：{trace.finalSeedMap.objectRefs.length} Global Objects ·{" "}
                              {trace.finalSeedMap.assertionRefs.length} Assertions ·{" "}
                              {trace.finalSeedMap.connections} Connections
                            </p>
                            <p>
                              回答实际引用：{answerUsedAssertionRefs.join(", ") || "未检测到 [A#] 引用"}
                            </p>
                            {trace.warnings.map((warning) => (
                              <p key={warning} className="text-amber-700">
                                {warning}
                              </p>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </article>
                );
              })}

              {status === "submitted" ? (
                <article className="flex justify-start">
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
                    正在准备回答…
                  </div>
                </article>
              ) : null}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="min-h-11 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm text-zinc-700 shadow-sm transition hover:border-emerald-300 hover:text-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSending}
                onClick={() => submit(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
            <label className="sr-only" htmlFor="chat-input">输入消息</label>
            <textarea
              id="chat-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={3}
              disabled={isSending}
              className="max-h-40 min-h-24 w-full resize-none rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-base leading-6 text-zinc-950 outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100 disabled:opacity-70"
              placeholder="询问组织资料、活动经验或工作事项…"
            />
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-h-5 text-sm text-red-600" role="status">
                {error?.message}
              </p>
              <div className="flex justify-end gap-2">
                {isSending ? (
                  <button
                    type="button"
                    onClick={stop}
                    className="inline-flex h-11 items-center justify-center rounded-md border border-zinc-300 px-5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    停止
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={!canSend}
                  className="inline-flex h-11 items-center justify-center rounded-md bg-emerald-700 px-5 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500"
                >
                  {isSending ? "生成中" : "发送"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
