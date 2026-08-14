"use client";

import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";

import {
  ACTIVITY_STATUSES,
  ACTIVITY_STATUS_LABELS,
  WORK_PACKAGE_STATUSES,
  WORK_PACKAGE_STATUS_LABELS,
} from "@/semantic-view/activity-operations-contract";
import type {
  ActivityEditorValues,
  ActivityPortfolio,
  ActivityPortfolioAction,
  ActivityPortfolioActivity,
  ActivityPortfolioWorkPackage,
  WorkPackageEditorValues,
} from "@/semantic-view/activity-portfolio";

const VIEW_CHANGED_EVENT = "echo:semantic-view-changed";

type Editor =
  | { kind: "activity"; activity?: ActivityPortfolioActivity }
  | {
      kind: "workPackage";
      activityCardId: string;
      workPackage?: ActivityPortfolioWorkPackage;
    };

function statusTone(status: string): string {
  if (status === "COMPLETED") return "bg-emerald-100 text-emerald-800";
  if (status === "RUNNING" || status === "IN_PROGRESS") {
    return "bg-sky-100 text-sky-800";
  }
  if (status === "WRAP_UP") return "bg-violet-100 text-violet-800";
  if (status === "CANCELLED") return "bg-zinc-200 text-zinc-600";
  return "bg-amber-100 text-amber-800";
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(status)}`}>
      {label}
    </span>
  );
}

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

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100";

function OwnerField({
  people,
  value,
  onChange,
}: {
  people: ActivityPortfolio["people"];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label="负责人">
      <select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">未指定</option>
        {people.map((person) => (
          <option key={person.cardId} value={person.cardId}>{person.name}</option>
        ))}
      </select>
      {!people.length ? (
        <span className="mt-1.5 block text-xs text-amber-700">暂无人物 Card，请先在社团信息中建立人物。</span>
      ) : null}
    </Field>
  );
}

function ActivityEditor({
  activity,
  people,
  busy,
  onSave,
}: {
  activity?: ActivityPortfolioActivity;
  people: ActivityPortfolio["people"];
  busy: boolean;
  onSave: (values: ActivityEditorValues, ownerPersonCardId: string | null) => Promise<void>;
}) {
  const [values, setValues] = useState<ActivityEditorValues>(() => activity
    ? {
        name: activity.name,
        description: activity.description,
        status: activity.status,
        progress: activity.progress,
        time: activity.time,
        format: activity.format,
        scale: activity.scale,
        participantCount: activity.participantCount,
      }
    : { name: "", status: "PLANNING", participantCount: null });
  const [ownerPersonCardId, setOwnerPersonCardId] = useState(activity?.owner?.cardId ?? "");
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      setError(undefined);
      await onSave(values, ownerPersonCardId || null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称" wide>
          <input required maxLength={200} className={inputClass} value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} />
        </Field>
        <Field label="简介" wide>
          <textarea rows={3} className={inputClass} value={values.description ?? ""} onChange={(event) => setValues({ ...values, description: event.target.value })} />
        </Field>
        <Field label="活动时间">
          <input className={inputClass} placeholder="例如 10/24 或 2026-10-24" value={values.time ?? ""} onChange={(event) => setValues({ ...values, time: event.target.value })} />
        </Field>
        <Field label="状态">
          <select className={inputClass} value={values.status} onChange={(event) => setValues({ ...values, status: event.target.value as ActivityEditorValues["status"] })}>
            {ACTIVITY_STATUSES.map((status) => <option key={status} value={status}>{ACTIVITY_STATUS_LABELS[status]}</option>)}
          </select>
        </Field>
        <Field label="活动形式">
          <input className={inputClass} placeholder="例如 单打比赛" value={values.format ?? ""} onChange={(event) => setValues({ ...values, format: event.target.value })} />
        </Field>
        <Field label="活动规模">
          <input className={inputClass} placeholder="例如 大型" value={values.scale ?? ""} onChange={(event) => setValues({ ...values, scale: event.target.value })} />
        </Field>
        <Field label="确定参与人数">
          <input type="number" min={0} className={inputClass} value={values.participantCount ?? ""} onChange={(event) => setValues({ ...values, participantCount: event.target.value === "" ? null : Number(event.target.value) })} />
        </Field>
        <OwnerField people={people} value={ownerPersonCardId} onChange={setOwnerPersonCardId} />
        <Field label="自然语言进度" wide>
          <textarea rows={5} className={inputClass} placeholder="说明现在具体进行到哪里、发生了什么、下一步是什么。" value={values.progress ?? ""} onChange={(event) => setValues({ ...values, progress: event.target.value })} />
        </Field>
      </div>
      {activity?.workPackages.length ? (
        <div className="rounded-lg bg-zinc-50 p-3 text-sm text-zinc-600">
          <p className="font-medium text-zinc-800">Work Package 概览</p>
          <p className="mt-1">{activity.completedWorkPackageCount} / {activity.workPackages.length} 已完成</p>
        </div>
      ) : null}
      {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <button disabled={busy} className="w-full rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">
        {busy ? "正在保存…" : activity ? "保存 Activity" : "创建 Activity"}
      </button>
    </form>
  );
}

function WorkPackageEditor({
  workPackage,
  people,
  busy,
  onSave,
  onCancel,
  onDelete,
}: {
  workPackage?: ActivityPortfolioWorkPackage;
  people: ActivityPortfolio["people"];
  busy: boolean;
  onSave: (values: WorkPackageEditorValues, ownerPersonCardId: string | null) => Promise<void>;
  onCancel: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [values, setValues] = useState<WorkPackageEditorValues>(() => workPackage
    ? {
        name: workPackage.name,
        description: workPackage.description,
        status: workPackage.status,
        progress: workPackage.progress,
        deadline: workPackage.deadline,
      }
    : { name: "", status: "NOT_STARTED" });
  const [ownerPersonCardId, setOwnerPersonCardId] = useState(workPackage?.owner?.cardId ?? "");
  const [error, setError] = useState<string>();

  async function run(action: () => Promise<void>) {
    try {
      setError(undefined);
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      void run(() => onSave(values, ownerPersonCardId || null));
    }} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称" wide>
          <input required maxLength={200} className={inputClass} value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} />
        </Field>
        <Field label="简介 / 当前工作说明" wide>
          <textarea rows={3} className={inputClass} value={values.description ?? ""} onChange={(event) => setValues({ ...values, description: event.target.value })} />
        </Field>
        <Field label="状态">
          <select className={inputClass} value={values.status} onChange={(event) => setValues({ ...values, status: event.target.value as WorkPackageEditorValues["status"] })}>
            {WORK_PACKAGE_STATUSES.map((status) => <option key={status} value={status}>{WORK_PACKAGE_STATUS_LABELS[status]}</option>)}
          </select>
        </Field>
        <Field label="截止时间">
          <input className={inputClass} placeholder="简单日期或时间描述" value={values.deadline ?? ""} onChange={(event) => setValues({ ...values, deadline: event.target.value })} />
        </Field>
        <OwnerField people={people} value={ownerPersonCardId} onChange={setOwnerPersonCardId} />
        <div />
        <Field label="自然语言进度" wide>
          <textarea rows={5} className={inputClass} placeholder="说明当前工作进展，不以结构化状态代替业务语境。" value={values.progress ?? ""} onChange={(event) => setValues({ ...values, progress: event.target.value })} />
        </Field>
      </div>
      {workPackage ? (
        <p className="text-xs text-zinc-500">当前仅统计 Task：{workPackage.completedTaskCount} / {workPackage.taskCount} 已完成；本视图不展开 Task。</p>
      ) : null}
      {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button disabled={busy} className="flex-1 rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "正在保存…" : workPackage ? "保存 Work Package" : "创建 Work Package"}
        </button>
        {workPackage && workPackage.status !== "CANCELLED" ? (
          <button type="button" disabled={busy} onClick={() => void run(onCancel)} className="rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-700 disabled:opacity-50">取消工作包</button>
        ) : null}
        {workPackage ? (
          <button type="button" disabled={busy} onClick={() => {
            if (window.confirm(`确认删除“${workPackage.name}”？已有 Task 时系统会拒绝删除。`)) void run(onDelete);
          }} className="rounded-lg border border-red-200 bg-white px-4 py-2.5 text-sm text-red-700 disabled:opacity-50">删除</button>
        ) : null}
      </div>
    </form>
  );
}

export function ActivityPortfolioOverview() {
  const [portfolio, setPortfolio] = useState<ActivityPortfolio>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editor, setEditor] = useState<Editor>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/activity-operations/portfolio", { cache: "no-store" });
      const body = await response.json() as ActivityPortfolio & { error?: string };
      if (!response.ok) throw new Error(body.error || "无法读取活动总览");
      setPortfolio(body);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const refresh = () => void load();
    window.addEventListener(VIEW_CHANGED_EVENT, refresh);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener(VIEW_CHANGED_EVENT, refresh);
    };
  }, [load]);

  async function mutate(action: ActivityPortfolioAction) {
    setBusy(true);
    try {
      const response = await fetch("/api/activity-operations/portfolio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      const body = await response.json() as ActivityPortfolio & { error?: string };
      if (!response.ok) throw new Error(body.error || "保存失败");
      setPortfolio(body);
      setEditor(undefined);
      setError(undefined);
      window.dispatchEvent(new CustomEvent(VIEW_CHANGED_EVENT, {
        detail: { viewKey: "activity_operations" },
      }));
    } finally {
      setBusy(false);
    }
  }

  function toggle(cardId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }

  if (!portfolio && !error) return <p className="text-sm text-zinc-500">正在读取活动总览…</p>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-950">Activity Portfolio</h2>
          <p className="mt-1 text-sm text-zinc-500">活动与主要 Work Package 的当前业务状态。</p>
        </div>
        <button type="button" onClick={() => setEditor({ kind: "activity" })} className="rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-900">＋ 新建 Activity</button>
      </div>
      {error ? <p className="mb-4 rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p> : null}
      {portfolio && !portfolio.activities.length ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-14 text-center">
          <p className="font-medium text-zinc-800">还没有 Activity</p>
          <p className="mt-2 text-sm text-zinc-500">新建后会直接写入正式 SemanticCard 状态。</p>
        </div>
      ) : null}
      {portfolio?.activities.length ? (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
          <table className="w-full min-w-[980px] border-collapse text-left">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs font-medium text-zinc-500">
              <tr>
                <th className="w-[23%] px-4 py-3">活动</th>
                <th className="w-[11%] px-3 py-3">时间</th>
                <th className="w-[12%] px-3 py-3">负责人</th>
                <th className="w-[12%] px-3 py-3">状态</th>
                <th className="w-[34%] px-3 py-3">进度</th>
                <th className="w-[8%] px-3 py-3 text-center">工作</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.activities.map((activity) => (
                <Fragment key={activity.cardId}>
                  <tr className="border-b border-zinc-100 align-top hover:bg-emerald-50/35">
                    <td className="px-4 py-4">
                      <div className="flex items-start gap-2">
                        <button type="button" aria-label={expanded.has(activity.cardId) ? "收起 Work Packages" : "展开 Work Packages"} onClick={() => toggle(activity.cardId)} className="mt-0.5 size-6 shrink-0 rounded text-zinc-500 hover:bg-zinc-100">
                          {expanded.has(activity.cardId) ? "▾" : "▸"}
                        </button>
                        <button type="button" onClick={() => setEditor({ kind: "activity", activity })} className="text-left font-medium leading-6 text-zinc-900 hover:text-emerald-800">{activity.name}</button>
                      </div>
                    </td>
                    <td className="px-3 py-4 text-sm text-zinc-600">{activity.time || "—"}</td>
                    <td className="px-3 py-4 text-sm text-zinc-700">{activity.owner?.name || "—"}</td>
                    <td className="px-3 py-4"><StatusBadge status={activity.status} label={ACTIVITY_STATUS_LABELS[activity.status]} /></td>
                    <td className="px-3 py-4 text-sm leading-6 text-zinc-700">{activity.progress || <span className="text-zinc-400">暂无进度说明</span>}</td>
                    <td className="px-3 py-4 text-center text-sm font-medium tabular-nums text-zinc-700">{activity.completedWorkPackageCount} / {activity.workPackages.length}</td>
                  </tr>
                  {expanded.has(activity.cardId) ? (
                    <tr className="border-b border-zinc-200 bg-[#f7faf8]">
                      <td colSpan={6} className="px-8 py-4">
                        <div className="mb-3 flex items-center justify-between">
                          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Work Packages</p>
                          <button type="button" onClick={() => setEditor({ kind: "workPackage", activityCardId: activity.cardId })} className="rounded-md border border-emerald-200 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-50">＋ 新增工作包</button>
                        </div>
                        {activity.workPackages.length ? (
                          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
                            <div className="grid grid-cols-[1.25fr_.65fr_.65fr_2fr_.75fr] gap-3 border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-xs text-zinc-500">
                              <span>工作名称</span><span>负责人</span><span>状态</span><span>进度</span><span>截止时间</span>
                            </div>
                            {activity.workPackages.map((workPackage) => (
                              <button key={workPackage.cardId} type="button" onClick={() => setEditor({ kind: "workPackage", activityCardId: activity.cardId, workPackage })} className="grid w-full grid-cols-[1.25fr_.65fr_.65fr_2fr_.75fr] gap-3 border-b border-zinc-100 px-4 py-3 text-left text-sm last:border-b-0 hover:bg-emerald-50/50">
                                <span className="font-medium text-zinc-800">{workPackage.name}</span>
                                <span className="text-zinc-600">{workPackage.owner?.name || "—"}</span>
                                <span><StatusBadge status={workPackage.status} label={WORK_PACKAGE_STATUS_LABELS[workPackage.status]} /></span>
                                <span className="leading-5 text-zinc-600">{workPackage.progress || "—"}</span>
                                <span className="text-zinc-500">{workPackage.deadline || "—"}</span>
                              </button>
                            ))}
                          </div>
                        ) : <p className="rounded-lg border border-dashed border-zinc-300 bg-white px-4 py-6 text-center text-sm text-zinc-500">暂无 Work Package</p>}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {editor && portfolio ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-zinc-950/20" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setEditor(undefined);
        }}>
          <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-zinc-200 bg-white p-6 shadow-2xl">
            <header className="mb-6 flex items-start justify-between gap-4 border-b border-zinc-200 pb-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">{editor.kind === "activity" ? "Activity" : "Work Package"}</p>
                <h3 className="mt-1 text-xl font-semibold text-zinc-950">{editor.kind === "activity" ? editor.activity ? "编辑 Activity" : "新建 Activity" : editor.workPackage ? "编辑 Work Package" : "新增 Work Package"}</h3>
              </div>
              <button type="button" onClick={() => setEditor(undefined)} aria-label="关闭编辑器" className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-zinc-600">×</button>
            </header>
            {editor.kind === "activity" ? (
              <ActivityEditor
                activity={editor.activity}
                people={portfolio.people}
                busy={busy}
                onSave={async (values, ownerPersonCardId) => mutate(editor.activity
                  ? { type: "UPDATE_ACTIVITY", cardId: editor.activity.cardId, values, ownerPersonCardId }
                  : { type: "CREATE_ACTIVITY", values, ownerPersonCardId })}
              />
            ) : (
              <WorkPackageEditor
                workPackage={editor.workPackage}
                people={portfolio.people}
                busy={busy}
                onSave={async (values, ownerPersonCardId) => mutate(editor.workPackage
                  ? { type: "UPDATE_WORK_PACKAGE", cardId: editor.workPackage.cardId, values, ownerPersonCardId }
                  : { type: "CREATE_WORK_PACKAGE", activityCardId: editor.activityCardId, values, ownerPersonCardId })}
                onCancel={async () => {
                  if (editor.workPackage) await mutate({ type: "CANCEL_WORK_PACKAGE", cardId: editor.workPackage.cardId });
                }}
                onDelete={async () => {
                  if (editor.workPackage) await mutate({ type: "DELETE_WORK_PACKAGE", activityCardId: editor.activityCardId, cardId: editor.workPackage.cardId });
                }}
              />
            )}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
