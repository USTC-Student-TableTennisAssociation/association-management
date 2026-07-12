"use client";

import { useState } from "react";

import type {
  GuidanceAiExplanation,
  GuidanceAiPoint,
  GuidanceAiResponse,
} from "./guidance-ai";
import type { GuidanceGraph } from "./guidance-types";

type GuidanceAiPanelProps = {
  graph: GuidanceGraph;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
};

const presetQuestions = [
  "帮我看懂当前分支",
  "这里有哪些强制要求？",
  "推荐阅读顺序是什么？",
  "有哪些风险或缺失信息？",
] as const;

function ReferenceButtons({
  nodeIds,
  graph,
  onSelectNode,
}: {
  nodeIds: readonly string[];
  graph: GuidanceGraph;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {nodeIds.map((nodeId) => {
        const node = graph.nodeById.get(nodeId);
        if (!node) {
          return null;
        }

        return (
          <button
            key={nodeId}
            type="button"
            onClick={() => onSelectNode(nodeId)}
            className="max-w-full truncate rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-left text-[11px] font-medium text-emerald-800 transition hover:border-emerald-400 hover:bg-emerald-100"
            title={`查看：${node.title}`}
          >
            ↗ {node.title}
          </button>
        );
      })}
    </div>
  );
}

function ExplanationPoints({
  title,
  emptyText,
  points,
  graph,
  onSelectNode,
}: {
  title: string;
  emptyText: string;
  points: readonly GuidanceAiPoint[];
  graph: GuidanceGraph;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="border-t border-zinc-200 pt-4">
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      {points.length > 0 ? (
        <ol className="mt-2 space-y-2">
          {points.map((point, index) => (
            <li key={`${title}-${index}`} className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5">
              <p className="text-sm leading-6 text-zinc-700">{point.text}</p>
              <ReferenceButtons nodeIds={point.nodeIds} graph={graph} onSelectNode={onSelectNode} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-xs leading-5 text-zinc-500">{emptyText}</p>
      )}
    </section>
  );
}

function ExplanationResult({
  explanation,
  graph,
  onSelectNode,
}: {
  explanation: GuidanceAiExplanation;
  graph: GuidanceGraph;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-sm font-semibold text-zinc-900">结构概览</h3>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-700">{explanation.summary}</p>
      </section>

      <ExplanationPoints
        title="推荐阅读顺序"
        emptyText="当前上下文中没有形成明确的阅读顺序。"
        points={explanation.readingOrder}
        graph={graph}
        onSelectNode={onSelectNode}
      />
      <ExplanationPoints
        title="强制要求"
        emptyText="AI 没有从当前上下文中识别出可确认的强制要求。"
        points={explanation.mandatoryPoints}
        graph={graph}
        onSelectNode={onSelectNode}
      />
      <ExplanationPoints
        title="风险与易错点"
        emptyText="AI 没有从当前上下文中识别出可确认的风险。"
        points={explanation.cautions}
        graph={graph}
        onSelectNode={onSelectNode}
      />

      <section className="border-t border-zinc-200 pt-4">
        <h3 className="text-sm font-semibold text-zinc-900">仍需确认</h3>
        {explanation.unresolved.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {explanation.unresolved.map((item, index) => (
              <li key={`${item}-${index}`} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950">
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs leading-5 text-zinc-500">当前解读没有列出额外的待确认信息。</p>
        )}
      </section>
    </div>
  );
}

export function GuidanceAiPanel({ graph, selectedNodeId, onSelectNode }: GuidanceAiPanelProps) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<GuidanceAiResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedNode = selectedNodeId ? graph.nodeById.get(selectedNodeId) : undefined;
  const currentFocusTitle = selectedNode?.title ?? "指导层工作流入口";
  const isStale = Boolean(result && result.context.focusNodeId !== (selectedNode?.id ?? null));

  async function requestExplanation(questionOverride?: string) {
    const requestedQuestion = questionOverride ?? question.trim();
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/guidance/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: selectedNode?.id ?? null,
          question: requestedQuestion || null,
        }),
      });
      const payload = (await response.json()) as GuidanceAiResponse | { error?: string };

      if (!response.ok || !("explanation" in payload)) {
        throw new Error("error" in payload && payload.error ? payload.error : "AI 解读失败，请稍后重试。");
      }

      setResult(payload);
      if (questionOverride) {
        setQuestion(questionOverride);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "AI 解读失败，请稍后重试。");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-emerald-900">只读 AI 解读</p>
            <p className="mt-1 truncate text-sm font-medium text-zinc-900" title={currentFocusTitle}>
              {currentFocusTitle}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[10px] font-medium text-emerald-800 shadow-sm">
            不执行动作
          </span>
        </div>
        <p className="mt-2 text-xs leading-5 text-emerald-950/75">
          AI 只读取当前树分支及直接关系，帮助解释结构；不会修改卡片、数据库、任务或活动状态。
        </p>
      </div>

      <div className="mt-4">
        <p className="text-xs font-medium text-zinc-600">快捷提问</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {presetQuestions.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={isLoading}
              onClick={() => void requestExplanation(preset)}
              className="rounded-full border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 transition hover:border-emerald-300 hover:text-emerald-800 disabled:cursor-wait disabled:opacity-50"
            >
              {preset}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <label htmlFor="guidance-ai-question" className="text-xs font-medium text-zinc-600">
          针对当前分支提问
        </label>
        <textarea
          id="guidance-ai-question"
          value={question}
          maxLength={600}
          rows={3}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="例如：如果时间很紧，应该先确认什么？"
          className="mt-2 w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm leading-5 text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[11px] text-zinc-400">{question.length} / 600</span>
          <button
            type="button"
            disabled={isLoading}
            onClick={() => void requestExplanation()}
            className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-wait disabled:bg-emerald-400"
          >
            {isLoading ? "正在解读…" : "解读当前分支"}
          </button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-800">
          {error}
        </div>
      ) : null}

      {isLoading ? (
        <div className="mt-5 space-y-3" aria-label="AI 正在生成解读">
          <div className="h-4 w-24 animate-pulse rounded bg-zinc-200" />
          <div className="h-16 animate-pulse rounded-lg bg-zinc-100" />
          <div className="h-24 animate-pulse rounded-lg bg-zinc-100" />
        </div>
      ) : null}

      {result && !isLoading ? (
        <div className="mt-5 border-t border-zinc-200 pt-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-xs text-zinc-500" title={result.context.focusTitle}>
              基于 {result.context.nodeCount} 张卡片 · {result.context.focusTitle}
            </p>
            <button
              type="button"
              onClick={() => void requestExplanation()}
              className="shrink-0 text-xs font-medium text-emerald-700 hover:text-emerald-900"
            >
              重新生成
            </button>
          </div>

          {isStale ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              你已切换到另一张卡片。下面仍是上一次的解读，请重新生成当前分支。
            </div>
          ) : null}

          <ExplanationResult explanation={result.explanation} graph={graph} onSelectNode={onSelectNode} />
        </div>
      ) : null}

      {!result && !isLoading && !error ? (
        <div className="mt-6 rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center">
          <p className="text-sm font-medium text-zinc-700">选择一个问题开始解读</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            每次都需要你主动发起，不会在切换节点时自动消耗 AI 请求。
          </p>
        </div>
      ) : null}
    </div>
  );
}
