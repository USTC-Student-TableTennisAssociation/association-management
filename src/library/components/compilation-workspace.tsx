"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AIInvocation } from "@sydaris/plugin-sdk";

import type {
  LibraryCompilationCandidate,
  LibraryCompilationJobStatus,
  LibraryCompilationOverview,
  LibraryCompilationRunView,
  LibraryCompilationSelection,
} from "@/library/compilation-types";
import type { LibraryProcessingProfile } from "@/library/types";

const JOB_STATUS_LABELS: Record<LibraryCompilationJobStatus, string> = {
  queued: "已排队",
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "任务失败",
};

const PROFILE_LABELS = {
  deep: "深度冷启动",
  coarse: "粗编译",
  catalog: "仅归档语义编目",
} as const;

const STAGE_LABELS: Record<LibraryCompilationRunView["stage"], string> = {
  queued: "等待中",
  preparing: "准备内容",
  parsing: "解析 / OCR",
  analyzing: "AI 语义分析",
  resolving: "Object 解析",
  staging: "保存草稿产物",
  ready: "已完成",
  failed: "失败",
};

const ACTIVE_JOB_STATUSES: LibraryCompilationJobStatus[] = ["queued", "running", "paused"];

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1_024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1_024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1_024; index += 1) {
    size /= 1_024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function ProgressBar({ value, total, tone = "emerald" }: {
  value: number;
  total: number;
  tone?: "emerald" | "amber" | "sky";
}) {
  const percent = total ? Math.min(100, Math.round(value / total * 100)) : 100;
  const color = tone === "amber" ? "bg-amber-500" : tone === "sky" ? "bg-sky-500" : "bg-emerald-600";
  return (
    <div className="h-2 overflow-hidden rounded-full bg-zinc-100" aria-label={`${percent}%`}>
      <div className={`h-full rounded-full transition-[width] duration-500 ${color}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

function ActiveRunCard({ run }: { run: LibraryCompilationRunView }) {
  return (
    <div className="min-w-0 rounded-lg border border-emerald-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-900" title={run.nodeName}>{run.nodeName}</p>
          <p className="mt-1 text-xs text-zinc-500">{PROFILE_LABELS[run.profile]} · {STAGE_LABELS[run.stage]}</p>
        </div>
        <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800">{run.progressCurrent}/{run.progressTotal}</span>
      </div>
      <p className="mt-2 line-clamp-2 min-h-8 text-xs leading-4 text-zinc-500">{run.statusMessage ?? "正在处理"}</p>
      {run.errorMessage ? <p className="mt-2 line-clamp-2 text-xs text-amber-800">上次错误：{run.errorMessage}</p> : null}
      {run.modelRetries.text || run.modelRetries.vision ? <p className="mt-2 text-xs font-medium text-sky-700">模型输出纠正重试 · 文字 {run.modelRetries.text} · 视觉 {run.modelRetries.vision}</p> : null}
      {run.retryCount ? <p className="mt-2 text-xs font-medium text-amber-700">已从 checkpoint 续跑 {run.retryCount} 次</p> : null}
      <div className="mt-3"><ProgressBar value={run.progressCurrent} total={run.progressTotal} /></div>
    </div>
  );
}

function RunRow({ run, publicationPending = false }: {
  run: LibraryCompilationRunView;
  publicationPending?: boolean;
}) {
  return (
    <div className="grid gap-2 border-b border-zinc-100 px-4 py-3 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_8rem_8rem]">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-800" title={run.nodeName}>{run.nodeName}</p>
        <p className="mt-0.5 truncate text-xs text-zinc-400" title={run.originalRelativePath}>{run.originalRelativePath ?? run.mimeType}</p>
        {run.assessment ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-600">{run.assessment.summary}</p> : null}
        {run.errorMessage ? <p className="mt-1 text-xs text-red-700">{run.errorMessage}</p> : null}
        {run.status === "ready" ? (
          run.publishedAt
            ? <p className="mt-1 text-xs text-emerald-700">Shared Brain · Assertion {run.publishedAssertionCount} · Object {run.publishedObjectCount}</p>
            : <p className="mt-1 text-xs text-amber-700">
                {publicationPending
                  ? "文件草稿已完成，等待本次任务归并并发布"
                  : "本次草稿尚未发布到 Shared Brain"}
              </p>
        ) : null}
      </div>
      <div className="text-xs text-zinc-600">
        <p>{PROFILE_LABELS[run.profile]}</p>
        <p className="mt-1 text-zinc-400">{STAGE_LABELS[run.stage]}</p>
        {run.modelRetries.text || run.modelRetries.vision ? <p className="mt-1 text-sky-700">模型纠正 {run.modelRetries.text + run.modelRetries.vision} 次</p> : null}
        {run.retryCount ? <p className="mt-1 text-amber-700">自动续跑 {run.retryCount} 次</p> : null}
      </div>
      <div className="text-xs text-zinc-600">
        {run.assessment ? (
          <p className="text-zinc-400">
            Ref {run.assessment.referenceCandidateCount} · Assertion {run.assessment.assertionCandidateCount} · Object {run.assessment.objectCandidateCount}
          </p>
        ) : <p>{run.status === "failed" ? "失败" : "已处理"}</p>}
      </div>
    </div>
  );
}

async function readOverview(
  jobId?: string,
  includeCandidates = true,
): Promise<LibraryCompilationOverview> {
  const parameters = new URLSearchParams();
  if (jobId) parameters.set("jobId", jobId);
  if (!includeCandidates) parameters.set("includeCandidates", "false");
  const response = await fetch(`/api/library/compilation${parameters.size ? `?${parameters}` : ""}`, { cache: "no-store" });
  const body = await response.json() as LibraryCompilationOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || "无法读取基础编译状态");
  return body;
}

export function CompilationWorkspace({
  onOpenLibrary,
  onInvokeAI,
}: {
  onOpenLibrary: () => void;
  onInvokeAI: (invocation: AIInvocation) => void;
}) {
  const [overview, setOverview] = useState<LibraryCompilationOverview>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState("");
  const [profileFilter, setProfileFilter] = useState<"all" | LibraryProcessingProfile>("all");
  const [selections, setSelections] = useState<Record<string, LibraryProcessingProfile>>({});
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  const currentJobId = overview?.job?.id;
  const canCreateJob = !overview?.job || !ACTIVE_JOB_STATUSES.includes(overview.job.status);

  const load = useCallback(async () => {
    try {
      const next = await readOverview(currentJobId, canCreateJob);
      if (!selectionInitialized && next.candidates?.length) {
        setSelections(Object.fromEntries(
          next.candidates
            .filter((candidate) => candidate.profile !== "catalog")
            .map((candidate) => [candidate.sourceBlobId, candidate.profile]),
        ));
        setSelectionInitialized(true);
      }
      setOverview((previous) => ({
        ...next,
        ...(!next.candidates && previous?.candidates
          ? { candidates: previous.candidates }
          : {}),
      }));
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取基础编译状态");
    } finally {
      setLoading(false);
    }
  }, [canCreateJob, currentJobId, selectionInitialized]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const shouldPoll = overview?.job && ["queued", "running"].includes(overview.job.status);
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [load, shouldPoll]);

  const handledFiles = (overview?.job?.completedContent ?? 0) + (overview?.job?.failedContent ?? 0);
  const globalHandled = overview?.job?.globalResolution.status === "ready" ? 1 : 0;
  const handled = handledFiles + globalHandled;
  const totalWork = (overview?.job?.totalContent ?? 0) + 1;
  const overallPercent = totalWork
    ? Math.round(handled / totalWork * 100)
    : 0;
  const failureRuns = useMemo(() => overview?.job?.failureRuns ?? [], [overview?.job?.failureRuns]);
  const activeRuns = overview?.job?.activeRuns ?? [];
  const displayedRuns = activeRuns.length
    ? activeRuns
    : overview?.job?.activeRun
      ? [overview.job.activeRun]
      : [];
  const deepParallelUnits = activeRuns.flatMap((run) =>
    run.profile === "deep"
      ? run.parallelUnits.map((unit) => ({ ...unit, runId: run.id }))
      : []
  );
  const sourceUnits = deepParallelUnits.filter((unit) => unit.kind === "source");
  const deepGlobalUnits = deepParallelUnits.filter((unit) => unit.kind === "global_object");
  const activePhaseLimit = overview?.job?.activePhase === "coarse"
    ? overview.job.concurrency.coarseFiles
    : overview?.job?.activePhase === "catalog"
      ? overview.job.concurrency.catalogFiles
      : overview?.job?.concurrency.deepFiles ?? 1;
  const candidates = useMemo(() => overview?.candidates ?? [], [overview?.candidates]);

  const visibleCandidates = useMemo(() => {
    const normalizedSearch = search.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
    return candidates.filter((candidate) => {
      const selectedProfile = selections[candidate.sourceBlobId] ?? candidate.profile;
      if (profileFilter !== "all" && selectedProfile !== profileFilter) return false;
      if (!normalizedSearch) return true;
      return [candidate.nodeName, candidate.originalRelativePath, candidate.mimeType]
        .filter(Boolean)
        .join("\n")
        .normalize("NFKC")
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedSearch);
    });
  }, [candidates, profileFilter, search, selections]);

  const selectedItems = useMemo<LibraryCompilationSelection[]>(() =>
    candidates.flatMap((candidate) => {
      const profile = selections[candidate.sourceBlobId];
      return profile ? [{ sourceBlobId: candidate.sourceBlobId, profile }] : [];
    }), [candidates, selections]);

  const selectedCounts = useMemo(() => ({
    deep: selectedItems.filter((selection) => selection.profile === "deep").length,
    coarse: selectedItems.filter((selection) => selection.profile === "coarse").length,
    catalog: selectedItems.filter((selection) => selection.profile === "catalog").length,
  }), [selectedItems]);
  const selectedCandidates = useMemo(() => candidates.filter((candidate) =>
    Boolean(selections[candidate.sourceBlobId])
  ), [candidates, selections]);
  const selectedSemanticCount = selectedCandidates.filter((candidate) =>
    selections[candidate.sourceBlobId] !== "deep"
  ).length;
  const selectedSemanticImageCount = selectedCandidates.filter((candidate) =>
    selections[candidate.sourceBlobId] !== "deep" && candidate.mimeType.startsWith("image/")
  ).length;
  const modelConfigurationError = selectedSemanticCount > 0 && !overview?.modelConfiguration.text.configured
    ? "普通文字模型 AI_MODEL 尚未配置。"
    : selectedSemanticImageCount > 0 && !overview?.modelConfiguration.vision.configured
      ? `本次选择包含 ${selectedSemanticImageCount} 张图片，但视觉模型 AI_VISION_MODEL 尚未配置。`
      : undefined;

  function toggleCandidate(candidate: LibraryCompilationCandidate, checked: boolean) {
    setSelections((current) => {
      if (checked) return { ...current, [candidate.sourceBlobId]: candidate.profile };
      const next = { ...current };
      delete next[candidate.sourceBlobId];
      return next;
    });
  }

  function selectCandidates(mode: "all" | "important" | "none") {
    if (mode === "none") {
      setSelections({});
      return;
    }
    setSelections(Object.fromEntries(
      candidates
        .filter((candidate) => mode === "all" || candidate.profile !== "catalog")
        .map((candidate) => [candidate.sourceBlobId, candidate.profile]),
    ));
  }

  function setSelectedProfile(profile: LibraryProcessingProfile) {
    setSelections((current) => Object.fromEntries(
      Object.keys(current).map((sourceBlobId) => [sourceBlobId, profile]),
    ));
  }

  async function start() {
    if (!overview || !selectedItems.length) return;
    const confirmed = window.confirm(
      `本次选择 ${selectedItems.length} 份唯一内容：深度 ${selectedCounts.deep}、粗编译 ${selectedCounts.coarse}、仅归档 ${selectedCounts.catalog}。\n\n未勾选文件仍保存在资料库，不会处理。成功编译会在 Global Object 归并后发布到 Shared Brain；重编译成功后原子替换该文件的旧记忆。是否开始？`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/library/compilation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections: selectedItems }),
      });
      const body = await response.json() as LibraryCompilationOverview & { error?: string };
      if (!response.ok) throw new Error(body.error || "无法创建基础编译任务");
      setOverview(body);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "无法创建任务");
    } finally {
      setBusy(false);
    }
  }

  async function action(actionName: "pause" | "resume" | "retry_failed" | "recover_stale") {
    if (!overview?.job) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/library/compilation/${encodeURIComponent(overview.job.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionName }),
      });
      const body = await response.json() as LibraryCompilationOverview & { error?: string };
      if (!response.ok) throw new Error(body.error || "基础编译操作失败");
      setOverview(body);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "基础编译操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full bg-[#f6f7f4]">
      <header className="border-b border-zinc-200 bg-white px-6 py-5 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-emerald-700">资料库处理流程</p>
            <h1 className="mt-1 text-2xl font-semibold text-zinc-950">导入与处理</h1>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onOpenLibrary} className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50">返回文件</button>
            <button type="button" onClick={() => onInvokeAI({ actionId: "library.review-compilation", message: "帮我分析当前基础编译进度和失败项。" })} className="rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50">询问 Sydaris</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-5 px-6 py-6 lg:px-8">
        {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
        {loading && !overview ? <p className="rounded-lg border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-400">正在读取任务状态…</p> : null}

        {overview ? (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {[
              ["文件节点", overview.inventory.fileNodes],
              ["唯一内容", overview.inventory.uniqueContent],
              ["去重节省", overview.inventory.duplicateNodes],
              ["深度", overview.inventory.deep],
              ["粗编译", overview.inventory.coarse],
              ["仅归档", overview.inventory.catalog],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-zinc-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-xs text-zinc-500">{label}</p>
                <p className="mt-1 text-xl font-semibold text-zinc-900">{value}</p>
              </div>
            ))}
          </section>
        ) : null}

        {overview && canCreateJob && candidates.length ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900">选择本次基础编译文件</h2>
                <p className="mt-1 text-sm text-zinc-500">按唯一内容选择；相同文件只处理一次。未勾选项继续保留在资料库，不调用解析器或模型。</p>
              </div>
              <p className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800">已选 {selectedItems.length} / {candidates.length}</p>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              {(["deep", "coarse", "catalog"] as const).map((profile, index) => (
                <div key={profile} className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
                  <p className="text-xs font-semibold text-emerald-700">阶段 {index + 1}</p>
                  <p className="mt-1 font-medium text-zinc-900">{PROFILE_LABELS[profile]}</p>
                  <p className="mt-1 text-sm text-zinc-500">本次 {selectedCounts[profile]} 份</p>
                </div>
              ))}
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
                <p className="text-xs font-semibold text-emerald-700">阶段 4</p>
                <p className="mt-1 font-medium text-zinc-900">跨文件 Global Object</p>
                <p className="mt-1 text-sm text-zinc-500">逐文件归并并保存 checkpoint</p>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-5">
              <button type="button" onClick={() => selectCandidates("important")} className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50">只选深度和粗编译</button>
              <button type="button" onClick={() => selectCandidates("all")} className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50">选择全部</button>
              <button type="button" onClick={() => selectCandidates("none")} className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50">清空</button>
              <span className="mx-1 hidden h-6 w-px bg-zinc-200 sm:block" />
              <span className="text-xs text-zinc-500">把已选项批量设为</span>
              {(["deep", "coarse", "catalog"] as const).map((profile) => (
                <button key={profile} type="button" disabled={!selectedItems.length} onClick={() => setSelectedProfile(profile)} className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">{PROFILE_LABELS[profile]}</button>
              ))}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <input aria-label="搜索编译文件" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名、路径或格式" className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500" />
              <select aria-label="按档位筛选" value={profileFilter} onChange={(event) => setProfileFilter(event.target.value as typeof profileFilter)} className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700">
                <option value="all">全部档位</option>
                <option value="deep">深度冷启动</option>
                <option value="coarse">粗编译</option>
                <option value="catalog">仅归档</option>
              </select>
            </div>
            <div className="mt-3 max-h-[30rem] overflow-auto rounded-lg border border-zinc-200">
              {visibleCandidates.length ? visibleCandidates.map((candidate) => {
                const selectedProfile = selections[candidate.sourceBlobId];
                return (
                  <div key={candidate.sourceBlobId} className={`grid items-center gap-3 border-b border-zinc-100 px-3 py-3 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_10rem] ${selectedProfile ? "bg-emerald-50/40" : "bg-white"}`}>
                    <input type="checkbox" aria-label={`选择 ${candidate.nodeName}`} checked={Boolean(selectedProfile)} onChange={(event) => toggleCandidate(candidate, event.target.checked)} className="h-4 w-4 rounded border-zinc-300 accent-emerald-700" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-800" title={candidate.nodeName}>{candidate.nodeName}</p>
                      <p className="mt-0.5 truncate text-xs text-zinc-400" title={candidate.originalRelativePath}>{candidate.originalRelativePath ?? candidate.mimeType}</p>
                      <p className="mt-1 text-xs text-zinc-500">{formatBytes(candidate.byteSize)}{candidate.duplicateNodeCount > 1 ? ` · ${candidate.duplicateNodeCount} 个位置` : ""}</p>
                    </div>
                    <select aria-label={`处理档位 ${candidate.nodeName}`} value={selectedProfile ?? candidate.profile} onChange={(event) => setSelections((current) => ({ ...current, [candidate.sourceBlobId]: event.target.value as LibraryProcessingProfile }))} className="rounded-md border border-zinc-200 bg-white px-2 py-2 text-xs text-zinc-700">
                      <option value="deep">深度冷启动</option>
                      <option value="coarse">粗编译</option>
                      <option value="catalog">仅归档</option>
                    </select>
                  </div>
                );
              }) : <p className="p-8 text-center text-sm text-zinc-400">没有符合筛选条件的文件</p>}
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs leading-5 text-zinc-500">默认只选已有的深度与粗编译文件；结果在来源校验和 Object 归并成功后发布到 Shared Brain。</p>
                {modelConfigurationError ? <p className="mt-1 text-xs font-medium text-amber-700">{modelConfigurationError}</p> : null}
              </div>
              <button type="button" disabled={busy || !selectedItems.length || Boolean(modelConfigurationError)} onClick={() => void start()} className="rounded-md bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">开始编译所选 {selectedItems.length} 项</button>
            </div>
          </section>
        ) : null}

        {overview?.job ? (
          <>
            <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-zinc-900">工作快照进度</h2>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${overview.job.status === "running" ? "bg-emerald-100 text-emerald-800" : overview.job.status === "failed" ? "bg-red-100 text-red-700" : "bg-zinc-100 text-zinc-700"}`}>{JOB_STATUS_LABELS[overview.job.status]}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">Job {overview.job.id}</p>
                </div>
                <div className="flex gap-2">
                  {overview.job.recoverable ? <button type="button" disabled={busy} onClick={() => void action("recover_stale")} className="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">恢复中断任务</button> : null}
                  {overview.job.status === "running" || overview.job.status === "queued" ? <button type="button" disabled={busy || overview.job.pauseRequested} onClick={() => void action("pause")} className="rounded-md border border-zinc-200 px-3 py-2 text-sm disabled:opacity-50">{overview.job.pauseRequested ? `等待正在运行的 ${Math.max(1, activeRuns.length)} 项完成…` : "暂停"}</button> : null}
                  {overview.job.status === "paused" ? <button type="button" disabled={busy} onClick={() => void action("resume")} className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">继续</button> : null}
                  {overview.job.failedContent > 0 && overview.job.status === "failed" ? <button type="button" disabled={busy} onClick={() => void action("retry_failed")} className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-700 disabled:opacity-50">重试失败项</button> : null}
                </div>
              </div>
              <div className="mt-5">
                <div className="mb-2 flex justify-between text-sm"><span>总进度（含全局 Object）</span><span className="font-medium">{handled}/{totalWork} · {overallPercent}%</span></div>
                <ProgressBar value={handled} total={totalWork} />
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-4">
                {(["deep", "coarse", "catalog"] as const).map((profile) => {
                  const phase = overview.job!.phases[profile];
                  return (
                    <div key={profile} className={`rounded-lg border p-4 ${overview.job!.activePhase === profile ? "border-emerald-300 bg-emerald-50" : "border-zinc-200 bg-zinc-50"}`}>
                      <div className="mb-2 flex justify-between text-sm"><span className="font-medium">{PROFILE_LABELS[profile]}</span><span className="text-zinc-500">{phase.completed}/{phase.total}</span></div>
                      <ProgressBar value={phase.completed} total={phase.total} tone={profile === "coarse" ? "amber" : profile === "catalog" ? "sky" : "emerald"} />
                      <p className="mt-2 text-xs text-zinc-400">{profile === "deep" ? `文件 1 路 · 来源 ${overview.job!.concurrency.deepSources} 路 · 模型 ${overview.job!.concurrency.coldStartModels} 路` : `文件 ${profile === "coarse" ? overview.job!.concurrency.coarseFiles : overview.job!.concurrency.catalogFiles} 路 · 文字模型 ${overview.job!.concurrency.textModels} 路`}</p>
                    </div>
                  );
                })}
                <div className={`rounded-lg border p-4 ${overview.job.activeStage === "global_objects" ? "border-emerald-300 bg-emerald-50" : "border-zinc-200 bg-zinc-50"}`}>
                  <div className="mb-2 flex justify-between text-sm"><span className="font-medium">Global Object</span><span className="text-zinc-500">{overview.job.globalResolution.progress}/{overview.job.globalResolution.total}{overview.job.globalResolution.objectCount ? ` · ${overview.job.globalResolution.objectCount} 个` : ""}</span></div>
                  <ProgressBar value={overview.job.globalResolution.progress} total={overview.job.globalResolution.total} tone="sky" />
                  <p className="mt-2 text-xs text-zinc-400">状态依赖，{overview.job.concurrency.globalObjects} 路顺序归并</p>
                  <p className="mt-2 line-clamp-2 text-xs text-zinc-500">{overview.job.globalResolution.statusMessage ?? "等待文件阶段完成"}</p>
                  {overview.job.globalResolution.retryCount ? <p className="mt-1 text-xs text-amber-700">自动续跑 {overview.job.globalResolution.retryCount} 次</p> : null}
                </div>
              </div>
            </section>

            {displayedRuns.length ? (
              <section className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">{activeRuns.length ? "正在并行处理" : "等待调度"}</p>
                    <h2 className="mt-1 font-semibold text-zinc-900">
                      {activeRuns.length
                        ? `${activeRuns.length}/${activePhaseLimit} 个文件 worker 正在运行`
                        : "下一份文件已进入队列"}
                    </h2>
                    {overview.job.activePhase === "deep" ? <p className="mt-1 text-xs text-zinc-500">深度文件外层单路，文件内部最多 {overview.job.concurrency.deepSources} 个来源节点并行，最多 {overview.job.concurrency.coldStartModels} 个模型同时 thinking。</p> : <p className="mt-1 text-xs text-zinc-500">最多 {overview.job.concurrency.textModels} 个文字模型请求同时 thinking / 流式输出。</p>}
                  </div>
                  {overview.job.activePhase ? <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-emerald-800">{PROFILE_LABELS[overview.job.activePhase]}</span> : null}
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {displayedRuns.map((run) => <ActiveRunCard key={run.id} run={run} />)}
                </div>

                {overview.job.activePhase === "deep" && activeRuns.length ? (
                  <div className="mt-4 rounded-lg border border-emerald-200 bg-white/70 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-zinc-900">深度文件内部流水线</p>
                        <p className="mt-0.5 text-xs text-zinc-500">来源节点 {sourceUnits.length}/{overview.job.concurrency.deepSources} 路活跃 · 模型在途上限 {overview.job.concurrency.coldStartModels} · Global Object {deepGlobalUnits.length}/{overview.job.concurrency.globalObjects} 路活跃</p>
                      </div>
                      {!deepParallelUnits.length ? <span className="text-xs text-zinc-400">等待来源节点进度上报</span> : null}
                    </div>
                    {sourceUnits.length ? (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {sourceUnits.map((unit) => (
                          <div key={`${unit.runId}:${unit.kind}:${unit.id}`} className="min-w-0 rounded-md border border-emerald-100 bg-emerald-50/60 px-3 py-2">
                            <p className="truncate text-xs font-semibold text-emerald-900" title={unit.id}>{unit.id}</p>
                            <p className="mt-1 line-clamp-2 text-xs leading-4 text-zinc-500">{unit.statusMessage}</p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {deepGlobalUnits.map((unit) => (
                      <div key={`${unit.runId}:${unit.kind}:${unit.id}`} className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2">
                        <p className="text-xs font-semibold text-sky-900">Global Object · {unit.id}</p>
                        <p className="mt-1 text-xs text-sky-800/70">{unit.statusMessage}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : overview.job.activeStage === "global_objects" ? (
              <section className="rounded-xl border border-sky-200 bg-sky-50 p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">跨文件 Global Object</p>
                <p className="mt-2 font-semibold text-zinc-900">{overview.job.globalResolution.statusMessage ?? "逐文件归并 Object 草稿"}</p>
                {overview.job.globalResolution.errorMessage ? <p className="mt-2 text-xs text-amber-800">上次错误：{overview.job.globalResolution.errorMessage}</p> : null}
                <div className="mt-4"><ProgressBar value={overview.job.globalResolution.progress} total={overview.job.globalResolution.total} tone="sky" /></div>
              </section>
            ) : null}

            <section className="grid gap-5 xl:grid-cols-2">
              <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
                <header className="border-b border-zinc-200 px-4 py-3"><h2 className="font-semibold text-zinc-900">最近完成</h2><p className="mt-0.5 text-xs text-zinc-500">最近 40 份处理结果</p></header>
                {overview.job.recentRuns.length ? overview.job.recentRuns.map((run) => <RunRow key={run.id} run={run} publicationPending={ACTIVE_JOB_STATUSES.includes(overview.job!.status)} />) : <p className="p-8 text-center text-sm text-zinc-400">尚无完成项</p>}
              </div>
              <div className="overflow-hidden rounded-xl border border-red-200 bg-white shadow-sm">
                <header className="border-b border-red-200 bg-red-50 px-4 py-3"><h2 className="font-semibold text-red-950">处理失败 · {overview.job.failedContent}</h2><p className="mt-0.5 text-xs text-red-800/70">仅显示格式不支持、解析失败或 Global Object 归并不完整的文件</p></header>
                {failureRuns.length ? failureRuns.map((run) => <RunRow key={run.id} run={run} />) : <p className="p-8 text-center text-sm text-zinc-400">尚无失败项</p>}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
