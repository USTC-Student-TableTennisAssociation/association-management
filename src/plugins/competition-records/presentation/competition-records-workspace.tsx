"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import type {
  EchoPresentationProps,
  EchoViewCommandResult,
} from "@sydaris/plugin-sdk";
import {
  useEchoCommand,
  useEchoView,
} from "@sydaris/plugin-sdk/react";

import {
  buildCompetitionRecordsModel,
  type CompetitionEditionItem,
  type CompetitionSeriesItem,
  type CompetitionYearStat,
} from "@/plugins/competition-records/presentation/competition-records-state";
import styles from "@/plugins/competition-records/presentation/competition-records.module.css";

const UNASSIGNED_SCOPE = "__unassigned__";

type WorkspaceTab = "series" | "editions";

type SyncWriteSummary = {
  total?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
};

type SyncSummary = {
  source: {
    sourceSystem: string;
    sourceSnapshotAt: string;
    complete: true;
    pageCount: number;
    recordCount: number;
  };
  mapping: { version: string; editionCount: number };
  write: { kind: string; summary?: SyncWriteSummary };
};

const numberFormatter = new Intl.NumberFormat("zh-CN");

function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function formatDate(value: string | undefined): string {
  if (!value) return "日期待补";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value;
}

function shortDate(value: string | undefined): string {
  if (!value) return "待补";
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[1]}/${match[2]}` : value.slice(0, 8);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatObservedAt(value: string | undefined): string {
  if (!value) return "正在读取正式 View";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "正式 View 已载入";
  return `Echo 读取于 ${new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)}`;
}

function formatRange(first: string | undefined, latest: string | undefined): string {
  if (!first && !latest) return "日期待补";
  if (first === latest) return formatDate(first);
  return `${formatDate(first)} – ${formatDate(latest)}`;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="m12.75 12.75 3.75 3.75" />
    </svg>
  );
}

function SyncIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M15.8 7.25A6.25 6.25 0 0 0 4.7 5.4L3.5 7" />
      <path d="M3.5 3.75V7H6.8M4.2 12.75a6.25 6.25 0 0 0 11.1 1.85l1.2-1.6" />
      <path d="M16.5 16.25V13h-3.3" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m9.5 2 1.25 4.25L15 7.5l-4.25 1.25L9.5 13 8.25 8.75 4 7.5l4.25-1.25L9.5 2Z" />
      <path d="m15.75 12.25.6 1.7 1.65.55-1.65.6-.6 1.65-.55-1.65-1.7-.6 1.7-.55.55-1.7Z" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m12.75 4.25 3 3L7.5 15.5l-3.75.75.75-3.75 8.25-8.25Z" />
      <path d="m11.5 5.5 3 3" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" />
    </svg>
  );
}

function MetricCard({
  label,
  value,
  note,
  accent = false,
}: {
  label: string;
  value: string;
  note: string;
  accent?: boolean;
}) {
  return (
    <article className={`${styles.metricCard} ${accent ? styles.metricAccent : ""}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{note}</span>
    </article>
  );
}

