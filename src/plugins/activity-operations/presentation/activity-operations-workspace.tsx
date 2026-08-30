"use client";

import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PresentationProps, ViewCommandResult, ViewCardState } from "@sydaris/plugin-sdk";
import { useViewCommand, useView } from "@sydaris/plugin-sdk/react";

import {
  type ActivityStudioModel,
  type MethodEdge,
  type PlaybookModel,
  type TaskMapPackage,
  buildActivityStudio,
  numberValue,
  ownerNames,
  text,
} from "./activity-workspace-state.js";
import styles from "./activity-operations.module.css";

type WorkspaceProps = PresentationProps;
type StudioMode = "method" | "map";
type EditorTarget =
  | { kind: "activity"; card?: ViewCardState }
  | { kind: "playbook"; card?: ViewCardState }
  | { kind: "node"; playbookId: string; card?: ViewCardState }
  | { kind: "workPackage"; activityId: string; card?: ViewCardState }
  | { kind: "task"; activityId: string; workPackageId: string; card?: ViewCardState }
  | { kind: "edge"; playbookId: string; fromNodeId?: string }
  | { kind: "dependency"; activityId: string; targetType: "WORK_PACKAGE" | "TASK"; targetId?: string };

const activityStatusLabels: Record<string, string> = {
  PLANNING: "筹备中", RUNNING: "进行中", WRAP_UP: "收尾中", COMPLETED: "已结束", CANCELLED: "已取消",
};
const workStatusLabels: Record<string, string> = {
  NOT_STARTED: "未开始", IN_PROGRESS: "进行中", BLOCKED: "受阻", COMPLETED: "已完成", CANCELLED: "已取消",
};
const priorityLabels: Record<string, string> = { LOW: "低", NORMAL: "普通", HIGH: "高", CRITICAL: "紧急" };
const nodeTypeLabels: Record<string, string> = { ACTION: "行动", DECISION: "判断", REFERENCE: "参考", END: "结束" };
const playbookStatusLabels: Record<string, string> = { DRAFT: "整理中", READY: "可使用", ARCHIVED: "已归档" };
const branchLabels: Record<MethodEdge["branch"], string> = { NEXT: "下一步", YES: "是", NO: "否" };

