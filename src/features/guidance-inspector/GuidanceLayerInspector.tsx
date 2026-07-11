"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";

import { analyzeGuidanceGraph } from "./guidance-analysis";
import { GuidanceDetailsPanel } from "./GuidanceDetailsPanel";
import { defaultGuidanceFilters, getFilteredGuidanceNodes, type GuidanceFilterState } from "./guidance-filters";
import { buildGuidanceGraph } from "./guidance-graph";
import {
  GuidanceGraphCanvas,
  type GuidanceGraphCanvasHandle,
} from "./GuidanceGraphCanvas";
import { GuidanceListPanel } from "./GuidanceListPanel";
import {
  guidanceRelationLabels,
  type GuidanceGraphSource,
  type InspectorSelection,
} from "./guidance-types";

type GuidanceLayerInspectorProps = {
  source: GuidanceGraphSource;
};

function StatCard({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-sm">
      <p className="truncate text-[11px] font-medium text-zinc-500">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-zinc-950">{value}</p>
      {detail ? <p className="mt-0.5 truncate text-[11px] text-zinc-500">{detail}</p> : null}
    </div>
  );
}

export function GuidanceLayerInspector({ source }: GuidanceLayerInspectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const canvasRef = useRef<GuidanceGraphCanvasHandle | null>(null);
  const graph = useMemo(() => buildGuidanceGraph(source.nodes, source.links), [source.links, source.nodes]);
  const analysis = useMemo(() => analyzeGuidanceGraph(graph), [graph]);
  const [filters, setFilters] = useState<GuidanceFilterState>(defaultGuidanceFilters);
  const [selection, setSelection] = useState<InspectorSelection>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [isLeftOpen, setIsLeftOpen] = useState(true);
  const [isRightOpen, setIsRightOpen] = useState(true);
  const [isArrangeMode, setIsArrangeMode] = useState(false);

  const filteredNodes = useMemo(() => getFilteredGuidanceNodes(graph, filters), [filters, graph]);
  const matchingNodeIds = useMemo(() => filteredNodes.map((node) => node.id), [filteredNodes]);
  const nodeIdFromUrl = searchParams.get("node");
  const selectionFromUrl =
    nodeIdFromUrl && graph.nodeById.has(nodeIdFromUrl)
      ? ({ type: "node", id: nodeIdFromUrl } as const)
      : null;
  const activeSelection = selectionFromUrl ?? selection;
  const selectedNode = activeSelection?.type === "node" ? graph.nodeById.get(activeSelection.id) : undefined;
  const selectedEdge = activeSelection?.type === "edge" ? graph.edgeById.get(activeSelection.id) : undefined;
  const selectedDiagnostic =
    activeSelection?.type === "diagnostic"
      ? analysis.diagnostics.find((diagnostic) => diagnostic.id === activeSelection.id)
      : undefined;

  const replaceNodeInUrl = useCallback(
    (nodeId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (nodeId) {
        params.set("node", nodeId);
      } else {
        params.delete("node");
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const handleSelectionChange = useCallback(
    (nextSelection: InspectorSelection) => {
      if (nextSelection?.type === "node") {
        setSelection(null);
        replaceNodeInUrl(nextSelection.id);
        return;
      }

      setSelection(nextSelection);
      replaceNodeInUrl(null);
    },
    [replaceNodeInUrl],
  );

  const selectionLabel =
    isArrangeMode
      ? "正在整理布局"
      : selectedNode?.title ??
    (selectedEdge
      ? `${guidanceRelationLabels[selectedEdge.relationType]}关系`
      : selectedDiagnostic
        ? selectedDiagnostic.title
        : filters.query || filteredNodes.length !== graph.nodes.length
          ? `筛选结果 ${filteredNodes.length} / ${graph.nodes.length}`
          : "未选择节点");

  return (
    <main className="min-h-dvh bg-[#f6f7f4] text-zinc-950">
      <div className="mx-auto flex min-h-dvh max-w-[1900px] flex-col px-3 py-3 sm:px-4 lg:h-dvh">
        <header className="flex flex-col gap-3 border-b border-zinc-200/80 px-1 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <Link href="/" className="text-xs font-medium text-emerald-700 transition hover:text-emerald-900">
                ← 返回助手
              </Link>
              <span className="h-3 w-px bg-zinc-300" />
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-emerald-700">Guidance Layer</p>
            </div>
            <h1 className="mt-2 text-xl font-semibold tracking-tight text-zinc-950 sm:text-2xl">指导层结构观察器</h1>
            <p className="mt-1 text-sm text-zinc-600">只读浏览《乒协生存手册》指导卡片、关系与结构风险。</p>
          </div>
          <p className="max-w-md rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 shadow-sm">
            当前数据来源：本地种子草稿；不修改数据库或指导内容。
          </p>
        </header>

        <section className="grid grid-cols-2 gap-2 py-3 sm:grid-cols-3 xl:grid-cols-5">
          <StatCard label="节点总数" value={graph.nodes.length} detail="全部指导卡片" />
          <StatCard label="关系总数" value={graph.edges.length} detail="有向关系" />
          <StatCard label="孤立节点" value={analysis.isolatedNodeIds.length} detail="没有有效关系" />
          <StatCard
            label="结构警告"
            value={analysis.structureWarningCount}
            detail={`${analysis.diagnosticsBySeverity.error} 错误 / ${analysis.diagnosticsBySeverity.warning} 警告`}
          />
          <StatCard label="当前状态" value={selectionLabel} detail={`列表结果 ${filteredNodes.length} / ${graph.nodes.length}`} />
        </section>

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm lg:flex-row">
          <aside
            className={`flex shrink-0 flex-col border-b border-zinc-200 bg-zinc-50/70 transition-[width] duration-200 lg:min-h-0 lg:border-b-0 lg:border-r ${
              isLeftOpen ? "w-full lg:w-[21rem]" : "w-full lg:w-12"
            }`}
          >
            <div className="flex min-h-11 w-full items-center justify-between border-b border-zinc-200 px-3">
              {isLeftOpen ? <h2 className="text-sm font-semibold text-zinc-900">卡片与筛选</h2> : null}
              <button
                type="button"
                onClick={() => setIsLeftOpen((open) => !open)}
                className="ml-auto rounded-md p-2 text-zinc-600 transition hover:bg-zinc-200 hover:text-zinc-900"
                aria-label={isLeftOpen ? "折叠左侧栏" : "展开左侧栏"}
              >
                {isLeftOpen ? "‹" : "›"}
              </button>
            </div>
            {isLeftOpen ? (
              <GuidanceListPanel
                graph={graph}
                filters={filters}
                selectedNodeId={selectedNode?.id ?? null}
                onFiltersChange={setFilters}
                onSelectNode={(nodeId) => handleSelectionChange({ type: "node", id: nodeId })}
                onHoverNode={setHoveredNodeId}
              />
            ) : null}
          </aside>

          <section className="flex min-h-[620px] min-w-0 flex-1 flex-col bg-[#fbfcfa] p-3 sm:p-4 lg:min-h-0">
            <div className="mb-3 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-zinc-900">自由知识图</h2>
                  <span className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[11px] text-zinc-600">有向关系</span>
                </div>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500">
                  节点间距离仅表示当前布局，不表示语义相似度、工作优先级或任务完成顺序。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={isArrangeMode}
                  onClick={() => {
                    const nextArrangeMode = !isArrangeMode;
                    setIsArrangeMode(nextArrangeMode);
                    if (nextArrangeMode) {
                      handleSelectionChange(null);
                    }
                  }}
                  className={`rounded-md border px-3 py-2 text-xs font-medium transition ${
                    isArrangeMode
                      ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800"
                      : "border-zinc-200 bg-white text-zinc-700 hover:border-emerald-300 hover:text-emerald-800"
                  }`}
                >
                  {isArrangeMode ? "完成整理" : "整理布局"}
                </button>
                <button
                  type="button"
                  onClick={() => canvasRef.current?.fitGraph()}
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-emerald-300 hover:text-emerald-800"
                >
                  适应画布
                </button>
                <button
                  type="button"
                  onClick={() => canvasRef.current?.runAutomaticLayout()}
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-emerald-300 hover:text-emerald-800"
                >
                  重新自动布局
                </button>
                <button
                  type="button"
                  onClick={() => canvasRef.current?.restoreDefaultLayout()}
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-emerald-300 hover:text-emerald-800"
                >
                  恢复默认布局
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectionChange(null)}
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:border-emerald-300 hover:text-emerald-800"
                >
                  清除选择
                </button>
              </div>
            </div>

            <div className="mb-3 flex flex-wrap gap-2 text-[11px] text-zinc-600">
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1">◆ 流程</span>
              <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-1">! 规则</span>
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1">☑ 检查表</span>
              <span className="rounded-full border border-purple-200 bg-purple-50 px-2 py-1">✦ 经验</span>
              <span className="rounded-full border border-zinc-200 bg-white px-2 py-1">虚线边：触发 / 例外</span>
              <span className="rounded-full border border-zinc-200 bg-white px-2 py-1">粗线：前置</span>
            </div>

            <GuidanceGraphCanvas
              ref={canvasRef}
              graph={graph}
              selection={activeSelection}
              isArrangeMode={isArrangeMode}
              matchingNodeIds={matchingNodeIds}
              onlyShowMatches={filters.onlyShowMatches}
              hoveredNodeId={hoveredNodeId}
              diagnosticNodeIds={selectedDiagnostic?.nodeIds ?? []}
              diagnosticEdgeIds={selectedDiagnostic?.edgeIds ?? []}
              onSelectionChange={handleSelectionChange}
            />
          </section>

          <aside
            className={`flex shrink-0 flex-col border-t border-zinc-200 bg-white transition-[width] duration-200 lg:min-h-0 lg:border-l lg:border-t-0 ${
              isRightOpen ? "w-full lg:w-[24rem]" : "w-full lg:w-12"
            }`}
          >
            <div className="flex min-h-11 w-full items-center justify-between border-b border-zinc-200 px-3">
              {isRightOpen ? <h2 className="text-sm font-semibold text-zinc-900">详情与诊断</h2> : null}
              <button
                type="button"
                onClick={() => setIsRightOpen((open) => !open)}
                className="ml-auto rounded-md p-2 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
                aria-label={isRightOpen ? "折叠右侧栏" : "展开右侧栏"}
              >
                {isRightOpen ? "›" : "‹"}
              </button>
            </div>
            {isRightOpen ? (
              <GuidanceDetailsPanel
                graph={graph}
                analysis={analysis}
                selection={activeSelection}
                onSelectNode={(nodeId) => handleSelectionChange({ type: "node", id: nodeId })}
                onSelectEdge={(edgeId) => handleSelectionChange({ type: "edge", id: edgeId })}
                onSelectDiagnostic={(diagnosticId) => handleSelectionChange({ type: "diagnostic", id: diagnosticId })}
              />
            ) : null}
          </aside>
        </section>
      </div>
    </main>
  );
}
