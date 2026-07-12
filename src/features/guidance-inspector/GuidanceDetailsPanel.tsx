"use client";

import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";

import { KindBadge, StatusBadge } from "./GuidanceBadges";
import { formatGuidanceCondition, type FormattedGuidanceCondition } from "./guidance-condition";
import {
  guidanceActionLabels,
  guidanceRelationLabels,
  type GuidanceDiagnostic,
  type GuidanceGraph,
  type GuidanceGraphAnalysis,
  type GuidanceGraphEdge,
  type GuidanceGraphNode,
  type InspectorSelection,
} from "./guidance-types";

type GuidanceDetailsPanelProps = {
  graph: GuidanceGraph;
  analysis: GuidanceGraphAnalysis;
  selection: InspectorSelection;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (edgeId: string) => void;
  onSelectDiagnostic: (diagnosticId: string) => void;
};

function severityStyles(severity: GuidanceDiagnostic["severity"]): string {
  if (severity === "error") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  if (severity === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-sky-200 bg-sky-50 text-sky-700";
}

function severityLabel(severity: GuidanceDiagnostic["severity"]): string {
  if (severity === "error") {
    return "错误";
  }
  if (severity === "warning") {
    return "警告";
  }
  return "提示";
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-zinc-100 py-4 last:border-b-0">
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ConditionTree({ condition }: { condition: FormattedGuidanceCondition }) {
  if (condition.type === "fact") {
    return <li className="leading-6 text-zinc-700">{condition.text}</li>;
  }

  return (
    <li className="text-zinc-700">
      <p className="font-medium">{condition.label}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {condition.children.map((child, index) => (
          <ConditionTree key={`${child.type}-${index}`} condition={child} />
        ))}
      </ul>
    </li>
  );
}

function RelationshipRows({
  title,
  edges,
  graph,
  direction,
  onSelectEdge,
}: {
  title: string;
  edges: readonly GuidanceGraphEdge[];
  graph: GuidanceGraph;
  direction: "入边" | "出边";
  onSelectEdge: (edgeId: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-zinc-500">
        {title}（{edges.length}）
      </p>
      {edges.length === 0 ? (
        <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-500">暂无{title}</p>
      ) : (
        <div className="space-y-2">
          {edges.map((edge) => {
            const otherNodeId = direction === "入边" ? edge.fromGuidelineId : edge.toGuidelineId;
            const otherNode = graph.nodeById.get(otherNodeId);

            return (
              <button
                key={edge.id}
                type="button"
                onClick={() => onSelectEdge(edge.id)}
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-xs transition hover:border-emerald-300 hover:bg-emerald-50/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium text-zinc-800">
                    {direction === "入边" ? "← " : "→ "}
                    {otherNode?.title ?? "不存在的卡片"}
                  </span>
                  <span className="shrink-0 text-zinc-500">{guidanceRelationLabels[edge.relationType]}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-zinc-500">{edge.note ?? "未填写关系说明"}</p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NodeDetail({
  node,
  graph,
  onSelectEdge,
}: {
  node: GuidanceGraphNode;
  graph: GuidanceGraph;
  onSelectEdge: (edgeId: string) => void;
}) {
  const incomingEdges = node.incomingEdgeIds
    .map((edgeId) => graph.edgeById.get(edgeId))
    .filter((edge): edge is GuidanceGraphEdge => edge !== undefined);
  const outgoingEdges = node.outgoingEdgeIds
    .map((edgeId) => graph.edgeById.get(edgeId))
    .filter((edge): edge is GuidanceGraphEdge => edge !== undefined);
  const formattedCondition = formatGuidanceCondition(node.appliesWhen);

  return (
    <>
      <div className="border-b border-zinc-200 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge kind={node.kind} />
          <StatusBadge status={node.status} />
          {node.isMandatory ? (
            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
              强制
            </span>
          ) : null}
        </div>
        <h2 className="mt-3 text-lg font-semibold leading-7 text-zinc-950">{node.title}</h2>
      </div>

      <DetailSection title="基本信息">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-zinc-500">ID</dt>
          <dd className="break-all font-mono text-xs text-zinc-700">{node.id}</dd>
          <dt className="text-zinc-500">类型 / 状态</dt>
          <dd className="text-zinc-800">
            {node.kind} / {node.status}
          </dd>
          <dt className="text-zinc-500">是否强制</dt>
          <dd className="text-zinc-800">{node.isMandatory ? "是" : "否"}</dd>
          <dt className="text-zinc-500">入边 / 出边</dt>
          <dd className="text-zinc-800">
            {node.incomingEdgeIds.length} / {node.outgoingEdgeIds.length}
          </dd>
          <dt className="text-zinc-500">直接关联</dt>
          <dd className="text-zinc-800">{node.directNeighborIds.length} 个去重节点</dd>
        </dl>
      </DetailSection>

      <DetailSection title="适用条件">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <ConditionTree condition={formattedCondition} />
        </ul>
        <details className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <summary className="cursor-pointer text-xs font-medium text-zinc-600">查看原始 JSON</summary>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-zinc-700">
            {JSON.stringify(node.appliesWhen, null, 2)}
          </pre>
        </details>
      </DetailSection>

      <DetailSection title="正文">
        <div className="prose prose-sm max-w-none prose-headings:mb-2 prose-headings:mt-4 prose-headings:text-zinc-900 prose-p:leading-6 prose-p:text-zinc-700 prose-li:text-zinc-700">
          <ReactMarkdown skipHtml>{node.contentMarkdown}</ReactMarkdown>
        </div>
      </DetailSection>

      <DetailSection title="建议动作">
        <div className="space-y-2">
          {node.suggestedActions.length === 0 ? (
            <p className="text-sm text-zinc-500">暂无建议动作。</p>
          ) : (
            node.suggestedActions.map((action, index) => (
              <article key={`${action.type}-${action.title}-${index}`} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                <p className="text-xs font-semibold text-emerald-700">{guidanceActionLabels[action.type]}</p>
                <p className="mt-1 text-sm font-medium text-zinc-900">{action.title}</p>
                {action.due ? <p className="mt-1 text-xs text-zinc-600">建议时点：{action.due}</p> : null}
                {action.description ? <p className="mt-1 text-xs leading-5 text-zinc-600">{action.description}</p> : null}
              </article>
            ))
          )}
        </div>
      </DetailSection>

      <DetailSection title="来源">
        <p className="text-sm leading-6 text-zinc-700">{node.basisNote ?? "未填写形成依据。"}</p>
      </DetailSection>

      <DetailSection title="关系">
        <div className="space-y-4">
          <RelationshipRows title="入边" edges={incomingEdges} graph={graph} direction="入边" onSelectEdge={onSelectEdge} />
          <RelationshipRows title="出边" edges={outgoingEdges} graph={graph} direction="出边" onSelectEdge={onSelectEdge} />
        </div>
      </DetailSection>
    </>
  );
}

function EdgeDetail({
  edge,
  graph,
  onFocusNode,
}: {
  edge: GuidanceGraphEdge;
  graph: GuidanceGraph;
  onFocusNode: (nodeId: string) => void;
}) {
  const source = graph.nodeById.get(edge.fromGuidelineId);
  const target = graph.nodeById.get(edge.toGuidelineId);

  return (
    <>
      <div className="border-b border-zinc-200 pb-4">
        <p className="text-xs font-semibold text-emerald-700">关系详情</p>
        <h2 className="mt-2 text-lg font-semibold text-zinc-950">
          {guidanceRelationLabels[edge.relationType]}（{edge.relationType}）
        </h2>
      </div>
      <DetailSection title="方向">
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <p className="text-sm font-medium text-zinc-900">{source?.title ?? "不存在的起点卡片"}</p>
          <p className="my-2 text-center text-lg text-emerald-700">↓</p>
          <p className="text-sm font-medium text-zinc-900">{target?.title ?? "不存在的终点卡片"}</p>
        </div>
      </DetailSection>
      <DetailSection title="两端卡片">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-zinc-500">起点</dt>
            <dd className="mt-1 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-zinc-800">{source?.title ?? "不存在"}</span>
              {source ? <KindBadge kind={source.kind} /> : null}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">终点</dt>
            <dd className="mt-1 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-zinc-800">{target?.title ?? "不存在"}</span>
              {target ? <KindBadge kind={target.kind} /> : null}
            </dd>
          </div>
        </dl>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!source}
            onClick={() => source && onFocusNode(source.id)}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            聚焦起点
          </button>
          <button
            type="button"
            disabled={!target}
            onClick={() => target && onFocusNode(target.id)}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            聚焦终点
          </button>
        </div>
      </DetailSection>
      <DetailSection title="关系说明">
        <p className="text-sm leading-6 text-zinc-700">{edge.note ?? "未填写关系说明。"}</p>
      </DetailSection>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
        关系表示指导知识之间的组织或推荐关系，本页面不将其自动解释为任务已经完成、状态已经变化或动作已经执行。
      </div>
    </>
  );
}

function DiagnosticDetail({
  diagnostic,
  graph,
  onFocusNode,
  onSelectEdge,
}: {
  diagnostic: GuidanceDiagnostic;
  graph: GuidanceGraph;
  onFocusNode: (nodeId: string) => void;
  onSelectEdge: (edgeId: string) => void;
}) {
  return (
    <>
      <div className="border-b border-zinc-200 pb-4">
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${severityStyles(diagnostic.severity)}`}>
          {severityLabel(diagnostic.severity)}
        </span>
        <h2 className="mt-3 text-lg font-semibold text-zinc-950">{diagnostic.title}</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-700">{diagnostic.description}</p>
      </div>
      <DetailSection title="相关卡片">
        <div className="space-y-2">
          {diagnostic.nodeIds.length === 0 ? (
            <p className="text-sm text-zinc-500">此问题没有可定位的现存卡片。</p>
          ) : (
            diagnostic.nodeIds.map((nodeId) => {
              const node = graph.nodeById.get(nodeId);
              return (
                <button
                  key={nodeId}
                  type="button"
                  onClick={() => onFocusNode(nodeId)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-sm transition hover:border-emerald-300"
                >
                  <span className="min-w-0 truncate text-zinc-800">{node?.title ?? nodeId}</span>
                  {node ? <KindBadge kind={node.kind} /> : null}
                </button>
              );
            })
          )}
        </div>
      </DetailSection>
      <DetailSection title="相关关系">
        <div className="space-y-2">
          {diagnostic.edgeIds.length === 0 ? (
            <p className="text-sm text-zinc-500">此问题没有可定位的关系。</p>
          ) : (
            diagnostic.edgeIds.map((edgeId) => {
              const edge = graph.edgeById.get(edgeId);
              return (
                <button
                  key={edgeId}
                  type="button"
                  onClick={() => onSelectEdge(edgeId)}
                  className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-xs transition hover:border-emerald-300"
                >
                  {edge
                    ? `${guidanceRelationLabels[edge.relationType]}：${graph.nodeById.get(edge.fromGuidelineId)?.title ?? edge.fromGuidelineId} → ${graph.nodeById.get(edge.toGuidelineId)?.title ?? edge.toGuidelineId}`
                    : edgeId}
                </button>
              );
            })
          )}
        </div>
      </DetailSection>
    </>
  );
}

export function GuidanceDetailsPanel({
  graph,
  analysis,
  selection,
  onSelectNode,
  onSelectEdge,
  onSelectDiagnostic,
}: GuidanceDetailsPanelProps) {
  const selectedNode = selection?.type === "node" ? graph.nodeById.get(selection.id) : undefined;
  const selectedEdge = selection?.type === "edge" ? graph.edgeById.get(selection.id) : undefined;
  const selectedDiagnostic =
    selection?.type === "diagnostic"
      ? analysis.diagnostics.find((diagnostic) => diagnostic.id === selection.id)
      : undefined;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
      {selectedNode ? <NodeDetail node={selectedNode} graph={graph} onSelectEdge={onSelectEdge} /> : null}
      {selectedEdge ? <EdgeDetail edge={selectedEdge} graph={graph} onFocusNode={onSelectNode} /> : null}
      {selectedDiagnostic ? (
        <DiagnosticDetail
          diagnostic={selectedDiagnostic}
          graph={graph}
          onFocusNode={onSelectNode}
          onSelectEdge={onSelectEdge}
        />
      ) : null}
      {!selection ? (
        <div className="border-b border-zinc-100 py-4">
          <p className="text-sm font-medium text-zinc-800">选择一张指导卡片、关系或诊断项</p>
          <p className="mt-1 text-sm leading-6 text-zinc-600">图、列表和下方诊断列表会同步切换此处的详情。</p>
        </div>
      ) : null}

      <DetailSection title={`结构诊断（${analysis.diagnostics.length}）`}>
        <div className="space-y-2">
          {analysis.diagnostics.length === 0 ? (
            <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">未发现结构问题。</p>
          ) : (
            analysis.diagnostics.map((diagnostic) => {
              const isSelected = selection?.type === "diagnostic" && selection.id === diagnostic.id;
              return (
                <button
                  key={diagnostic.id}
                  type="button"
                  onClick={() => onSelectDiagnostic(diagnostic.id)}
                  className={`w-full rounded-md border p-3 text-left transition ${
                    isSelected ? "border-emerald-500 bg-emerald-50" : "border-zinc-200 hover:border-emerald-300"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${severityStyles(diagnostic.severity)}`}>
                      {severityLabel(diagnostic.severity)}
                    </span>
                    <span className="text-xs font-semibold leading-5 text-zinc-800">{diagnostic.title}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{diagnostic.description}</p>
                </button>
              );
            })
          )}
        </div>
      </DetailSection>
    </div>
  );
}