function Icon({ name }: { name: "book" | "map" | "plus" | "link" | "spark" | "edit" | "close" | "check" | "warning" | "arrow" | "layers" | "person" | "calendar" | "refresh" | "branch" }) {
  const paths: Record<string, React.ReactNode> = {
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z" /></>,
    map: <><circle cx="5" cy="5" r="2" /><circle cx="19" cy="7" r="2" /><circle cx="8" cy="19" r="2" /><path d="m7 5.5 10 1M6 7l1.5 10M18 9l-8.5 8.5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>,
    spark: <><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></>,
    edit: <><path d="m14.5 4.5 5 5L8 21l-6 1 1-6L14.5 4.5Z" /><path d="m12.5 6.5 5 5" /></>,
    close: <path d="m5 5 14 14M19 5 5 19" />,
    check: <path d="m4 12.5 5 5L20 6.5" />,
    warning: <><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 9v5M12 17.5v.5" /></>,
    arrow: <path d="m8 5 7 7-7 7M15 12H3" />,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m4 12 8 4.5 8-4.5M4 16l8 4.5 8-4.5" /></>,
    person: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21c.5-4.5 2.8-7 7-7s6.5 2.5 7 7" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 2.5V7M17 2.5V7M3 10h18" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7.5 7.5 0 1 0-1.4 5.2" /></>,
    branch: <><path d="M6 4v7a5 5 0 0 0 5 5h7" /><path d="m15 13 3 3-3 3M6 4l3 3M6 4 3-3" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function statusTone(card: ViewCardState): string {
  const status = text(card, "status") ?? "NOT_STARTED";
  if (["COMPLETED", "READY"].includes(status)) return "complete";
  if (["BLOCKED", "CRITICAL"].includes(status)) return "risk";
  if (["IN_PROGRESS", "RUNNING"].includes(status)) return "active";
  if (["CANCELLED", "ARCHIVED"].includes(status)) return "muted";
  return "pending";
}

function field(card: ViewCardState | undefined, key: string): string {
  const value = card?.dimensions[key];
  return value === undefined || value === null ? "" : String(value);
}

function activityTime(card: ViewCardState | undefined): { start?: string; end?: string } {
  const value = card?.dimensions.time;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const range = value as Record<string, unknown>;
  return {
    ...(typeof range.start === "string" ? { start: range.start } : {}),
    ...(typeof range.end === "string" ? { end: range.end } : {}),
  };
}

function dateLabel(value: string | undefined): string {
  if (!value) return "无截止日";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(parsed);
}

function formValue(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function optional(value: string): string | undefined {
  return value || undefined;
}

function cleared(value: string): string | null {
  return value || null;
}

function FormSheet({ target, model, saving, error, onClose, onSave }: {
  target: EditorTarget;
  model: ActivityStudioModel;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (values: Record<string, unknown>) => void;
}) {
  const card = "card" in target ? target.card : undefined;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (target.kind === "playbook") {
      onSave({
        name: formValue(form, "name"), description: formValue(form, "description"), applicableScenario: formValue(form, "applicableScenario"),
        overview: formValue(form, "overview"), notes: formValue(form, "notes"), lanes: formValue(form, "lanes"), status: formValue(form, "status"),
      });
    } else if (target.kind === "node") {
      onSave({
        name: formValue(form, "name"), nodeType: formValue(form, "nodeType"), lane: formValue(form, "lane"),
        row: formValue(form, "row") ? Number(formValue(form, "row")) : undefined, guide: formValue(form, "guide"),
        applicableCondition: formValue(form, "applicableCondition"), requiredInformation: formValue(form, "requiredInformation"),
        expectedOutcome: formValue(form, "expectedOutcome"), aiAssistance: formValue(form, "aiAssistance"), durationHint: formValue(form, "durationHint"),
        taskSuggestions: formValue(form, "taskSuggestions").split(/[，,\n]/).map((item) => item.trim()).filter(Boolean),
      });
    } else if (target.kind === "activity") {
      const start = formValue(form, "start");
      const end = formValue(form, "end");
      onSave({ name: formValue(form, "name"), description: formValue(form, "description"), status: formValue(form, "status"), time: start ? { start, ...(end ? { end } : {}) } : undefined });
    } else if (target.kind === "workPackage" || target.kind === "task") {
      onSave({
        name: formValue(form, "name"), description: formValue(form, "description"), status: formValue(form, "status"),
        priority: formValue(form, "priority"), deadline: formValue(form, "deadline"), progress: formValue(form, "progress"),
      });
    } else if (target.kind === "edge") {
      onSave({ fromNodeId: formValue(form, "fromNodeId"), toNodeId: formValue(form, "toNodeId"), branch: formValue(form, "branch") });
    } else {
      onSave({ targetId: formValue(form, "targetId"), dependsOnId: formValue(form, "dependsOnId") });
    }
  };
  const title = target.kind === "playbook" ? `${card ? "编辑" : "新建"}组织方法`
    : target.kind === "node" ? `${card ? "编辑" : "添加"}流程步骤`
      : target.kind === "activity" ? `${card ? "编辑" : "新建"}活动`
        : target.kind === "workPackage" ? `${card ? "编辑" : "添加"}工作包`
          : target.kind === "task" ? `${card ? "编辑" : "添加"}任务`
            : target.kind === "edge" ? "连接流程步骤" : "添加前置依赖";
  const playbook = target.kind === "node" || target.kind === "edge" ? model.playbooks.find(({ card: item }) => item.id === target.playbookId) : undefined;
  const allTasks = model.workPackages.flatMap((item) => item.tasks.map(({ card: task }) => task));
  const dependencyOptions = target.kind === "dependency" && target.targetType === "TASK" ? allTasks : model.workPackages.map(({ card: item }) => item);
  return (
    <div className={styles.sheetBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="editor-title">
        <header><div><p>活动运营</p><h2 id="editor-title">{title}</h2></div><button type="button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></header>
        <form onSubmit={submit}>
          {(target.kind === "playbook" || target.kind === "node" || target.kind === "activity" || target.kind === "workPackage" || target.kind === "task") ? <>
            <label className={styles.fullField}><span>名称</span><input name="name" required maxLength={200} defaultValue={field(card, "name")} autoFocus /></label>
            <label className={styles.fullField}><span>说明</span><textarea name="description" rows={3} defaultValue={field(card, "description")} /></label>
          </> : null}
          {target.kind === "playbook" ? <>
            <label className={styles.fullField}><span>适用场景</span><textarea name="applicableScenario" rows={3} defaultValue={field(card, "applicable_scenario")} /></label>
            <label className={styles.fullField}><span>整体组织建议</span><textarea name="overview" rows={4} defaultValue={field(card, "overview")} /></label>
            <label className={styles.fullField}><span>泳道顺序</span><input name="lanes" placeholder="统筹，内容，现场，财务" defaultValue={field(card, "lanes")} /></label>
            <label><span>成熟度</span><select name="status" defaultValue={field(card, "status") || "DRAFT"}>{Object.entries(playbookStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className={styles.fullField}><span>注意事项</span><textarea name="notes" rows={3} defaultValue={field(card, "notes")} /></label>
          </> : null}
          {target.kind === "node" ? <>
            <div className={styles.fieldRow}><label><span>节点类型</span><select name="nodeType" defaultValue={field(card, "node_type") || "ACTION"}>{Object.entries(nodeTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>泳道</span><input name="lane" list="lane-options" defaultValue={field(card, "lane")} /><datalist id="lane-options">{playbook?.lanes.map((lane) => <option key={lane} value={lane} />)}</datalist></label><label><span>顺序</span><input name="row" type="number" min="0" defaultValue={field(card, "row")} /></label></div>
            <label className={styles.fullField}><span>怎么做</span><textarea name="guide" rows={4} defaultValue={field(card, "guide")} /></label>
            <label className={styles.fullField}><span>进入条件</span><textarea name="applicableCondition" rows={2} defaultValue={field(card, "applicable_condition")} /></label>
            <label className={styles.fullField}><span>需要准备</span><textarea name="requiredInformation" rows={2} defaultValue={field(card, "required_information")} /></label>
            <label className={styles.fullField}><span>完成标志</span><textarea name="expectedOutcome" rows={2} defaultValue={field(card, "expected_outcome")} /></label>
            <div className={styles.fieldRow}><label><span>时间建议</span><input name="durationHint" defaultValue={field(card, "duration_hint")} /></label><label><span>AI 协助</span><input name="aiAssistance" defaultValue={field(card, "ai_assistance")} /></label></div>
            {!card ? <label className={styles.fullField}><span>生成的典型任务</span><textarea name="taskSuggestions" rows={3} placeholder="确认场地，整理物料清单，完成验收" /></label> : null}
          </> : null}
          {target.kind === "activity" ? <><label><span>阶段</span><select name="status" defaultValue={field(card, "status") || "PLANNING"}>{Object.entries(activityStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className={styles.fieldRow}><label><span>开始日期</span><input type="date" name="start" defaultValue={activityTime(card).start} /></label><label><span>结束日期</span><input type="date" name="end" defaultValue={activityTime(card).end} /></label></div></> : null}
          {target.kind === "workPackage" || target.kind === "task" ? <><div className={styles.fieldRow}><label><span>状态</span><select name="status" defaultValue={field(card, "status") || "NOT_STARTED"}>{Object.entries(workStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>优先级</span><select name="priority" defaultValue={field(card, "priority") || "NORMAL"}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>截止日</span><input type="date" name="deadline" defaultValue={field(card, "deadline")} /></label></div><label className={styles.fullField}><span>当前进展</span><textarea name="progress" rows={3} defaultValue={field(card, "progress")} /></label></> : null}
          {target.kind === "edge" ? <><label><span>从</span><select name="fromNodeId" defaultValue={target.fromNodeId} required>{playbook?.nodes.map(({ card: node }) => <option key={node.id} value={node.id}>{text(node, "name")}</option>)}</select></label><label><span>到</span><select name="toNodeId" required defaultValue=""><option value="" disabled>选择后续步骤</option>{playbook?.nodes.filter(({ card: node }) => node.id !== target.fromNodeId).map(({ card: node }) => <option key={node.id} value={node.id}>{text(node, "name")}</option>)}</select></label><label><span>关系</span><select name="branch"><option value="NEXT">下一步</option><option value="YES">判断：是</option><option value="NO">判断：否</option></select></label></> : null}
          {target.kind === "dependency" ? <><label><span>工作项</span><select name="targetId" defaultValue={target.targetId} required>{dependencyOptions.map((item) => <option key={item.id} value={item.id}>{text(item, "name")}</option>)}</select></label><label><span>依赖于</span><select name="dependsOnId" required defaultValue=""><option value="" disabled>选择必须先完成的工作</option>{dependencyOptions.filter(({ id }) => id !== target.targetId).map((item) => <option key={item.id} value={item.id}>{text(item, "name")}</option>)}</select></label></> : null}
          <footer><p role="status">{error ?? "保存后会立即写入正式 View。"}</p><div><button type="button" onClick={onClose} disabled={saving}>取消</button><button type="submit" disabled={saving}>{saving ? "正在保存…" : "保存"}</button></div></footer>
        </form>
      </section>
    </div>
  );
}

type Point = { x: number; y: number; width: number; height: number };

function pathBetween(from: Point, to: Point): string {
  if (to.y >= from.y + from.height - 8) {
    const sx = from.x + from.width / 2;
    const sy = from.y + from.height;
    const tx = to.x + to.width / 2;
    const ty = to.y;
    const middle = sy + (ty - sy) / 2;
    return `M ${sx} ${sy} C ${sx} ${middle}, ${tx} ${middle}, ${tx} ${ty}`;
  }
  const sx = from.x + from.width;
  const sy = from.y + from.height / 2;
  const tx = to.x;
  const ty = to.y + to.height / 2;
  const bend = Math.max(36, Math.abs(tx - sx) * .48);
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
}

function MethodCanvas({ playbook, selectedId, onSelect }: { playbook: PlaybookModel; selectedId?: string; onSelect: (id: string) => void }) {
  const nodeWidth = 250;
  const nodeHeight = 150;
  const laneWidth = 302;
  const positions = new Map<string, Point>();
  const perLane = new Map<string, number>();
  for (const { card } of playbook.nodes) {
    const lane = text(card, "lane") ?? "通用";
    const laneIndex = Math.max(0, playbook.lanes.indexOf(lane));
    const ordinal = perLane.get(lane) ?? 0;
    perLane.set(lane, ordinal + 1);
    const row = numberValue(card, "row") ?? ordinal;
    positions.set(card.id, { x: 30 + laneIndex * laneWidth, y: 72 + row * 194, width: nodeWidth, height: nodeHeight });
  }
  const rows = Math.max(1, ...[...positions.values()].map((point) => Math.round((point.y - 72) / 194) + 1));
  const width = Math.max(700, playbook.lanes.length * laneWidth + 30);
  const height = Math.max(420, rows * 194 + 82);
  const edges = playbook.nodes.flatMap(({ edges }) => edges);
  return (
    <div className={styles.canvasScroll}>
      <div className={styles.methodCanvas} style={{ width, height } as CSSProperties}>
        <div className={styles.lanes} aria-hidden="true">{playbook.lanes.map((lane) => <div key={lane} style={{ width: laneWidth }}><span>{lane}</span></div>)}</div>
        <svg className={styles.edges} width={width} height={height} aria-hidden="true"><defs><marker id="method-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>{edges.map((edge) => { const from = positions.get(edge.from); const to = positions.get(edge.to); return from && to ? <g key={edge.id} data-branch={edge.branch}><path d={pathBetween(from, to)} markerEnd="url(#method-arrow)" />{edge.branch !== "NEXT" ? <text x={(from.x + to.x) / 2 + nodeWidth / 2} y={(from.y + to.y) / 2 + nodeHeight / 2 - 8}>{branchLabels[edge.branch]}</text> : null}</g> : null; })}</svg>
        {playbook.nodes.map((node) => { const point = positions.get(node.card.id)!; const type = text(node.card, "node_type") ?? "ACTION"; return <button id={`activity-card-${node.card.id}`} key={node.card.id} type="button" className={styles.methodNode} data-selected={selectedId === node.card.id} data-type={type} style={{ left: point.x, top: point.y, width: point.width, height: point.height }} onClick={() => onSelect(node.card.id)}><span className={styles.nodeTop}><b>{nodeTypeLabels[type] ?? type}</b>{playbook.startNodeIds.has(node.card.id) ? <i>起点</i> : null}</span><strong>{text(node.card, "name") ?? "未命名步骤"}</strong><small>{text(node.card, "duration_hint") ?? text(node.card, "expected_outcome") ?? "补充完成标志"}</small><span className={styles.nodeFoot}>{node.nestedPlaybook ? <><Icon name="layers" />{text(node.nestedPlaybook, "name")}</> : node.taskDefinitions.length ? `${node.taskDefinitions.length} 个典型任务` : "建议节点"}</span></button>; })}
      </div>
    </div>
  );
}

function TaskCanvas({ workPackages, selectedId, onSelect }: { workPackages: readonly TaskMapPackage[]; selectedId?: string; onSelect: (id: string) => void }) {
  const columnWidth = 292;
  const positions = new Map<string, Point>();
  workPackages.forEach((item, column) => {
    positions.set(item.card.id, { x: 34 + column * columnWidth, y: 74, width: 250, height: 116 });
    item.tasks.forEach(({ card }, row) => positions.set(card.id, { x: 48 + column * columnWidth, y: 252 + row * 128, width: 222, height: 92 }));
  });
  const maxTasks = Math.max(1, ...workPackages.map(({ tasks }) => tasks.length));
  const width = Math.max(760, workPackages.length * columnWidth + 34);
  const height = Math.max(460, 252 + maxTasks * 128 + 42);
  const packageEdges = workPackages.flatMap(({ card, dependencies }) => dependencies.map((dependency) => ({ id: `${card.id}:${dependency.id}`, from: dependency.id, to: card.id, kind: "package" })));
  const taskEdges = workPackages.flatMap(({ tasks }) => tasks.flatMap(({ card, dependencies }) => dependencies.map((dependency) => ({ id: `${card.id}:${dependency.id}`, from: dependency.id, to: card.id, kind: "task" }))));
  return (
    <div className={styles.canvasScroll}>
      <div className={styles.taskCanvas} style={{ width, height } as CSSProperties}>
        <div className={styles.mapColumns} aria-hidden="true">{workPackages.map(({ card }) => <div key={card.id} style={{ width: columnWidth }} />)}</div>
        <svg className={styles.edges} width={width} height={height} aria-hidden="true"><defs><marker id="task-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>{[...packageEdges, ...taskEdges].map((edge) => { const from = positions.get(edge.from); const to = positions.get(edge.to); return from && to ? <path key={edge.id} data-kind={edge.kind} d={pathBetween(from, to)} markerEnd="url(#task-arrow)" /> : null; })}</svg>
        {workPackages.map((item) => { const point = positions.get(item.card.id)!; const done = item.tasks.filter(({ card }) => text(card, "status") === "COMPLETED").length; return <div key={item.card.id}><button id={`activity-card-${item.card.id}`} type="button" className={styles.packageNode} data-selected={selectedId === item.card.id} data-tone={statusTone(item.card)} style={{ left: point.x, top: point.y, width: point.width, height: point.height }} onClick={() => onSelect(item.card.id)}><span><i />{workStatusLabels[text(item.card, "status") ?? "NOT_STARTED"]}</span><strong>{text(item.card, "name") ?? "未命名工作包"}</strong><small>{done}/{item.tasks.length} 任务 · {dateLabel(text(item.card, "deadline"))}</small></button>{item.tasks.map((task) => { const taskPoint = positions.get(task.card.id)!; const names = task.assignments.length ? task.assignments.length : 0; return <button id={`activity-card-${task.card.id}`} key={task.card.id} type="button" className={styles.taskNode} data-selected={selectedId === task.card.id} data-tone={statusTone(task.card)} style={{ left: taskPoint.x, top: taskPoint.y, width: taskPoint.width, height: taskPoint.height }} onClick={() => onSelect(task.card.id)}><span><i />{workStatusLabels[text(task.card, "status") ?? "NOT_STARTED"]}<b>{priorityLabels[text(task.card, "priority") ?? "NORMAL"]}</b></span><strong>{text(task.card, "name") ?? "未命名任务"}</strong><small>{names ? `${names} 位负责人` : "待分配"} · {dateLabel(text(task.card, "deadline"))}</small></button>; })}</div>; })}
      </div>
    </div>
  );
}

function EmptyState({ mode, onCreate, onInvokeAI }: { mode: StudioMode; onCreate: () => void; onInvokeAI: () => void }) {
  return <div className={styles.emptyState}><span><Icon name={mode === "method" ? "book" : "map"} /></span><p>{mode === "method" ? "组织方法" : "任务版图"}</p><h2>{mode === "method" ? "把经验整理成可以复用、展开和套用的流程。" : "先建立一次真实活动，再把所有工作放进同一张依赖图。"}</h2><small>{mode === "method" ? "方法本身不等于本届进度；套用后才会生成正式工作包和任务。" : "版图同时呈现工作包、任务、负责人、期限和前置关系。"}</small><div><button type="button" onClick={onCreate}><Icon name="plus" />直接建立</button><button type="button" onClick={onInvokeAI}><Icon name="spark" />让 Echo 协助</button></div></div>;
}

function CardInspector({ model, mode, selectedId, objectNames, saving, onEdit, onAddTask, onAddDependency, onRemoveDependency, onSetNested, onRemoveEdge, onInvokeAI }: {
  model: ActivityStudioModel; mode: StudioMode; selectedId?: string; objectNames: ReadonlyMap<string, string>; saving: boolean;
  onEdit: (target: EditorTarget) => void; onAddTask: (workPackageId: string) => void; onAddDependency: (type: "WORK_PACKAGE" | "TASK", id: string) => void;
  onRemoveDependency: (type: "WORK_PACKAGE" | "TASK", id: string, dependencyId: string) => void; onSetNested: (nodeId: string, nestedId: string | null) => void;
  onRemoveEdge: (edge: MethodEdge) => void; onInvokeAI: (card: ViewCardState) => void;
}) {
  if (mode === "method") {
    const playbook = model.playbook;
    const node = playbook?.nodes.find(({ card }) => card.id === selectedId);
    if (!playbook) return null;
    if (!node) return <aside className={styles.inspector}><div className={styles.inspectorHero}><span><Icon name="book" /></span><p>{playbookStatusLabels[text(playbook.card, "status") ?? "DRAFT"]}</p><h2>{text(playbook.card, "name")}</h2><small>{text(playbook.card, "description") ?? "补充这份方法解决什么问题。"}</small></div><dl><div><dt>步骤</dt><dd>{playbook.nodes.length}</dd></div><div><dt>泳道</dt><dd>{playbook.lanes.length}</dd></div></dl><section><h3>适用场景</h3><p>{text(playbook.card, "applicable_scenario") ?? "尚未说明"}</p></section><section><h3>组织建议</h3><p>{text(playbook.card, "overview") ?? "尚未说明"}</p></section><button type="button" className={styles.inspectorAction} onClick={() => onEdit({ kind: "playbook", card: playbook.card })}><Icon name="edit" />编辑方法</button></aside>;
    const type = text(node.card, "node_type") ?? "ACTION";
    return <aside className={styles.inspector}><div className={styles.inspectorHero}><span data-type={type}><Icon name={type === "DECISION" ? "branch" : type === "REFERENCE" ? "book" : "check"} /></span><p>{nodeTypeLabels[type]} · {text(node.card, "lane") ?? "通用"}</p><h2>{text(node.card, "name")}</h2><small>{text(node.card, "duration_hint") ?? "未设置时间建议"}</small></div><section><h3>怎么做</h3><p>{text(node.card, "guide") ?? "尚未补充操作建议。"}</p></section><section><h3>完成标志</h3><p>{text(node.card, "expected_outcome") ?? "尚未定义。"}</p></section>{node.taskDefinitions.length ? <section><h3>套用时生成</h3><ul>{node.taskDefinitions.map((task) => <li key={task.id}>{text(task, "name")}</li>)}</ul></section> : null}<section><h3>后续关系</h3><div className={styles.relationList}>{node.edges.map((edge) => <div key={edge.id}><span>{branchLabels[edge.branch]}</span><b>{text(playbook.nodes.find(({ card }) => card.id === edge.to)?.card, "name")}</b><button type="button" disabled={saving} onClick={() => onRemoveEdge(edge)} aria-label="移除关系"><Icon name="close" /></button></div>)}{!node.edges.length ? <p>还没有后续步骤。</p> : null}</div></section><label className={styles.nestedSelect}><span>嵌套方法</span><select value={node.nestedPlaybook?.id ?? ""} disabled={saving} onChange={(event) => onSetNested(node.card.id, event.target.value || null)}><option value="">不嵌套</option>{model.playbooks.filter(({ card }) => card.id !== playbook.card.id).map(({ card }) => <option key={card.id} value={card.id}>{text(card, "name")}</option>)}</select></label><div className={styles.inspectorButtons}><button type="button" onClick={() => onEdit({ kind: "node", playbookId: playbook.card.id, card: node.card })}><Icon name="edit" />编辑</button><button type="button" onClick={() => onInvokeAI(node.card)}><Icon name="spark" />完善建议</button></div></aside>;
  }
  const activity = model.activity;
  if (!activity) return null;
  const selectedPackage = model.workPackages.find(({ card }) => card.id === selectedId);
  const parent = model.workPackages.find(({ tasks }) => tasks.some(({ card }) => card.id === selectedId));
  const selectedTask = parent?.tasks.find(({ card }) => card.id === selectedId);
  const item = selectedPackage ?? selectedTask;
  if (!item) return <aside className={styles.inspector}><div className={styles.inspectorHero}><span><Icon name="map" /></span><p>{activityStatusLabels[text(activity, "status") ?? "PLANNING"]}</p><h2>{text(activity, "name")}</h2><small>{text(activity, "description") ?? "这次活动还没有概况。"}</small></div><dl><div><dt>完成</dt><dd>{model.metrics.completed}/{model.metrics.total}</dd></div><div><dt>受阻</dt><dd>{model.metrics.blocked}</dd></div><div><dt>逾期</dt><dd>{model.metrics.overdue}</dd></div><div><dt>待分配</dt><dd>{model.metrics.unassigned}</dd></div></dl><button type="button" className={styles.inspectorAction} onClick={() => onEdit({ kind: "activity", card: activity })}><Icon name="edit" />编辑活动</button></aside>;
  const card = item.card;
  const isPackage = card.cardTypeKey === "WorkPackageCard";
  const assignments = item.assignments;
  const dependencies = item.dependencies;
  return <aside className={styles.inspector}><div className={styles.inspectorHero}><span data-tone={statusTone(card)}><Icon name={isPackage ? "layers" : "check"} /></span><p>{isPackage ? "工作包" : `任务 · ${text(parent?.card, "name")}`}</p><h2>{text(card, "name")}</h2><small>{workStatusLabels[text(card, "status") ?? "NOT_STARTED"]} · {priorityLabels[text(card, "priority") ?? "NORMAL"]}</small></div><section><h3>说明</h3><p>{text(card, "description") ?? "尚未补充边界和交付。"}</p></section><section><h3>负责人</h3><p>{ownerNames(assignments, objectNames).join("、") || "待分配"}</p></section><section><h3>前置依赖</h3><div className={styles.relationList}>{dependencies.map((dependency) => <div key={dependency.id}><span>依赖</span><b>{text(dependency, "name")}</b><button type="button" disabled={saving} onClick={() => onRemoveDependency(isPackage ? "WORK_PACKAGE" : "TASK", card.id, dependency.id)} aria-label="移除依赖"><Icon name="close" /></button></div>)}{!dependencies.length ? <p>可独立开始。</p> : null}</div><button type="button" className={styles.textAction} onClick={() => onAddDependency(isPackage ? "WORK_PACKAGE" : "TASK", card.id)}><Icon name="link" />添加前置</button></section>{isPackage ? <button type="button" className={styles.textAction} onClick={() => onAddTask(card.id)}><Icon name="plus" />添加任务</button> : null}<div className={styles.inspectorButtons}><button type="button" onClick={() => onEdit(isPackage ? { kind: "workPackage", activityId: activity.id, card } : { kind: "task", activityId: activity.id, workPackageId: parent!.card.id, card })}><Icon name="edit" />编辑</button><button type="button" onClick={() => onInvokeAI(card)}><Icon name="spark" />请 Echo 检查</button></div></aside>;
}

export function ActivityOperationsWorkspace({ viewKey, refreshRevision = 0, focusCardId, onOpenInspector, onInvokeAI }: WorkspaceProps) {
  const [localRevision, setLocalRevision] = useState(0);
  const [mode, setMode] = useState<StudioMode>("method");
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string>();
  const [selectedActivityId, setSelectedActivityId] = useState<string>();
  const [selectedCardId, setSelectedCardId] = useState<string>();
  const [editor, setEditor] = useState<EditorTarget>();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const { snapshot, loading, error, refresh } = useView(viewKey, refreshRevision + localRevision);
  const executeCommand = useViewCommand(viewKey);
  const model = useMemo(() => snapshot ? buildActivityStudio(snapshot, { selectedActivityId, selectedPlaybookId, selectedCardId, focusCardId }) : undefined, [focusCardId, selectedActivityId, selectedCardId, selectedPlaybookId, snapshot]);
  const objectNames = useMemo(() => new Map(snapshot?.objects?.map((object) => [object.id, object.canonicalName]) ?? []), [snapshot]);
  const lastFocusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!focusCardId || !snapshot || lastFocusRef.current === focusCardId) return;
    lastFocusRef.current = focusCardId;
    const focused = snapshot.cards.find(({ id }) => id === focusCardId);
    const nextMode = focused && ["ActivityPlaybookCard", "GuideNodeCard", "WorkPackageDefinitionCard", "TaskDefinitionCard"].includes(focused.cardTypeKey)
      ? "method"
      : "map";
    const frame = window.requestAnimationFrame(() => {
      if (focused) setMode(nextMode);
      setSelectedCardId(focusCardId);
      document.getElementById(`activity-card-${focusCardId}`)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center", inline: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusCardId, snapshot]);

  const run = useCallback(async (key: string, input: unknown, success: string) => {
    if (!snapshot) throw new Error("正式 View 尚未载入");
    const result = await executeCommand<ViewCommandResult>(key, input, snapshot.stateVersion);
    if (result.kind !== "executed") throw new Error("命令未执行");
    setNotice(success);
    setLocalRevision((value) => value + 1);
    return result;
  }, [executeCommand, snapshot]);

  const saveEditor = useCallback(async (values: Record<string, unknown>) => {
    if (!editor) return;
    setSaving(true); setFormError(undefined);
    try {
      if (editor.kind === "playbook") {
        const payload = editor.card ? { playbookId: editor.card.id, name: values.name, description: cleared(String(values.description ?? "")), applicableScenario: cleared(String(values.applicableScenario ?? "")), overview: cleared(String(values.overview ?? "")), notes: cleared(String(values.notes ?? "")), lanes: cleared(String(values.lanes ?? "")), status: values.status } : { ...values, description: optional(String(values.description ?? "")), applicableScenario: optional(String(values.applicableScenario ?? "")), overview: optional(String(values.overview ?? "")), notes: optional(String(values.notes ?? "")), lanes: optional(String(values.lanes ?? "")) };
        const result = await run(editor.card ? "activity.update_playbook" : "activity.create_playbook", payload, editor.card ? "组织方法已更新" : "组织方法已创建");
        if (!editor.card) setSelectedPlaybookId((result.summary as { cardId: string }).cardId);
      } else if (editor.kind === "node") {
        const payload = editor.card ? { playbookId: editor.playbookId, nodeId: editor.card.id, name: values.name, nodeType: values.nodeType, lane: cleared(String(values.lane ?? "")), row: values.row ?? null, guide: cleared(String(values.guide ?? "")), applicableCondition: cleared(String(values.applicableCondition ?? "")), requiredInformation: cleared(String(values.requiredInformation ?? "")), expectedOutcome: cleared(String(values.expectedOutcome ?? "")), aiAssistance: cleared(String(values.aiAssistance ?? "")), durationHint: cleared(String(values.durationHint ?? "")) } : { playbookId: editor.playbookId, ...values, lane: optional(String(values.lane ?? "")), guide: optional(String(values.guide ?? "")), applicableCondition: optional(String(values.applicableCondition ?? "")), requiredInformation: optional(String(values.requiredInformation ?? "")), expectedOutcome: optional(String(values.expectedOutcome ?? "")), aiAssistance: optional(String(values.aiAssistance ?? "")), durationHint: optional(String(values.durationHint ?? "")) };
        const result = await run(editor.card ? "activity.update_guide_node" : "activity.add_guide_node", payload, editor.card ? "流程步骤已更新" : "流程步骤已添加");
        if (!editor.card) setSelectedCardId((result.summary as { cardId: string }).cardId);
      } else if (editor.kind === "activity") {
        const payload = editor.card ? { activityId: editor.card.id, name: values.name, description: cleared(String(values.description ?? "")), status: values.status, time: values.time ?? null } : { ...values, description: optional(String(values.description ?? "")) };
        const result = await run(editor.card ? "activity.update_activity" : "activity.create_activity", payload, editor.card ? "活动已更新" : "活动已创建");
        if (!editor.card) setSelectedActivityId((result.summary as { cardId: string }).cardId);
      } else if (editor.kind === "workPackage") {
        const payload = editor.card ? { activityId: editor.activityId, workPackageId: editor.card.id, name: values.name, description: cleared(String(values.description ?? "")), status: values.status, priority: values.priority, deadline: cleared(String(values.deadline ?? "")), progress: cleared(String(values.progress ?? "")) } : { activityId: editor.activityId, ...values, description: optional(String(values.description ?? "")), deadline: optional(String(values.deadline ?? "")), progress: optional(String(values.progress ?? "")) };
        const result = await run(editor.card ? "activity.update_work_package" : "activity.add_work_package", payload, editor.card ? "工作包已更新" : "工作包已添加");
        if (!editor.card) setSelectedCardId((result.summary as { cardId: string }).cardId);
      } else if (editor.kind === "task") {
        const payload = editor.card ? { workPackageId: editor.workPackageId, taskId: editor.card.id, name: values.name, description: cleared(String(values.description ?? "")), status: values.status, priority: values.priority, deadline: cleared(String(values.deadline ?? "")), progress: cleared(String(values.progress ?? "")) } : { workPackageId: editor.workPackageId, ...values, description: optional(String(values.description ?? "")), deadline: optional(String(values.deadline ?? "")), progress: optional(String(values.progress ?? "")) };
        const result = await run(editor.card ? "activity.update_task" : "activity.add_task", payload, editor.card ? "任务已更新" : "任务已添加");
        if (!editor.card) setSelectedCardId((result.summary as { cardId: string }).cardId);
      } else if (editor.kind === "edge") {
        await run("activity.set_guide_edge", { playbookId: editor.playbookId, ...values, connected: true }, "流程关系已连接");
      } else {
        const key = editor.targetType === "WORK_PACKAGE" ? "activity.set_work_package_dependency" : "activity.set_task_dependency";
        const input = editor.targetType === "WORK_PACKAGE" ? { activityId: editor.activityId, workPackageId: values.targetId, dependsOnWorkPackageId: values.dependsOnId, connected: true } : { activityId: editor.activityId, taskId: values.targetId, dependsOnTaskId: values.dependsOnId, connected: true };
        await run(key, input, "前置依赖已添加");
      }
      setEditor(undefined);
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }, [editor, run]);

  if (loading && !snapshot) return <div className={styles.statePage}><span><Icon name="layers" /></span><p>正在载入活动运营…</p></div>;
  if (!snapshot || !model) return <div className={styles.statePage}><span><Icon name="warning" /></span><h1>活动运营暂时无法打开</h1><p>{error ?? "请稍后重试"}</p><button type="button" onClick={refresh}>重新载入</button></div>;
  const playbook = model.playbook;
  const activity = model.activity;
  const switchMode = (next: StudioMode) => { setMode(next); setSelectedCardId(undefined); };
  const designPlaybook = () => onInvokeAI({
    actionId: "activity.design-playbook",
    message: "帮我从协会已有经验中整理一份活动组织方法，先讨论结构。",
    skill: {
      id: "sydaris.activity-operations.design-playbook",
      input: { operation: "design", phase: "discuss" },
    },
  });
  const planTaskMap = () => onInvokeAI({
    actionId: activity ? "activity.plan-task-map" : "activity.create-task-map",
    message: activity
      ? `帮我检查并完善“${text(activity, "name") ?? "当前活动"}”的任务版图。`
      : "帮我规划第一次真实活动，先确认必要信息和任务结构。",
    skill: {
      id: "sydaris.activity-operations.plan-task-map",
      input: {
        operation: activity ? "review" : "create",
        phase: "discuss",
        ...(activity ? { activityId: activity.id } : {}),
      },
    },
  });
  const askAbout = (card: ViewCardState) => {
    const name = text(card, "name") ?? card.cardTypeKey;
    if (mode === "method") {
      onInvokeAI({
        actionId: "activity.refine-playbook-item",
        message: `帮我完善组织方法中的“${name}”。`,
        skill: {
          id: "sydaris.activity-operations.design-playbook",
          input: {
            operation: "refine",
            phase: "discuss",
            ...(playbook ? { playbookId: playbook.card.id } : {}),
            ...(card.cardTypeKey === "GuideNodeCard" ? { nodeId: card.id } : {}),
          },
        },
      });
      return;
    }
    onInvokeAI({
      actionId: "activity.review-work-item",
      message: `帮我检查活动工作项“${name}”。`,
      skill: {
        id: "sydaris.activity-operations.plan-task-map",
        input: {
          operation: "review",
          phase: "discuss",
          ...(activity ? { activityId: activity.id } : {}),
          workItemId: card.id,
        },
      },
    });
  };
  const removeDependency = async (type: "WORK_PACKAGE" | "TASK", id: string, dependencyId: string) => {
    if (!activity) return; setSaving(true);
    try { await run(type === "WORK_PACKAGE" ? "activity.set_work_package_dependency" : "activity.set_task_dependency", type === "WORK_PACKAGE" ? { activityId: activity.id, workPackageId: id, dependsOnWorkPackageId: dependencyId, connected: false } : { activityId: activity.id, taskId: id, dependsOnTaskId: dependencyId, connected: false }, "前置依赖已移除"); }
    catch (cause) { setNotice(`未能移除：${cause instanceof Error ? cause.message : String(cause)}`); } finally { setSaving(false); }
  };
  return <div className={styles.workspace}>
    <header className={styles.topbar}><div className={styles.brand}><span><Icon name="layers" /></span><div><b>Activity View</b><small>方法与执行</small></div></div><nav className={styles.modeSwitch} aria-label="活动运营模式"><button type="button" data-active={mode === "method"} onClick={() => switchMode("method")}><Icon name="book" />组织方法</button><button type="button" data-active={mode === "map"} onClick={() => switchMode("map")}><Icon name="map" />任务版图</button></nav><div className={styles.topActions}>{notice ? <span role="status" data-error={notice.startsWith("未能")}><Icon name={notice.startsWith("未能") ? "warning" : "check"} />{notice}</span> : null}<button type="button" onClick={() => refresh()} aria-label="刷新"><Icon name="refresh" /></button><button type="button" onClick={onOpenInspector}>高级</button></div></header>
    <div className={styles.studio}>
      <aside className={styles.library}><header><p>{mode === "method" ? "方法库" : "活动"}</p><button type="button" onClick={() => setEditor(mode === "method" ? { kind: "playbook" } : { kind: "activity" })} aria-label={mode === "method" ? "新建方法" : "新建活动"}><Icon name="plus" /></button></header><div>{mode === "method" ? model.playbooks.map((item) => <button type="button" key={item.card.id} data-active={item.card.id === playbook?.card.id} onClick={() => { setSelectedPlaybookId(item.card.id); setSelectedCardId(undefined); }}><span data-tone={statusTone(item.card)}><Icon name="book" /></span><span><b>{text(item.card, "name") ?? "未命名方法"}</b><small>{item.nodes.length} 步 · {playbookStatusLabels[text(item.card, "status") ?? "DRAFT"]}</small></span></button>) : model.activities.map((item) => <button type="button" key={item.id} data-active={item.id === activity?.id} onClick={() => { setSelectedActivityId(item.id); setSelectedCardId(undefined); }}><span data-tone={statusTone(item)}><Icon name="map" /></span><span><b>{text(item, "name") ?? "未命名活动"}</b><small>{activityStatusLabels[text(item, "status") ?? "PLANNING"]}</small></span></button>)}</div><footer><button type="button" onClick={mode === "method" ? designPlaybook : planTaskMap}><Icon name="spark" />让 Echo 协助设计</button></footer></aside>
      <section className={styles.mainStage} aria-label={mode === "method" ? "组织方法画布" : "任务版图画布"}>{mode === "method" ? playbook ? <><section className={styles.stageHeader}><div><p>{playbookStatusLabels[text(playbook.card, "status") ?? "DRAFT"]} · {playbook.nodes.length} 个步骤</p><h1>{text(playbook.card, "name")}</h1><span>{text(playbook.card, "applicable_scenario") ?? "尚未说明适用场景"}</span></div><div><button type="button" onClick={() => setEditor({ kind: "edge", playbookId: playbook.card.id, fromNodeId: selectedCardId })}><Icon name="link" />连接步骤</button><button type="button" onClick={() => setEditor({ kind: "node", playbookId: playbook.card.id })}><Icon name="plus" />添加步骤</button><button type="button" className={styles.primary} disabled={!activity || saving} onClick={async () => { if (!activity) return; setSaving(true); try { await run("activity.apply_playbook", { activityId: activity.id, playbookId: playbook.card.id }, `已套用到“${text(activity, "name")}”`); setMode("map"); setSelectedCardId(undefined); } catch (cause) { setNotice(`未能套用：${cause instanceof Error ? cause.message : String(cause)}`); } finally { setSaving(false); } }}><Icon name="arrow" />套用到{activity ? `“${text(activity, "name")}”` : "活动"}</button></div></section><MethodCanvas playbook={playbook} selectedId={selectedCardId} onSelect={setSelectedCardId} /></> : <EmptyState mode="method" onCreate={() => setEditor({ kind: "playbook" })} onInvokeAI={designPlaybook} /> : activity ? <><section className={styles.stageHeader}><div><p>{activityStatusLabels[text(activity, "status") ?? "PLANNING"]} · {model.workPackages.length} 个工作包</p><h1>{text(activity, "name")}</h1><span>{model.metrics.total ? `${model.metrics.completed}/${model.metrics.total} 已完成 · ${model.metrics.blocked} 受阻 · ${model.metrics.overdue} 逾期` : "从组织方法套用，或直接建立工作包"}</span></div><div><button type="button" onClick={() => setEditor({ kind: "dependency", activityId: activity.id, targetType: "WORK_PACKAGE", targetId: selectedCardId })}><Icon name="link" />工作包依赖</button><button type="button" className={styles.primary} onClick={() => setEditor({ kind: "workPackage", activityId: activity.id })}><Icon name="plus" />添加工作包</button></div></section>{model.workPackages.length ? <TaskCanvas workPackages={model.workPackages} selectedId={selectedCardId} onSelect={setSelectedCardId} /> : <div className={styles.mapEmpty}><Icon name="map" /><h2>版图还是空的</h2><p>从组织方法套用会自动生成工作包、任务和前置关系；也可以手动开始。</p><div><button type="button" onClick={() => switchMode("method")}><Icon name="book" />选择组织方法</button><button type="button" onClick={() => setEditor({ kind: "workPackage", activityId: activity.id })}><Icon name="plus" />手动添加</button></div></div>}</> : <EmptyState mode="map" onCreate={() => setEditor({ kind: "activity" })} onInvokeAI={planTaskMap} />}</section>
      <CardInspector model={model} mode={mode} selectedId={selectedCardId} objectNames={objectNames} saving={saving} onEdit={setEditor} onAddTask={(workPackageId) => activity && setEditor({ kind: "task", activityId: activity.id, workPackageId })} onAddDependency={(targetType, targetId) => activity && setEditor({ kind: "dependency", activityId: activity.id, targetType, targetId })} onRemoveDependency={removeDependency} onSetNested={async (nodeId, nestedId) => { if (!playbook) return; setSaving(true); try { await run("activity.set_nested_playbook", { playbookId: playbook.card.id, nodeId, nestedPlaybookId: nestedId }, nestedId ? "嵌套方法已设置" : "嵌套方法已移除"); } catch (cause) { setNotice(`未能设置：${cause instanceof Error ? cause.message : String(cause)}`); } finally { setSaving(false); } }} onRemoveEdge={async (edge) => { if (!playbook) return; setSaving(true); try { await run("activity.set_guide_edge", { playbookId: playbook.card.id, fromNodeId: edge.from, toNodeId: edge.to, branch: edge.branch, connected: false }, "流程关系已移除"); } catch (cause) { setNotice(`未能移除：${cause instanceof Error ? cause.message : String(cause)}`); } finally { setSaving(false); } }} onInvokeAI={askAbout} />
    </div>
    {editor ? <FormSheet key={`${editor.kind}:${"card" in editor ? editor.card?.id ?? "new" : "new"}`} target={editor} model={model} saving={saving} error={formError} onClose={() => { if (!saving) { setEditor(undefined); setFormError(undefined); } }} onSave={saveEditor} /> : null}
  </div>;
}
