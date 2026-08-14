"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";

import {
  GUIDE_NODE_TYPES,
  GUIDE_NODE_TYPE_LABELS,
} from "@/semantic-view/activity-operations-contract";
import type {
  ActivityGuideNode,
  ActivityPlaybook,
  ActivityPlaybookAction,
  ActivityPlaybookCollection,
  ActivityPlaybookEditorValues,
  GuideNodeEditorValues,
  GuideNodePaths,
} from "@/semantic-view/activity-playbook";

const VIEW_CHANGED_EVENT = "echo:semantic-view-changed";
const laneWidth = 220;
const nodeWidth = 164;
const nodeHeight = 82;
const rowHeight = 154;
const topOffset = 66;

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100";

function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={wide ? "sm:col-span-2" : undefined}>
      <span className="mb-1.5 block text-xs font-medium text-zinc-600">{label}</span>
      {children}
    </label>
  );
}

function nodePosition(playbook: ActivityPlaybook, node: ActivityGuideNode) {
  const laneIndex = Math.max(0, playbook.lanes.indexOf(node.lane));
  return {
    x: laneIndex * laneWidth + (laneWidth - nodeWidth) / 2,
    y: topOffset + node.row * rowHeight,
  };
}

function nodeClass(node: ActivityGuideNode, selected: boolean): string {
  const base = selected
    ? "border-emerald-700 ring-4 ring-emerald-100"
    : "border-zinc-300 hover:border-emerald-500 hover:shadow-md";
  if (node.nodeType === "DECISION") return `${base} bg-amber-50 text-amber-950`;
  if (node.nodeType === "REFERENCE") return `${base} bg-violet-50 text-violet-950`;
  if (node.nodeType === "END") return `${base} bg-emerald-50 text-emerald-950`;
  return `${base} bg-sky-50 text-sky-950`;
}

