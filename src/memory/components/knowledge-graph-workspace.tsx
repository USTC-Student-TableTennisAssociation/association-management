"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AIInvocation } from "@sydaris/plugin-sdk";

import type {
  KnowledgeGraphAssertionNode,
  KnowledgeGraphMode,
  KnowledgeGraphObjectNode,
  KnowledgeGraphPayload,
} from "@/memory/knowledge-graph";

type CytoscapeCore = import("cytoscape").Core;
type CytoscapeNode = import("cytoscape").NodeSingular;
type StylesheetJson = import("cytoscape").StylesheetJson;

type Selection =
  | { kind: "object"; id: string }
  | { kind: "assertion"; id: string };

const GRAPH_MODES: Array<{
  key: KnowledgeGraphMode;
  label: string;
  title: string;
}> = [
  { key: "core", label: "核心网络", title: "高连接度 Object 与代表性 Assertion" },
  { key: "all", label: "全部关系", title: "全部有 Object 连接的 Assertion" },
  { key: "isolated", label: "孤立 Object", title: "尚未连接 Assertion 的 Object" },
];

function markdownLabel(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[*_`>#~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function focusNeighborhood(cy: CytoscapeCore, node: CytoscapeNode) {
  cy.elements().removeClass("graph-focus graph-faded").addClass("graph-faded");
  const direct = node.closedNeighborhood();
  const focus = node.hasClass("object-node")
    ? direct.union(node.neighborhood("node").closedNeighborhood())
    : direct;
  focus.removeClass("graph-faded").addClass("graph-focus");
  node.addClass("graph-selected");
  cy.animate({ fit: { eles: focus, padding: 72 }, duration: 320 });
}

function graphStyles(): StylesheetJson {
  return [
    {
      selector: "node",
      style: {
        "font-family": "sans-serif",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 7,
        "transition-property": "opacity, border-width, border-color, background-color, width, height",
        "transition-duration": 180,
      },
    },
    {
      selector: "node.object-node",
      style: {
        shape: "ellipse",
        width: "mapData(visualDegree, 1, 18, 28, 56)",
        height: "mapData(visualDegree, 1, 18, 28, 56)",
        "background-color": "#ffffff",
        "border-width": 1.4,
        "border-color": "#27272a",
        label: "data(label)",
        color: "#27272a",
        "font-size": 9,
        "font-weight": "normal",
        "text-wrap": "wrap",
        "text-max-width": "88px",
        "min-zoomed-font-size": 6,
      },
    },
    {
      selector: "node.assertion-node",
      style: {
        shape: "diamond",
        width: "mapData(objectCount, 1, 5, 12, 23)",
        height: "mapData(objectCount, 1, 5, 12, 23)",
        "background-color": "#f59e0b",
        "border-width": 1,
        "border-color": "#b45309",
        label: "",
      },
    },
    {
      selector: "node.isolated-node",
      style: {
        width: 58,
        height: 58,
        "border-width": 1.8,
        "border-style": "dashed",
        "border-color": "#0f766e",
        "background-color": "#f0fdfa",
        "font-size": 11,
        "text-margin-y": 9,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1,
        "curve-style": "bezier",
        "line-color": "#b8b8b8",
        opacity: 0.42,
        "transition-property": "opacity, line-color, width",
        "transition-duration": 180,
      },
    },
    {
      selector: ".graph-faded",
      style: { opacity: 0.07 },
    },
    {
      selector: "edge.graph-focus",
      style: { opacity: 0.86, width: 1.5, "line-color": "#71717a" },
    },
    {
      selector: "node.object-node.graph-focus",
      style: { "border-width": 2, "border-color": "#18181b" },
    },
    {
      selector: "node.assertion-node.graph-focus",
      style: { "background-color": "#fb923c", "border-color": "#9a3412" },
    },
    {
      selector: "node.graph-selected",
      style: { "border-width": 3, "border-color": "#0f766e" },
    },
    {
      selector: "node.graph-search-match",
      style: { "border-width": 3, "border-color": "#38bdf8" },
    },
    {
      selector: "node.graph-hover",
      style: { "border-width": 3, "border-color": "#52525b" },
    },
  ];
}

export function KnowledgeGraphWorkspace({
  onInvokeAI,
  assistantOpen,
}: {
  onInvokeAI: (invocation: AIInvocation) => void;
  assistantOpen: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<CytoscapeCore | null>(null);
  const [mode, setMode] = useState<KnowledgeGraphMode>("core");
  const [graph, setGraph] = useState<KnowledgeGraphPayload>();
  const [selection, setSelection] = useState<Selection>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/knowledge-graph?mode=${mode}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as KnowledgeGraphPayload & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "无法读取知识图谱。");
      setGraph(body);
    }).catch((loadError) => {
      if (controller.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "无法读取知识图谱。");
    });
    return () => controller.abort();
  }, [mode, reloadToken]);

  useEffect(() => {
    if (!graph || !containerRef.current) return;
    let disposed = false;
    let core: CytoscapeCore | undefined;

    void import("cytoscape").then(({ default: cytoscape }) => {
      if (disposed || !containerRef.current) return;
      const elements = [
        ...graph.objects.map((object) => ({
          data: {
            id: `object:${object.id}`,
            entityId: object.id,
            kind: "object",
            label: object.label,
            degree: object.degree,
            visualDegree: Math.min(18, Math.max(1, object.degree)),
          },
          classes: graph.mode === "isolated" ? "object-node isolated-node" : "object-node",
        })),
        ...graph.assertions.map((assertion) => ({
          data: {
            id: `assertion:${assertion.id}`,
            entityId: assertion.id,
            kind: "assertion",
            objectCount: assertion.objectIds.length,
          },
          classes: "assertion-node",
        })),
        ...graph.edges.map((edge) => ({
          data: {
            id: `edge:${edge.id}`,
            source: `assertion:${edge.assertionId}`,
            target: `object:${edge.objectId}`,
          },
        })),
      ];

      core = cytoscape({
        container: containerRef.current,
        elements,
        style: graphStyles(),
        minZoom: 0.28,
        maxZoom: 2.2,
        selectionType: "single",
      });
      cyRef.current = core;
      if (graph.mode === "isolated") {
        core.layout({
          name: "circle",
          animate: false,
          fit: true,
          padding: 120,
          spacingFactor: 1.35,
        }).run();
      } else {
        const isAll = graph.mode === "all";
        core.layout({
          name: "cose",
          animate: false,
          randomize: true,
          nodeRepulsion: () => isAll ? 5200 : 8200,
          idealEdgeLength: () => isAll ? 52 : 74,
          edgeElasticity: () => 90,
          nestingFactor: 0.9,
          gravity: isAll ? 0.3 : 0.18,
          numIter: isAll ? 620 : 900,
          initialTemp: 180,
          coolingFactor: 0.96,
          minTemp: 1,
          padding: 64,
        }).run();
      }

      core.on("tap", "node", (event) => {
        const node = event.target as CytoscapeNode;
        const kind = node.data("kind") as Selection["kind"];
        setSelection({ kind, id: String(node.data("entityId")) });
        core?.nodes().removeClass("graph-selected");
        if (core) focusNeighborhood(core, node);
      });
      core.on("tap", (event) => {
        if (event.target !== core) return;
        setSelection(undefined);
        core?.elements().removeClass("graph-focus graph-faded graph-selected");
      });
      core.on("mouseover", "node", (event) => event.target.addClass("graph-hover"));
      core.on("mouseout", "node", (event) => event.target.removeClass("graph-hover"));
    });

    return () => {
      disposed = true;
      core?.destroy();
      if (cyRef.current === core) cyRef.current = null;
    };
  }, [graph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("graph-search-match");
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return;
    cy.nodes().filter((node) => {
      if (node.data("kind") !== "object") return false;
      return String(node.data("label")).toLocaleLowerCase("zh-CN").includes(normalized);
    }).addClass("graph-search-match");
  }, [graph, query]);

  const selectedObject = useMemo<KnowledgeGraphObjectNode | undefined>(() =>
    selection?.kind === "object"
      ? graph?.objects.find((object) => object.id === selection.id)
      : undefined,
  [graph, selection]);
  const selectedAssertion = useMemo<KnowledgeGraphAssertionNode | undefined>(() =>
    selection?.kind === "assertion"
      ? graph?.assertions.find((assertion) => assertion.id === selection.id)
      : undefined,
  [graph, selection]);
  const relatedAssertions = useMemo(() =>
    selectedObject
      ? graph?.assertions.filter((assertion) =>
          assertion.objectIds.includes(selectedObject.id)
        ) ?? []
      : [],
  [graph, selectedObject]);

  const selectEntity = useCallback((next: Selection) => {
    const cy = cyRef.current;
    const node = cy?.getElementById(`${next.kind}:${next.id}`);
    if (!cy || !node?.length) return;
    setSelection(next);
    cy.nodes().removeClass("graph-selected");
    focusNeighborhood(cy, node);
  }, []);

  function fitGraph() {
    const cy = cyRef.current;
    if (!cy) return;
    setSelection(undefined);
    cy.elements().removeClass("graph-focus graph-faded graph-selected");
    cy.animate({ fit: { eles: cy.elements(), padding: 56 }, duration: 320 });
  }

  function runLayout() {
    const cy = cyRef.current;
    if (!cy || !graph) return;
    setSelection(undefined);
    cy.elements().removeClass("graph-focus graph-faded graph-selected");
    if (graph.mode === "isolated") {
      cy.layout({
        name: "circle",
        animate: true,
        animationDuration: 420,
        fit: true,
        padding: 120,
        spacingFactor: 1.35,
      }).run();
      return;
    }
    const isAll = graph.mode === "all";
    cy.layout({
      name: "cose",
      animate: true,
      animationDuration: 520,
      randomize: true,
      nodeRepulsion: () => isAll ? 5200 : 8200,
      idealEdgeLength: () => isAll ? 52 : 74,
      edgeElasticity: () => 90,
      gravity: isAll ? 0.3 : 0.18,
      numIter: isAll ? 520 : 700,
      padding: 56,
    }).run();
  }

  function selectMode(nextMode: KnowledgeGraphMode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setGraph(undefined);
    setSelection(undefined);
    setQuery("");
    setError(undefined);
  }

  function focusFirstSearchMatch() {
    const cy = cyRef.current;
    const first = cy?.nodes(".graph-search-match").first();
    if (!cy || !first?.length) return;
    selectEntity({ kind: "object", id: String(first.data("entityId")) });
  }

  if (error) {
    return (
      <section className="flex min-h-full items-center justify-center bg-[#f7f7f5] p-6">
        <div className="max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm">
          <div className="mx-auto flex size-9 items-center justify-center rounded-full bg-red-50 text-sm text-red-600">!</div>
          <h1 className="mt-3 text-sm font-semibold text-zinc-900">知识图谱加载失败</h1>
          <p className="mt-1.5 text-xs leading-5 text-zinc-500">{error}</p>
          <button type="button" onClick={() => { setError(undefined); setReloadToken((value) => value + 1); }} className="mt-4 rounded-lg bg-zinc-950 px-3 py-2 text-xs font-medium text-white">重试</button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#f7f7f5]">
      <header className={`flex min-h-16 shrink-0 items-center justify-between border-b border-zinc-200 bg-white py-3 ${assistantOpen ? "gap-2 px-4" : "gap-4 px-5"}`}>
        <div className="min-w-0">
          <div className={`items-center gap-2 ${assistantOpen ? "hidden" : "flex"}`}>
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-teal-700">组织认知</span>
            <span className="size-1 rounded-full bg-zinc-300" />
            <span className="truncate text-[10px] text-zinc-400">{graph ? "Shared Brain" : "正在读取 Shared Brain"}</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-3">
            <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-zinc-950">知识图谱</h1>
            {graph && !assistantOpen ? (
              <p className="whitespace-nowrap text-[11px] text-zinc-500">
                展示 {graph.summary.visibleObjects} / 已连接 {graph.summary.connectedObjects} / 全部 {graph.summary.totalObjects} Object
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div role="group" aria-label="图谱显示模式" className="flex h-8 items-center rounded-lg bg-zinc-100 p-0.5">
            {GRAPH_MODES.map((option) => (
              <button
                key={option.key}
                type="button"
                title={option.title}
                aria-pressed={mode === option.key}
                onClick={() => selectMode(option.key)}
                className={`h-7 rounded-md px-2 text-[10px] transition ${mode === option.key ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {!assistantOpen ? (
            <div className="flex h-8 w-44 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 focus-within:border-zinc-300 focus-within:bg-white">
              <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" strokeLinecap="round" /></svg>
              <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") focusFirstSearchMatch(); }} placeholder="搜索 Object" className="min-w-0 flex-1 bg-transparent text-xs text-zinc-800 outline-none placeholder:text-zinc-400" />
            </div>
          ) : null}
          {!assistantOpen ? <button type="button" onClick={fitGraph} className="h-8 rounded-lg border border-zinc-200 bg-white px-2.5 text-[11px] text-zinc-600 hover:bg-zinc-50">适应画布</button> : null}
          <button type="button" onClick={runLayout} className="h-8 rounded-lg bg-zinc-950 px-2.5 text-[11px] font-medium text-white hover:bg-zinc-800">重新布局</button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div
            className="absolute inset-0"
            style={{
              backgroundColor: "#f8f8f6",
              backgroundImage: "radial-gradient(circle, rgba(113,113,122,0.18) 0.7px, transparent 0.8px)",
              backgroundSize: "18px 18px",
            }}
          >
            <div ref={containerRef} className="size-full" />
          </div>
          {!graph ? (
            <div className="absolute inset-0 flex items-center justify-center bg-[#f8f8f6]">
              <div className="text-center">
                <div className="mx-auto size-6 animate-spin rounded-full border-2 border-zinc-200 border-t-zinc-700" />
                <p className="mt-3 text-xs text-zinc-500">
                  {mode === "all" ? "正在加载全部关系…" : mode === "isolated" ? "正在查找孤立 Object…" : "正在投影核心知识网络…"}
                </p>
              </div>
            </div>
          ) : null}
          <div className="pointer-events-none absolute bottom-4 left-4 flex items-center gap-4 rounded-xl border border-white/80 bg-white/85 px-3 py-2 text-[10px] text-zinc-500 shadow-sm backdrop-blur-md">
            <span className="flex items-center gap-1.5"><span className="size-3 rounded-full border border-zinc-700 bg-white" /> Object</span>
            {mode !== "isolated" ? <span className="flex items-center gap-1.5"><span className="size-2.5 rotate-45 border border-amber-700 bg-amber-400" /> Assertion</span> : null}
            <span className="text-zinc-400">滚轮缩放 · 拖动画布 · 点击聚焦</span>
          </div>
          {graph?.summary.truncated ? (
            <div className="pointer-events-none absolute right-4 top-4 rounded-lg border border-amber-200 bg-amber-50/90 px-2.5 py-1.5 text-[10px] text-amber-800 backdrop-blur">
              核心投影 · {graph.summary.visibleObjects} / {graph.summary.connectedObjects} 个已连接 Object
            </div>
          ) : graph?.mode === "all" ? (
            <div className="pointer-events-none absolute right-4 top-4 rounded-lg border border-teal-200 bg-teal-50/90 px-2.5 py-1.5 text-[10px] text-teal-800 backdrop-blur">
              全部关系 · {graph.summary.visibleConnections} 条 Object–Assertion 连接
            </div>
          ) : graph?.mode === "isolated" ? (
            <div className="pointer-events-none absolute right-4 top-4 rounded-lg border border-zinc-200 bg-white/90 px-2.5 py-1.5 text-[10px] text-zinc-600 backdrop-blur">
              {graph.summary.unlinkedObjects} 个 Object 尚未连接 Assertion
            </div>
          ) : null}
        </div>

        <aside className={`${assistantOpen ? "hidden" : "block"} w-[310px] shrink-0 overflow-y-auto border-l border-zinc-200 bg-white p-4`}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">当前选择</p>
          {!selection ? (
            <div className="mt-3">
              <div className="rounded-xl border border-zinc-200 bg-[#fafafa] p-3.5">
                {mode === "isolated" ? (
                  <>
                    <div className="flex size-8 items-center justify-center rounded-full border border-dashed border-teal-700 bg-teal-50 text-[10px] font-semibold text-teal-800">O</div>
                    <h2 className="mt-3 text-sm font-semibold text-zinc-900">尚未建立关系</h2>
                    <p className="mt-1.5 text-xs leading-5 text-zinc-500">
                      这些 Object 已进入 Shared Brain，但暂时没有任何 Assertion 引用或语义连接。它们不是错误数据，而是待补充关系的认知入口。
                    </p>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex size-7 items-center justify-center rounded-full border border-zinc-300 bg-white text-[10px] font-semibold text-zinc-700">O</div>
                      <div className="h-px w-5 bg-zinc-300" />
                      <div className="size-3 rotate-45 border border-amber-700 bg-amber-400" />
                      <div className="h-px w-5 bg-zinc-300" />
                      <div className="flex size-7 items-center justify-center rounded-full border border-zinc-300 bg-white text-[10px] font-semibold text-zinc-700">O</div>
                    </div>
                    <h2 className="mt-3 text-sm font-semibold text-zinc-900">二部超图结构</h2>
                    <p className="mt-1.5 text-xs leading-5 text-zinc-500">
                      Object 是稳定实体节点；Assertion 是中介节点。一条 Assertion 可以自然连接任意多个 Object，不会丢失多元关系。
                    </p>
                  </>
                )}
              </div>
              {graph ? (
                <dl className="mt-4 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-2.5"><dt className="text-[10px] text-zinc-400">当前展示</dt><dd className="mt-0.5 text-base font-semibold text-zinc-800">{graph.summary.visibleObjects}</dd></div>
                  <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-2.5"><dt className="text-[10px] text-zinc-400">已连接 Object</dt><dd className="mt-0.5 text-base font-semibold text-zinc-800">{graph.summary.connectedObjects}</dd></div>
                  <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-2.5"><dt className="text-[10px] text-zinc-400">孤立 Object</dt><dd className="mt-0.5 text-base font-semibold text-zinc-800">{graph.summary.unlinkedObjects}</dd></div>
                  <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-2.5"><dt className="text-[10px] text-zinc-400">全部 Object</dt><dd className="mt-0.5 text-base font-semibold text-zinc-800">{graph.summary.totalObjects}</dd></div>
                </dl>
              ) : null}
              <button
                type="button"
                onClick={() => onInvokeAI({
                  actionId: `knowledge.explain-${mode}`,
                  message: mode === "isolated"
                    ? "帮我分析当前知识图谱中的孤立 Object。"
                    : mode === "all"
                      ? "帮我解读完整组织知识图谱。"
                      : "帮我解读组织知识图谱的核心结构。",
                })}
                className="mt-4 w-full rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                {mode === "isolated" ? "让 Sydaris 分析孤立项" : "让 Sydaris 解读这张图"}
              </button>
            </div>
          ) : null}

          {selectedObject ? (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-full bg-zinc-950 text-[10px] font-semibold text-white">O</div>
                <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-700">Object</span>
              </div>
              <h2 className="mt-3 text-base font-semibold leading-6 text-zinc-950">{selectedObject.label}</h2>
              <p className="mt-1 text-xs text-zinc-500">{selectedObject.degree ? `连接 ${selectedObject.degree} 条可见 Assertion` : "尚未连接 Assertion"}</p>
              <button type="button" onClick={() => onInvokeAI({ actionId: "knowledge.explain-object", message: `帮我解读知识图谱中的 Object「${selectedObject.label}」。` })} className="mt-3 w-full rounded-lg bg-zinc-950 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800">询问 Sydaris</button>
              {relatedAssertions.length ? <div className="mt-5 border-t border-zinc-100 pt-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-400">相关 Assertion</p>
                <div className="mt-2 space-y-1.5">
                  {relatedAssertions.slice(0, 12).map((assertion) => (
                    <button key={assertion.id} type="button" onClick={() => selectEntity({ kind: "assertion", id: assertion.id })} className="w-full rounded-lg border border-zinc-100 bg-zinc-50 px-2.5 py-2 text-left text-[11px] leading-4 text-zinc-600 hover:border-zinc-200 hover:bg-white hover:text-zinc-900">
                      {markdownLabel(assertion.statement)}
                    </button>
                  ))}
                </div>
              </div> : <div className="mt-5 rounded-lg border border-dashed border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-500">当前没有可展示的 Assertion。可以询问 Sydaris，进一步判断这个 Object 应该与哪些组织知识建立连接。</div>}
            </div>
          ) : null}

          {selectedAssertion ? (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center"><span className="size-4 rotate-45 border border-amber-700 bg-amber-400" /></div>
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">Assertion</span>
                <span className="text-[10px] text-zinc-400">{selectedAssertion.kind === "grounded" ? "事实陈述" : "引用陈述"}</span>
              </div>
              <div className="sydaris-markdown mt-3 text-[13px] leading-6 text-zinc-800">
                <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={defaultUrlTransform}>{selectedAssertion.statement}</ReactMarkdown>
              </div>
              <p className="mt-3 text-[10px] text-zinc-400">来源 · {selectedAssertion.sourceLabel}</p>
              <div className="mt-4 border-t border-zinc-100 pt-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-400">连接的 Object</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {selectedAssertion.objectIds.map((objectId) => {
                    const object = graph?.objects.find((item) => item.id === objectId);
                    if (!object) return null;
                    return <button key={objectId} type="button" onClick={() => selectEntity({ kind: "object", id: objectId })} className="rounded-full border border-zinc-200 bg-white px-2 py-1 text-[10px] text-zinc-600 hover:border-zinc-400 hover:text-zinc-900">{object.label}</button>;
                  })}
                </div>
              </div>
              <button type="button" onClick={() => onInvokeAI({ actionId: "knowledge.explain-assertion", message: `帮我解读这条 Assertion：${markdownLabel(selectedAssertion.statement)}` })} className="mt-4 w-full rounded-lg bg-zinc-950 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800">询问 Sydaris</button>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
