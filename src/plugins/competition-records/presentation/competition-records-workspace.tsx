"use client";

import { useEffect, useMemo, useState } from "react";

import type { EchoPresentationProps } from "@sydaris/plugin-sdk";
import type { ViewInspectorSnapshot } from "@/view-runtime/application/view-read-port";

type SyncSummary = {
  source: { sourceSystem: string; retrievedAt: string; recordCount: number };
  mapping: { version: string; editionCount: number };
  write: { kind: string; summary?: unknown };
};

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "—";
}

export function CompetitionRecordsWorkspace({
  refreshRevision = 0,
  focusCardId,
  onOpenInspector,
  onAskAI,
}: EchoPresentationProps) {
  const [reload, setReload] = useState(0);
  const [snapshot, setSnapshot] = useState<ViewInspectorSnapshot>();
  const [error, setError] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/views/competition_records", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as ViewInspectorSnapshot & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "无法读取赛事数据");
      setSnapshot(body);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [refreshRevision, reload]);

  const sync = async () => {
    setSyncing(true);
    setError(undefined);
    try {
      const response = await fetch("/api/views/competition_records/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ includeQuickMatches: false, limit: 200 }),
      });
      const body = await response.json() as SyncSummary & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "同步失败");
      setSyncSummary(body);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncing(false);
    }
  };

  const editions = useMemo(() => snapshot?.cards.filter(
    (card) => card.cardTypeKey === "CompetitionEditionCard",
  ) ?? [], [snapshot]);
  const series = useMemo(() => snapshot?.cards.filter(
    (card) => card.cardTypeKey === "CompetitionSeriesCard",
  ) ?? [], [snapshot]);

  return (
    <div className="min-h-full bg-[#f6f7f5] text-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-5 py-5 lg:px-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">赛事数据</p>
            <h1 className="mt-1.5 text-2xl font-semibold tracking-[-0.02em]">赛事档案</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">
              USTCTTA-site 原始数据通过内部 Tool 确定性同步；赛事系列由 Skill 结合知识库整理。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onOpenInspector} className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100">
              高级
            </button>
            <button type="button" onClick={() => setReload((value) => value + 1)} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50">
              刷新显示
            </button>
            <button
              type="button"
              disabled={syncing}
              onClick={() => void sync()}
              className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60"
            >
              {syncing ? "正在同步…" : "同步 USTCTTA 数据"}
            </button>
            <button
              type="button"
              onClick={() => onAskAI("请使用整理赛事系列 Skill，从已有比赛届次和知识库资料整理赛事系列。")}
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
            >
              整理赛事系列
            </button>
          </div>
        </div>
        {error ? <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        {syncSummary ? (
          <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            已读取 {syncSummary.source.recordCount} 条源记录，产生 {syncSummary.mapping.editionCount} 条 Edition 投影。
          </p>
        ) : null}
      </header>

      <main className="space-y-7 p-5 lg:p-7">
        <section>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">比赛届次</h2>
              <p className="mt-1 text-xs text-zinc-500">来源数据的比赛日期、参与人数与幂等标识。</p>
            </div>
            <span className="text-xs text-zinc-400">{editions.length} 项</span>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {editions.map((edition) => (
              <article key={edition.id} className={`rounded-xl border bg-white p-4 shadow-sm ${focusCardId === edition.id ? "border-emerald-500 ring-2 ring-emerald-100" : "border-zinc-200"}`}>
                <h3 className="font-medium text-zinc-900">{text(edition.dimensions.name)}</h3>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-xs text-zinc-400">比赛日期</dt><dd className="mt-1">{text(edition.dimensions.held_on)}</dd></div>
                  <div><dt className="text-xs text-zinc-400">参与人数</dt><dd className="mt-1">{text(edition.dimensions.participant_count)} 人</dd></div>
                  <div><dt className="text-xs text-zinc-400">届次序号</dt><dd className="mt-1">{text(edition.dimensions.sequence_number)}</dd></div>
                  <div><dt className="text-xs text-zinc-400">来源</dt><dd className="mt-1 break-all">{text(edition.dimensions.source_system)} / {text(edition.dimensions.source_id)}</dd></div>
                </dl>
              </article>
            ))}
          </div>
          {!snapshot ? <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-400">正在读取…</p> : null}
          {snapshot && editions.length === 0 ? <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-400">尚未同步比赛届次。</p> : null}
        </section>

        <section>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div><h2 className="text-base font-semibold">赛事系列</h2><p className="mt-1 text-xs text-zinc-500">由 Skill 根据多届比赛与知识库资料整理。</p></div>
            <span className="text-xs text-zinc-400">{series.length} 项</span>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {series.map((item) => (
              <article key={item.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
                <h3 className="font-medium">{text(item.dimensions.name)}</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-600">{text(item.dimensions.description)}</p>
                <p className="mt-3 text-xs text-zinc-400">举办节奏：{ text(item.dimensions.cadence) }</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