function PlaybookMap({
  playbook,
  selectedCardId,
  onSelect,
}: {
  playbook: ActivityPlaybook;
  selectedCardId?: string;
  onSelect: (node: ActivityGuideNode) => void;
}) {
  const nodesById = useMemo(
    () => new Map(playbook.nodes.map((node) => [node.cardId, node])),
    [playbook.nodes],
  );
  const width = Math.max(playbook.lanes.length * laneWidth, 880);
  const maxRow = Math.max(0, ...playbook.nodes.map((node) => node.row));
  const height = topOffset + maxRow * rowHeight + nodeHeight + 80;

  return (
    <div className="overflow-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
      <div className="relative" style={{ width, height }}>
        {playbook.lanes.map((lane, index) => (
          <div
            key={lane}
            className="absolute inset-y-0 border-r border-zinc-200 bg-zinc-50/30"
            style={{ left: index * laneWidth, width: laneWidth }}
          >
            <div className="sticky top-0 z-20 flex h-12 items-center justify-center border-b border-zinc-200 bg-zinc-50/95 px-3 text-center text-xs font-semibold text-zinc-700 backdrop-blur">
              {lane}
            </div>
          </div>
        ))}
        <svg className="pointer-events-none absolute inset-0 z-0" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="playbook-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L8,4 L0,8 Z" fill="#64748b" />
            </marker>
          </defs>
          {playbook.edges.map((edge, index) => {
            const source = nodesById.get(edge.sourceCardId);
            const target = nodesById.get(edge.targetCardId);
            if (!source || !target) return null;
            const from = nodePosition(playbook, source);
            const to = nodePosition(playbook, target);
            const isSameRow = source.row === target.row;
            const isForward = target.row > source.row;
            let path: string;
            let labelX: number;
            let labelY: number;
            if (isSameRow) {
              const leftToRight = to.x > from.x;
              const x1 = leftToRight ? from.x + nodeWidth : from.x;
              const x2 = leftToRight ? to.x : to.x + nodeWidth;
              const y = from.y + nodeHeight / 2;
              const middleX = (x1 + x2) / 2;
              path = `M ${x1} ${y} L ${middleX} ${y} L ${x2} ${y}`;
              labelX = middleX;
              labelY = y;
            } else if (isForward) {
              const x1 = from.x + nodeWidth / 2;
              const y1 = from.y + nodeHeight;
              const x2 = to.x + nodeWidth / 2;
              const y2 = to.y;
              const middleY = (y1 + y2) / 2;
              path = `M ${x1} ${y1} L ${x1} ${middleY} L ${x2} ${middleY} L ${x2} ${y2}`;
              labelX = (x1 + x2) / 2;
              labelY = middleY;
            } else {
              const x1 = from.x + nodeWidth;
              const y1 = from.y + nodeHeight / 2;
              const x2 = to.x + nodeWidth;
              const y2 = to.y + nodeHeight / 2;
              const loopX = Math.max(x1, x2) + 26;
              path = `M ${x1} ${y1} L ${loopX} ${y1} L ${loopX} ${y2} L ${x2} ${y2}`;
              labelX = loopX;
              labelY = (y1 + y2) / 2;
            }
            return (
              <g key={`${edge.sourceCardId}-${edge.kind}-${edge.targetCardId}-${index}`}>
                <path d={path} fill="none" stroke={edge.kind === "next" ? "#64748b" : "#b7791f"} strokeWidth="1.6" markerEnd="url(#playbook-arrow)" />
                {edge.label ? (
                  <g>
                    <rect x={labelX - 13} y={labelY - 10} width="26" height="18" rx="9" fill="white" stroke="#d6d3d1" />
                    <text x={labelX} y={labelY + 3} textAnchor="middle" fontSize="11" fill="#78716c">{edge.label}</text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </svg>
        {playbook.nodes.map((node) => {
          const position = nodePosition(playbook, node);
          const isStart = playbook.startNodeCardIds.includes(node.cardId);
          return (
            <button
              key={node.cardId}
              type="button"
              onClick={() => onSelect(node)}
              className={`absolute z-10 flex flex-col items-center justify-center border px-3 text-center shadow-sm transition ${node.nodeType === "DECISION" ? "rounded-[1.6rem]" : "rounded-xl"} ${nodeClass(node, selectedCardId === node.cardId)}`}
              style={{ left: position.x, top: position.y, width: nodeWidth, height: nodeHeight }}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wide opacity-60">
                {isStart ? "起点 · " : ""}{GUIDE_NODE_TYPE_LABELS[node.nodeType]}
              </span>
              <span className="mt-1 text-sm font-semibold leading-5">{node.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GuideSection({ title, content }: { title: string; content?: string }) {
  if (!content) return null;
  return (
    <section className="border-t border-zinc-100 pt-4 first:border-t-0 first:pt-0">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h4>
      <div className="prose prose-zinc mt-2 max-w-none whitespace-pre-wrap text-sm leading-6 text-zinc-700">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </section>
  );
}

function PlaybookEditor({
  playbook,
  busy,
  onSave,
}: {
  playbook: ActivityPlaybook;
  busy: boolean;
  onSave: (values: ActivityPlaybookEditorValues) => Promise<void>;
}) {
  const [values, setValues] = useState<ActivityPlaybookEditorValues>({
    name: playbook.name,
    description: playbook.description,
    applicableScenario: playbook.applicableScenario,
    overview: playbook.overview,
    notes: playbook.notes,
    lanes: playbook.lanes,
  });
  const [laneText, setLaneText] = useState(playbook.lanes.join("\n"));
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      setError(undefined);
      await onSave({
        ...values,
        lanes: laneText.split("\n").map((lane) => lane.trim()).filter(Boolean),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <Field label="手册名称"><input required className={inputClass} value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} /></Field>
      <Field label="简介"><textarea rows={3} className={inputClass} value={values.description ?? ""} onChange={(event) => setValues({ ...values, description: event.target.value })} /></Field>
      <Field label="适用场景"><textarea rows={3} className={inputClass} value={values.applicableScenario ?? ""} onChange={(event) => setValues({ ...values, applicableScenario: event.target.value })} /></Field>
      <Field label="整体说明"><textarea rows={4} className={inputClass} value={values.overview ?? ""} onChange={(event) => setValues({ ...values, overview: event.target.value })} /></Field>
      <Field label="注意事项"><textarea rows={4} className={inputClass} value={values.notes ?? ""} onChange={(event) => setValues({ ...values, notes: event.target.value })} /></Field>
      <Field label="泳道顺序（每行一条）"><textarea required rows={8} className={inputClass} value={laneText} onChange={(event) => setLaneText(event.target.value)} /></Field>
      <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">
        调整泳道只改变地图的组织方式；它不会改变 Activity 的进度或给任何人分配任务。
      </p>
      {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <button disabled={busy} className="w-full rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">
        {busy ? "正在保存…" : "保存操作手册"}
      </button>
    </form>
  );
}

function NodeEditor({
  playbook,
  node,
  busy,
  onSave,
}: {
  playbook: ActivityPlaybook;
  node?: ActivityGuideNode;
  busy: boolean;
  onSave: (values: GuideNodeEditorValues, paths: GuideNodePaths) => Promise<void>;
}) {
  const [values, setValues] = useState<GuideNodeEditorValues>(() => node
    ? {
        name: node.name,
        nodeType: node.nodeType,
        lane: node.lane,
        row: node.row,
        guide: node.guide,
        applicableCondition: node.applicableCondition,
        requiredInformation: node.requiredInformation,
        expectedOutcome: node.expectedOutcome,
        aiAssistance: node.aiAssistance,
        resources: node.resources,
      }
    : {
        name: "",
        nodeType: "ACTION",
        lane: playbook.lanes[0] ?? "未分组",
        row: Math.max(0, ...playbook.nodes.map((item) => item.row)) + 1,
      });
  const [paths, setPaths] = useState<GuideNodePaths>(node?.paths ?? {
    nextCardIds: [],
    whenYesCardId: null,
    whenNoCardId: null,
  });
  const [error, setError] = useState<string>();
  const possibleTargets = playbook.nodes.filter((item) => item.cardId !== node?.cardId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      setError(undefined);
      await onSave(values, paths);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="节点名称" wide>
          <input required className={inputClass} value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} />
        </Field>
        <Field label="节点类型">
          <select className={inputClass} value={values.nodeType} onChange={(event) => setValues({ ...values, nodeType: event.target.value as GuideNodeEditorValues["nodeType"] })}>
            {GUIDE_NODE_TYPES.map((type) => <option key={type} value={type}>{GUIDE_NODE_TYPE_LABELS[type]}</option>)}
          </select>
        </Field>
        <Field label="泳道">
          <select className={inputClass} value={values.lane} onChange={(event) => setValues({ ...values, lane: event.target.value })}>
            {playbook.lanes.map((lane) => <option key={lane} value={lane}>{lane}</option>)}
          </select>
        </Field>
        <Field label="纵向位置">
          <input type="number" min={0} max={100} className={inputClass} value={values.row} onChange={(event) => setValues({ ...values, row: Number(event.target.value) })} />
        </Field>
        <div />
        <Field label="操作指南" wide>
          <textarea rows={5} className={inputClass} value={values.guide ?? ""} onChange={(event) => setValues({ ...values, guide: event.target.value })} />
        </Field>
        <Field label="适用条件" wide>
          <textarea rows={3} className={inputClass} value={values.applicableCondition ?? ""} onChange={(event) => setValues({ ...values, applicableCondition: event.target.value })} />
        </Field>
        <Field label="所需信息" wide>
          <textarea rows={3} className={inputClass} value={values.requiredInformation ?? ""} onChange={(event) => setValues({ ...values, requiredInformation: event.target.value })} />
        </Field>
        <Field label="预期结果" wide>
          <textarea rows={3} className={inputClass} value={values.expectedOutcome ?? ""} onChange={(event) => setValues({ ...values, expectedOutcome: event.target.value })} />
        </Field>
        <Field label="AI 协助说明" wide>
          <textarea rows={4} className={inputClass} value={values.aiAssistance ?? ""} onChange={(event) => setValues({ ...values, aiAssistance: event.target.value })} />
        </Field>
        <Field label="资源与入口" wide>
          <textarea rows={4} className={inputClass} placeholder="支持 Markdown 链接" value={values.resources ?? ""} onChange={(event) => setValues({ ...values, resources: event.target.value })} />
        </Field>
        {node ? (
          <>
            <Field label="普通后续建议" wide>
              <select multiple className={`${inputClass} min-h-32`} value={paths.nextCardIds} onChange={(event) => setPaths({ ...paths, nextCardIds: [...event.target.selectedOptions].map((option) => option.value) })}>
                {possibleTargets.map((target) => <option key={target.cardId} value={target.cardId}>{target.name}</option>)}
              </select>
            </Field>
            <Field label="判断为“是”">
              <select className={inputClass} value={paths.whenYesCardId ?? ""} onChange={(event) => setPaths({ ...paths, whenYesCardId: event.target.value || null })}>
                <option value="">无</option>
                {possibleTargets.map((target) => <option key={target.cardId} value={target.cardId}>{target.name}</option>)}
              </select>
            </Field>
            <Field label="判断为“否”">
              <select className={inputClass} value={paths.whenNoCardId ?? ""} onChange={(event) => setPaths({ ...paths, whenNoCardId: event.target.value || null })}>
                <option value="">无</option>
                {possibleTargets.map((target) => <option key={target.cardId} value={target.cardId}>{target.name}</option>)}
              </select>
            </Field>
          </>
        ) : null}
      </div>
      <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">
        这些路径只用于展示、导航和 AI 理解，不会锁定用户的执行顺序，也不会生成打卡状态。
      </p>
      {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <button disabled={busy} className="w-full rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">
        {busy ? "正在保存…" : node ? "保存节点与路径" : "新增指南节点"}
      </button>
    </form>
  );
}

export function ActivityPlaybookOverview({
  onAskAI,
}: {
  onAskAI: (prompt: string) => void;
}) {
  const [collection, setCollection] = useState<ActivityPlaybookCollection>();
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [editing, setEditing] = useState<"new" | "edit">();
  const [editingPlaybook, setEditingPlaybook] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/activity-operations/playbooks", { cache: "no-store" });
      const body = await response.json() as ActivityPlaybookCollection & { error?: string };
      if (!response.ok) throw new Error(body.error || "无法读取操作手册");
      setCollection(body);
      setSelectedPlaybookId((current) => current ?? body.playbooks[0]?.cardId);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const refresh = () => void load();
    window.addEventListener(VIEW_CHANGED_EVENT, refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(VIEW_CHANGED_EVENT, refresh);
    };
  }, [load]);

  const playbook = collection?.playbooks.find((item) => item.cardId === selectedPlaybookId)
    ?? collection?.playbooks[0];
  const selectedNode = playbook?.nodes.find((node) => node.cardId === selectedNodeId);

  async function mutate(action: ActivityPlaybookAction) {
    setBusy(true);
    try {
      const response = await fetch("/api/activity-operations/playbooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      const body = await response.json() as ActivityPlaybookCollection & { error?: string };
      if (!response.ok) throw new Error(body.error || "保存失败");
      setCollection(body);
      setSelectedPlaybookId((current) => current ?? body.playbooks[0]?.cardId);
      setEditing(undefined);
      setEditingPlaybook(false);
      setError(undefined);
      window.dispatchEvent(new CustomEvent(VIEW_CHANGED_EVENT, {
        detail: { viewKey: "activity_operations" },
      }));
    } finally {
      setBusy(false);
    }
  }

  if (!collection && !error) return <p className="text-sm text-zinc-500">正在读取操作手册…</p>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-950">建议型流程地图</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-500">
            用结构化路径帮助人和 AI 理解工作；不跟踪节点完成状态，不限制用户如何执行。
          </p>
        </div>
        {playbook ? (
          <div className="flex gap-2">
            <button type="button" onClick={() => {
              setSelectedNodeId(undefined);
              setEditing(undefined);
              setEditingPlaybook(true);
            }} className="rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-700">编辑手册</button>
            <button type="button" onClick={() => {
              setSelectedNodeId(undefined);
              setEditingPlaybook(false);
              setEditing("new");
            }} className="rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-medium text-white">＋ 新增指南节点</button>
          </div>
        ) : null}
      </div>
      {error ? <p className="mb-4 rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p> : null}
      {collection && !collection.playbooks.length ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-14 text-center">
          <p className="font-medium text-zinc-800">还没有操作手册</p>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-zinc-500">
            可以先根据你过去的泳道图建立一份示例，再直接编辑节点与建议路径。
          </p>
          <button type="button" disabled={busy} onClick={() => void mutate({ type: "CREATE_SAMPLE_PLAYBOOK" })} className="mt-5 rounded-lg bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "正在建立…" : "建立社团活动筹备示例"}
          </button>
        </div>
      ) : null}
      {playbook ? (
        <>
          <div className="mb-4 rounded-xl border border-zinc-200 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-zinc-900">{playbook.name}</h3>
                <p className="mt-1 text-sm leading-6 text-zinc-600">{playbook.description}</p>
              </div>
              {collection && collection.playbooks.length > 1 ? (
                <select className={inputClass} value={playbook.cardId} onChange={(event) => {
            setSelectedPlaybookId(event.target.value);
            setSelectedNodeId(undefined);
            setEditingPlaybook(false);
                }}>
                  {collection.playbooks.map((item) => <option key={item.cardId} value={item.cardId}>{item.name}</option>)}
                </select>
              ) : null}
            </div>
            {playbook.applicableScenario ? <p className="mt-3 text-xs text-zinc-500">适用场景：{playbook.applicableScenario}</p> : null}
          </div>
          <PlaybookMap playbook={playbook} selectedCardId={selectedNodeId} onSelect={(node) => {
            setSelectedNodeId(node.cardId);
            setEditing(undefined);
            setEditingPlaybook(false);
          }} />
          <p className="mt-3 text-xs text-zinc-400">点击任意节点查看指南。蓝色=操作建议，黄色=判断，紫色=资料/系统，绿色=结果。</p>
        </>
      ) : null}

      {playbook && (selectedNode || editing === "new" || editingPlaybook) ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-zinc-950/20" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setSelectedNodeId(undefined);
            setEditing(undefined);
            setEditingPlaybook(false);
          }
        }}>
          <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-zinc-200 bg-white p-6 shadow-2xl">
            <header className="mb-6 flex items-start justify-between gap-4 border-b border-zinc-200 pb-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">操作手册节点</p>
                <h3 className="mt-1 text-xl font-semibold text-zinc-950">{editingPlaybook ? "编辑操作手册" : editing === "new" ? "新增指南节点" : selectedNode?.name}</h3>
              </div>
              <button type="button" onClick={() => {
                setSelectedNodeId(undefined);
                setEditing(undefined);
                setEditingPlaybook(false);
              }} className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-zinc-600">×</button>
            </header>
            {editingPlaybook ? (
              <PlaybookEditor
                key={playbook.cardId}
                playbook={playbook}
                busy={busy}
                onSave={(values) => mutate({
                  type: "UPDATE_PLAYBOOK",
                  cardId: playbook.cardId,
                  values,
                })}
              />
            ) : editing ? (
              <NodeEditor
                key={selectedNode?.cardId ?? "new"}
                playbook={playbook}
                node={editing === "edit" ? selectedNode : undefined}
                busy={busy}
                onSave={async (values, paths) => {
                  if (selectedNode && editing === "edit") {
                    await mutate({
                      type: "UPDATE_GUIDE_NODE",
                      playbookCardId: playbook.cardId,
                      cardId: selectedNode.cardId,
                      values,
                      paths,
                    });
                  } else {
                    await mutate({
                      type: "CREATE_GUIDE_NODE",
                      playbookCardId: playbook.cardId,
                      values,
                    });
                  }
                }}
              />
            ) : selectedNode ? (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700">{GUIDE_NODE_TYPE_LABELS[selectedNode.nodeType]}</span>
                  <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600">{selectedNode.lane}</span>
                </div>
                <GuideSection title="操作指南" content={selectedNode.guide} />
                <GuideSection title="适用条件" content={selectedNode.applicableCondition} />
                <GuideSection title="所需信息" content={selectedNode.requiredInformation} />
                <GuideSection title="预期结果" content={selectedNode.expectedOutcome} />
                <GuideSection title="资源与入口" content={selectedNode.resources} />
                <GuideSection title="AI 可以如何协助" content={selectedNode.aiAssistance} />
                <div className="grid gap-2 pt-3 sm:grid-cols-2">
                  <button type="button" onClick={() => onAskAI([
                    `我正在查看操作手册“${playbook.name}”中的节点“${selectedNode.name}”。`,
                    "请结合当前 Activity Operations 的正式状态，告诉我这个指南是否适用、当前还缺哪些信息，以及你可以提供什么帮助。",
                    "不要假设我已经执行到该节点，也不要将指南当作强制流程。",
                  ].join("\n"))} className="rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-medium text-white">带着此节点询问 AI</button>
                  <button type="button" onClick={() => setEditing("edit")} className="rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-700">编辑节点与路径</button>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