function AttendanceTrendChart({
  editions,
}: {
  editions: readonly CompetitionEditionItem[];
}) {
  const chronological = [...editions].reverse();
  const width = 760;
  const height = 250;
  const padding = { top: 22, right: 18, bottom: 42, left: 42 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const peak = Math.max(1, ...chronological.map((edition) => edition.participantCount));
  const roundedPeak = Math.max(10, Math.ceil(peak / 10) * 10);
  const average = chronological.length
    ? chronological.reduce((total, edition) => total + edition.participantCount, 0) /
      chronological.length
    : 0;
  const points = chronological.map((edition, index) => {
    const x = chronological.length === 1
      ? padding.left + plotWidth / 2
      : padding.left + (index / (chronological.length - 1)) * plotWidth;
    const y = padding.top + plotHeight -
      (edition.participantCount / roundedPeak) * plotHeight;
    return { edition, x, y };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = points.length
    ? [
        `${points[0].x},${padding.top + plotHeight}`,
        ...points.map((point) => `${point.x},${point.y}`),
        `${points.at(-1)!.x},${padding.top + plotHeight}`,
      ].join(" ")
    : "";
  const labelEvery = Math.max(1, Math.ceil(chronological.length / 5));

  return (
    <section className={styles.chartPanel} aria-labelledby="attendance-chart-title">
      <div className={styles.chartHeading}>
        <div>
          <p className={styles.eyebrow}>PARTICIPATION TREND</p>
          <h3 id="attendance-chart-title">历届参与人次</h3>
        </div>
        <div className={styles.chartSummary}>
          <span>平均 <strong>{Math.round(average)}</strong></span>
          <span>峰值 <strong>{peak === 1 && chronological.length === 0 ? 0 : peak}</strong></span>
        </div>
      </div>
      {chronological.length ? (
        <div className={styles.lineChartScroller}>
          <svg
            className={styles.lineChart}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`共 ${chronological.length} 届比赛的参与人次趋势，平均 ${Math.round(average)} 人次，峰值 ${peak} 人次`}
          >
            <defs>
              <linearGradient id="competition-attendance-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0f766e" stopOpacity="0.24" />
                <stop offset="100%" stopColor="#0f766e" stopOpacity="0.01" />
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map((ratio) => {
              const y = padding.top + plotHeight * ratio;
              const value = Math.round(roundedPeak * (1 - ratio));
              return (
                <g key={ratio}>
                  <line className={styles.chartGridLine} x1={padding.left} x2={width - padding.right} y1={y} y2={y} />
                  <text className={styles.chartAxisLabel} x={padding.left - 10} y={y + 4} textAnchor="end">{value}</text>
                </g>
              );
            })}
            {area ? <polygon points={area} fill="url(#competition-attendance-area)" /> : null}
            {points.length > 1 ? <polyline className={styles.chartLine} points={line} /> : null}
            {points.map((point, index) => (
              <g key={point.edition.id}>
                <circle className={styles.chartPointHalo} cx={point.x} cy={point.y} r="7" />
                <circle className={styles.chartPoint} cx={point.x} cy={point.y} r="3.5">
                  <title>{point.edition.name}：{point.edition.participantCount} 人次</title>
                </circle>
                {(index === 0 || index === points.length - 1 || index % labelEvery === 0) ? (
                  <text className={styles.chartAxisLabel} x={point.x} y={height - 14} textAnchor="middle">
                    {shortDate(point.edition.heldOn)}
                  </text>
                ) : null}
              </g>
            ))}
          </svg>
        </div>
      ) : (
        <div className={styles.chartEmpty}>这个范围内还没有可以绘制的比赛届次。</div>
      )}
    </section>
  );
}

function YearlyChart({ stats }: { stats: readonly CompetitionYearStat[] }) {
  const peak = Math.max(1, ...stats.map((stat) => stat.participantCount));
  return (
    <section className={styles.smallChartPanel} aria-labelledby="year-chart-title">
      <div className={styles.smallChartHeading}>
        <div>
          <p className={styles.eyebrow}>YEARLY OVERVIEW</p>
          <h3 id="year-chart-title">年度参赛人次</h3>
        </div>
        <span>按比赛日期汇总</span>
      </div>
      {stats.length ? (
        <div className={styles.yearBars}>
          {stats.map((stat) => (
            <div className={styles.yearBarColumn} key={stat.year}>
              <div className={styles.yearBarValue}>{formatNumber(stat.participantCount)}</div>
              <div className={styles.yearBarTrack}>
                <div
                  className={styles.yearBarFill}
                  style={{ height: `${Math.max(8, (stat.participantCount / peak) * 100)}%` }}
                  title={`${stat.year}：${stat.editionCount} 场，${stat.participantCount} 人次`}
                />
              </div>
              <strong>{stat.year}</strong>
              <span>{stat.editionCount} 场</span>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.smallChartEmpty}>比赛日期完善后会在这里形成年度趋势。</div>
      )}
    </section>
  );
}

function SeriesScaleChart({
  series,
  unassigned,
}: {
  series: readonly CompetitionSeriesItem[];
  unassigned: readonly CompetitionEditionItem[];
}) {
  const rows = [
    ...series.map((item) => ({
      id: item.id,
      name: item.name,
      count: item.editions.length,
      participants: item.totalParticipants,
    })),
    ...(unassigned.length ? [{
      id: UNASSIGNED_SCOPE,
      name: "未归类",
      count: unassigned.length,
      participants: unassigned.reduce((total, edition) => total + edition.participantCount, 0),
    }] : []),
  ].sort((left, right) => right.participants - left.participants);
  const peak = Math.max(1, ...rows.map((row) => row.participants));
  return (
    <section className={styles.smallChartPanel} aria-labelledby="series-chart-title">
      <div className={styles.smallChartHeading}>
        <div>
          <p className={styles.eyebrow}>SERIES SCALE</p>
          <h3 id="series-chart-title">系列规模对比</h3>
        </div>
        <span>累计参赛人次</span>
      </div>
      {rows.length ? (
        <div className={styles.scaleRows}>
          {rows.slice(0, 6).map((row) => (
            <div className={styles.scaleRow} key={row.id}>
              <div className={styles.scaleLabel}>
                <strong>{row.name}</strong>
                <span>{row.count} 届</span>
              </div>
              <div className={styles.scaleTrack}>
                <div style={{ width: `${Math.max(3, (row.participants / peak) * 100)}%` }} />
              </div>
              <b>{formatNumber(row.participants)}</b>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.smallChartEmpty}>整理赛事系列后会在这里形成规模对比。</div>
      )}
    </section>
  );
}

function EditionTimeline({ editions }: { editions: readonly CompetitionEditionItem[] }) {
  return (
    <section className={styles.timelinePanel}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>EDITION ARCHIVE</p>
          <h3>届次时间线</h3>
        </div>
        <span>{editions.length} 届</span>
      </div>
      {editions.length ? (
        <ol className={styles.timeline}>
          {editions.map((edition) => (
            <li key={edition.id}>
              <div className={styles.timelineMarker} aria-hidden="true" />
              <div className={styles.timelineDate}>{formatDate(edition.heldOn)}</div>
              <div className={styles.timelineContent}>
                <strong>{edition.name}</strong>
                <span>
                  {edition.sequenceNumber ? `第 ${edition.sequenceNumber} 届 · ` : ""}
                  {edition.sourceSystem}
                </span>
              </div>
              <div className={styles.timelineCount}>
                <strong>{formatNumber(edition.participantCount)}</strong>
                <span>人次</span>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className={styles.timelineEmpty}>这个系列尚未关联比赛届次。</div>
      )}
    </section>
  );
}

function SeriesEditor({
  series,
  saving,
  error,
  onCancel,
  onSave,
}: {
  series: CompetitionSeriesItem;
  saving: boolean;
  error?: string;
  onCancel: () => void;
  onSave: (values: { name: string; description: string; cadence: string }) => void;
}) {
  const [name, setName] = useState(series.name);
  const [description, setDescription] = useState(series.description ?? "");
  const [cadence, setCadence] = useState(series.cadence ?? "");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, saving]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ name, description, cadence });
  };

  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onCancel();
    }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="series-editor-title">
        <form onSubmit={submit}>
          <div className={styles.dialogHeading}>
            <div>
              <p className={styles.eyebrow}>EDIT SERIES</p>
              <h2 id="series-editor-title">修改赛事系列</h2>
              <p>只修改长期稳定信息，不会改动任何比赛届次。</p>
            </div>
            <button type="button" className={styles.dialogClose} onClick={onCancel} disabled={saving} aria-label="关闭">
              ×
            </button>
          </div>
          <div className={styles.formFields}>
            <label>
              <span>系列名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={300} required autoFocus />
            </label>
            <label>
              <span>系列简介</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5_000} rows={6} placeholder="描述跨届稳定的定位、赛制或目标" />
              <small>{description.length} / 5000</small>
            </label>
            <label>
              <span>举办节奏</span>
              <input value={cadence} onChange={(event) => setCadence(event.target.value)} maxLength={300} placeholder="例如：每学期多次" />
            </label>
          </div>
          {error ? <p className={styles.formError}>{error}</p> : null}
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={saving}>取消</button>
            <button type="submit" className={styles.primaryButton} disabled={saving || !name.trim()}>
              {saving ? "正在保存…" : "保存系列信息"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function CompetitionRecordsWorkspace({
  viewKey,
  refreshRevision = 0,
  focusCardId,
  onAskAI,
}: EchoPresentationProps) {
  const { snapshot, error: loadError, loading, refresh } = useEchoView(
    viewKey,
    refreshRevision,
  );
  const executeCommand = useEchoCommand(viewKey);
  const model = useMemo(
    () => buildCompetitionRecordsModel(snapshot?.cards ?? []),
    [snapshot?.cards],
  );
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("series");
  const [selectedScopeId, setSelectedScopeId] = useState<string>();
  const [search, setSearch] = useState("");
  const [yearFilter, setYearFilter] = useState("all");
  const [seriesFilter, setSeriesFilter] = useState("all");
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary>();
  const [actionError, setActionError] = useState<string>();
  const [editingSeriesId, setEditingSeriesId] = useState<string>();
  const [savingSeries, setSavingSeries] = useState(false);
  const [editorError, setEditorError] = useState<string>();

  const selectedScopeIsValid = selectedScopeId === UNASSIGNED_SCOPE
    ? model.unassignedEditions.length > 0 || model.series.length === 0
    : model.series.some((series) => series.id === selectedScopeId);
  const effectiveScopeId = selectedScopeId && selectedScopeIsValid
    ? selectedScopeId
    : model.series[0]?.id ?? UNASSIGNED_SCOPE;
  const selectedSeries = model.series.find((series) => series.id === effectiveScopeId);
  const selectedEditions = selectedSeries?.editions ?? model.unassignedEditions;
  const editingSeries = model.series.find((series) => series.id === editingSeriesId);
  const seriesNameById = useMemo(
    () => new Map(model.series.map((series) => [series.id, series.name])),
    [model.series],
  );

  useEffect(() => {
    if (!focusCardId) return;
    const focusedSeries = model.series.find((series) => series.id === focusCardId);
    const focusedEdition = model.editions.some((edition) => edition.id === focusCardId);
    if (!focusedSeries && !focusedEdition) return;
    const frame = window.requestAnimationFrame(() => {
      if (focusedSeries) {
        setSelectedScopeId(focusedSeries.id);
        setActiveTab("series");
      } else {
        setActiveTab("editions");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusCardId, model.editions, model.series]);

  const filteredEditions = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
    return model.editions.filter((edition) => {
      if (normalizedSearch && ![
        edition.name,
        edition.sourceSystem,
        edition.sourceId ?? "",
      ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedSearch))) {
        return false;
      }
      if (yearFilter !== "all" && !edition.heldOn?.startsWith(yearFilter)) return false;
      if (seriesFilter === UNASSIGNED_SCOPE && edition.seriesId) return false;
      if (seriesFilter !== "all" && seriesFilter !== UNASSIGNED_SCOPE && edition.seriesId !== seriesFilter) {
        return false;
      }
      return true;
    });
  }, [model.editions, search, seriesFilter, yearFilter]);

  const sync = async () => {
    setSyncing(true);
    setActionError(undefined);
    try {
      const response = await fetch("/api/views/competition_records/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ includeQuickMatches: false }),
      });
      const body = await response.json() as SyncSummary & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "同步失败");
      setSyncSummary(body);
      refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncing(false);
    }
  };

  const askSeriesSkill = () => {
    const scope = selectedSeries
      ? `请重点核对并完善赛事系列“${selectedSeries.name}”，结合其 ${selectedSeries.editions.length} 个比赛届次和知识库资料。`
      : `请优先整理以下尚未归类的比赛届次：${model.unassignedEditions.slice(0, 12).map((edition) => edition.name).join("、")}。`;
    onAskAI(`请使用整理赛事系列 Skill。${scope}`);
  };

  const saveSeries = async (values: {
    name: string;
    description: string;
    cadence: string;
  }) => {
    if (!editingSeries || !snapshot) return;
    const normalized = {
      name: values.name.trim(),
      description: values.description.trim(),
      cadence: values.cadence.trim(),
    };
    const changes: Record<string, string | null> = {};
    if (normalized.name !== editingSeries.name) changes.name = normalized.name;
    if (normalized.description !== (editingSeries.description ?? "")) {
      changes.description = normalized.description || null;
    }
    if (normalized.cadence !== (editingSeries.cadence ?? "")) {
      changes.cadence = normalized.cadence || null;
    }
    if (!Object.keys(changes).length) {
      setEditingSeriesId(undefined);
      return;
    }
    setSavingSeries(true);
    setEditorError(undefined);
    try {
      const result = await executeCommand<EchoViewCommandResult>(
        "competition.organize_series",
        {
          mode: "update",
          seriesCardId: editingSeries.id,
          changes,
          editionCardIds: [],
        },
        snapshot.stateVersion,
      );
      if (result.kind !== "executed") {
        throw new Error("人工修改赛事系列时不应进入 Proposal 流程");
      }
      setEditingSeriesId(undefined);
      refresh();
    } catch (cause) {
      setEditorError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingSeries(false);
    }
  };

  const syncWrite = syncSummary?.write.summary;
  const combinedError = actionError ?? loadError;

  return (
    <div className={styles.workspace}>
      <header className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden="true" />
        <div className={styles.heroTopline}>
          <div className={styles.sourceStatus}>
            <span />
            USTCTTA DATA ARCHIVE
          </div>
          <p>{formatObservedAt(snapshot?.observedAt)}</p>
        </div>
        <div className={styles.heroContent}>
          <div className={styles.heroCopy}>
            <p className={styles.heroEyebrow}>赛事数据</p>
            <h1>看见每一届比赛，<br /><em>理解长期赛事。</em></h1>
            <p className={styles.heroDescription}>
              比赛届次由 USTCTTA 数据源确定性同步并保持只读；赛事系列可以人工维护，也可以由 Skill 结合知识库持续整理。
            </p>
          </div>
          <div className={styles.heroActions}>
            <button type="button" className={styles.syncButton} onClick={() => void sync()} disabled={syncing}>
              <SyncIcon />
              {syncing ? "正在同步…" : "同步 USTCTTA"}
            </button>
            <button type="button" className={styles.aiButton} onClick={askSeriesSkill} disabled={!model.editions.length}>
              <SparkleIcon />
              AI 整理赛事系列
            </button>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        {combinedError ? <div className={styles.errorBanner}>{combinedError}</div> : null}
        {syncSummary ? (
          <div className={styles.syncBanner}>
            <div>
              <SyncIcon />
              <span>
                已从 {syncSummary.source.sourceSystem} 完整读取 {syncSummary.source.recordCount} 条比赛记录
                （{syncSummary.source.pageCount} 批）· 源快照 {formatTimestamp(syncSummary.source.sourceSnapshotAt)}
              </span>
            </div>
            <p>
              新增 <strong>{syncWrite?.created ?? 0}</strong>
              <span>·</span>
              更新 <strong>{syncWrite?.updated ?? 0}</strong>
              <span>·</span>
              无变化 <strong>{syncWrite?.unchanged ?? 0}</strong>
            </p>
          </div>
        ) : null}

        <section className={styles.metrics} aria-label="赛事概览">
          <MetricCard label="比赛届次" value={formatNumber(model.editions.length)} note="全部为只读来源记录" />
          <MetricCard label="赛事系列" value={formatNumber(model.series.length)} note="可人工维护稳定信息" />
          <MetricCard label="未归类届次" value={formatNumber(model.unassignedEditions.length)} note="等待证据支持的归属" accent={model.unassignedEditions.length > 0} />
          <MetricCard label="累计参赛人次" value={formatNumber(model.totalParticipants)} note="跨届累计，不代表去重人数" />
        </section>

        <nav className={styles.tabs} aria-label="赛事档案视图">
          <button type="button" className={activeTab === "series" ? styles.activeTab : ""} onClick={() => setActiveTab("series")}>系列总览</button>
          <button type="button" className={activeTab === "editions" ? styles.activeTab : ""} onClick={() => setActiveTab("editions")}>全部届次</button>
        </nav>

        {loading && !snapshot ? <div className={styles.loadingState}>正在读取赛事档案…</div> : null}

        {!loading && activeTab === "series" ? (
          <div className={styles.seriesWorkspace}>
            <aside className={styles.seriesRail}>
              <div className={styles.railHeading}>
                <div>
                  <p className={styles.eyebrow}>SERIES</p>
                  <h2>赛事系列</h2>
                </div>
                <span>{model.series.length}</span>
              </div>
              <div className={styles.seriesButtons}>
                {model.series.map((series) => (
                  <button
                    type="button"
                    key={series.id}
                    className={effectiveScopeId === series.id ? styles.selectedSeriesButton : ""}
                    onClick={() => setSelectedScopeId(series.id)}
                  >
                    <span className={styles.seriesButtonTitle}>
                      <strong>{series.name}</strong>
                      <ArrowIcon />
                    </span>
                    <span className={styles.seriesButtonMeta}>{series.editions.length} 届 · {formatNumber(series.totalParticipants)} 人次</span>
                    <span className={styles.seriesButtonRange}>{formatRange(series.firstHeldOn, series.latestHeldOn)}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className={`${styles.unassignedButton} ${effectiveScopeId === UNASSIGNED_SCOPE ? styles.selectedSeriesButton : ""}`}
                  onClick={() => setSelectedScopeId(UNASSIGNED_SCOPE)}
                >
                  <span className={styles.seriesButtonTitle}>
                    <strong>未归类届次</strong>
                    <b>{model.unassignedEditions.length}</b>
                  </span>
                  <span className={styles.seriesButtonMeta}>尚未获得可靠的系列归属</span>
                </button>
              </div>
            </aside>

            <div className={styles.seriesDetail}>
              <section className={styles.seriesOverview}>
                <div className={styles.seriesTitleRow}>
                  <div>
                    <p className={styles.eyebrow}>{selectedSeries ? "COMPETITION SERIES" : "UNASSIGNED EDITIONS"}</p>
                    <h2>{selectedSeries?.name ?? "未归类届次"}</h2>
                  </div>
                  {selectedSeries ? (
                    <button type="button" className={styles.editButton} onClick={() => {
                      setEditorError(undefined);
                      setEditingSeriesId(selectedSeries.id);
                    }}>
                      <EditIcon />
                      修改系列
                    </button>
                  ) : (
                    <button type="button" className={styles.inlineAiButton} onClick={askSeriesSkill} disabled={!model.unassignedEditions.length}>
                      <SparkleIcon />
                      整理归属
                    </button>
                  )}
                </div>
                {selectedSeries ? (
                  <>
                    <p className={styles.seriesDescription}>
                      {selectedSeries.description ?? "这个系列还没有稳定简介。可以人工补充，或让 Skill 根据多届资料进行整理。"}
                    </p>
                    <div className={styles.seriesFacts}>
                      <div><span>举办节奏</span><strong>{selectedSeries.cadence ?? "待整理"}</strong></div>
                      <div><span>日期跨度</span><strong>{formatRange(selectedSeries.firstHeldOn, selectedSeries.latestHeldOn)}</strong></div>
                      <div><span>累计参赛</span><strong>{formatNumber(selectedSeries.totalParticipants)} 人次</strong></div>
                    </div>
                  </>
                ) : (
                  <p className={styles.seriesDescription}>
                    这些比赛保留完整来源数据，但当前没有足够证据确认它们属于哪个长期赛事系列。它们不会被系统按名称静默归类。
                  </p>
                )}
              </section>

              <AttendanceTrendChart editions={selectedEditions} />
              <EditionTimeline editions={selectedEditions} />
            </div>
          </div>
        ) : null}

        {!loading && activeTab === "series" ? (
          <div className={styles.secondaryCharts}>
            <YearlyChart stats={model.yearStats} />
            <SeriesScaleChart series={model.series} unassigned={model.unassignedEditions} />
          </div>
        ) : null}

        {!loading && activeTab === "editions" ? (
          <section className={styles.editionsPanel}>
            <div className={styles.editionsHeading}>
              <div>
                <p className={styles.eyebrow}>ALL EDITIONS</p>
                <h2>全部比赛届次</h2>
                <p>来源事实保持只读；如数据有误，应回到来源系统修正后重新同步。</p>
              </div>
              <span>{filteredEditions.length} / {model.editions.length}</span>
            </div>
            <div className={styles.filters}>
              <label className={styles.searchField}>
                <SearchIcon />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索比赛名称或来源 ID" />
              </label>
              <label>
                <span className={styles.visuallyHidden}>年份</span>
                <select value={yearFilter} onChange={(event) => setYearFilter(event.target.value)}>
                  <option value="all">全部年份</option>
                  {[...model.yearStats].reverse().map((stat) => <option value={stat.year} key={stat.year}>{stat.year} 年</option>)}
                </select>
              </label>
              <label>
                <span className={styles.visuallyHidden}>赛事系列</span>
                <select value={seriesFilter} onChange={(event) => setSeriesFilter(event.target.value)}>
                  <option value="all">全部系列</option>
                  {model.series.map((series) => <option value={series.id} key={series.id}>{series.name}</option>)}
                  <option value={UNASSIGNED_SCOPE}>未归类</option>
                </select>
              </label>
            </div>
            <div className={styles.tableScroller}>
              <table className={styles.editionTable}>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>比赛届次</th>
                    <th>参与人次</th>
                    <th>所属系列</th>
                    <th>来源</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEditions.map((edition) => (
                    <tr key={edition.id} className={focusCardId === edition.id ? styles.focusedRow : ""}>
                      <td><time>{formatDate(edition.heldOn)}</time></td>
                      <td>
                        <strong>{edition.name}</strong>
                        <span>{edition.sequenceNumber ? `第 ${edition.sequenceNumber} 届` : "届次序号待补"}</span>
                      </td>
                      <td><b>{formatNumber(edition.participantCount)}</b><span>人次</span></td>
                      <td>
                        <span className={edition.seriesId ? styles.seriesPill : styles.unassignedPill}>
                          {edition.seriesId ? seriesNameById.get(edition.seriesId) : "未归类"}
                        </span>
                      </td>
                      <td>
                        <strong className={styles.sourceName}>{edition.sourceSystem}</strong>
                        <span className={styles.sourceId}>{edition.sourceId ?? "无来源 ID"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredEditions.length ? <div className={styles.tableEmpty}>没有符合当前筛选条件的比赛届次。</div> : null}
            </div>
          </section>
        ) : null}
      </main>

      {editingSeries ? (
        <SeriesEditor
          key={editingSeries.id}
          series={editingSeries}
          saving={savingSeries}
          error={editorError}
          onCancel={() => {
            if (savingSeries) return;
            setEditingSeriesId(undefined);
            setEditorError(undefined);
          }}
          onSave={(values) => void saveSeries(values)}
        />
      ) : null}
    </div>
  );
}
