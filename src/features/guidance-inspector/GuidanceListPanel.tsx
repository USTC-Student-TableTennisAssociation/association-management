import { useMemo } from "react";

import { KindBadge, StatusBadge } from "./GuidanceBadges";
import {
  defaultGuidanceFilters,
  getFilteredGuidanceNodes,
  type GuidanceFilterState,
} from "./guidance-filters";
import {
  guidanceKindLabels,
  guidanceRelationLabels,
  guidanceStatusLabels,
  type GuidanceGraph,
  type GuidanceKind,
  type GuidanceRelationType,
  type GuidanceStatus,
} from "./guidance-types";

type GuidanceListPanelProps = {
  graph: GuidanceGraph;
  filters: GuidanceFilterState;
  selectedNodeId: string | null;
  onFiltersChange: (nextFilters: GuidanceFilterState) => void;
  onSelectNode: (nodeId: string) => void;
  onHoverNode: (nodeId: string | null) => void;
};

const kindOptions = Object.entries(guidanceKindLabels) as Array<[GuidanceKind, string]>;
const statusOptions = Object.entries(guidanceStatusLabels) as Array<[GuidanceStatus, string]>;
const relationOptions = Object.entries(guidanceRelationLabels) as Array<
  [GuidanceRelationType, string]
>;

function toggleValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function GuidanceListPanel({
  graph,
  filters,
  selectedNodeId,
  onFiltersChange,
  onSelectNode,
  onHoverNode,
}: GuidanceListPanelProps) {
  const filteredNodes = useMemo(() => getFilteredGuidanceNodes(graph, filters), [filters, graph]);
  const sortedNodes = useMemo(
    () => [...filteredNodes].sort((left, right) => left.title.localeCompare(right.title, "zh-CN")),
    [filteredNodes],
  );

  function updateFilters(update: Partial<GuidanceFilterState>): void {
    onFiltersChange({ ...filters, ...update });
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <label className="block">
        <span className="sr-only">搜索指导卡片</span>
        <input
          value={filters.query}
          onChange={(event) => updateFilters({ query: event.target.value })}
          placeholder="搜索标题、正文或依据..."
          className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
        />
      </label>

      <div className="mt-4 space-y-4">
        <fieldset>
          <legend className="text-xs font-semibold text-zinc-600">卡片类型</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {kindOptions.map(([kind, label]) => (
              <label key={kind} className="flex items-center gap-2 text-xs text-zinc-700">
                <input
                  type="checkbox"
                  checked={filters.kinds.includes(kind)}
                  onChange={() => updateFilters({ kinds: toggleValue(filters.kinds, kind) })}
                  className="accent-emerald-700"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-xs font-semibold text-zinc-600">发布状态</legend>
          <div className="mt-2 flex gap-3">
            {statusOptions.map(([status, label]) => (
              <label key={status} className="flex items-center gap-2 text-xs text-zinc-700">
                <input
                  type="checkbox"
                  checked={filters.statuses.includes(status)}
                  onChange={() => updateFilters({ statuses: toggleValue(filters.statuses, status) })}
                  className="accent-emerald-700"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-semibold text-zinc-600">
            强制性
            <select
              value={filters.mandatory}
              onChange={(event) => updateFilters({ mandatory: event.target.value as GuidanceFilterState["mandatory"] })}
              className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-xs font-normal text-zinc-700"
            >
              <option value="all">全部</option>
              <option value="mandatory">仅强制</option>
              <option value="optional">仅建议</option>
            </select>
          </label>
          <label className="text-xs font-semibold text-zinc-600">
            是否孤立
            <select
              value={filters.isolated}
              onChange={(event) => updateFilters({ isolated: event.target.value as GuidanceFilterState["isolated"] })}
              className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-xs font-normal text-zinc-700"
            >
              <option value="all">全部</option>
              <option value="yes">仅孤立</option>
              <option value="no">仅非孤立</option>
            </select>
          </label>
          <label className="text-xs font-semibold text-zinc-600">
            入边
            <select
              value={filters.hasIncoming}
              onChange={(event) => updateFilters({ hasIncoming: event.target.value as GuidanceFilterState["hasIncoming"] })}
              className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-xs font-normal text-zinc-700"
            >
              <option value="all">全部</option>
              <option value="yes">有入边</option>
              <option value="no">无入边</option>
            </select>
          </label>
          <label className="text-xs font-semibold text-zinc-600">
            出边
            <select
              value={filters.hasOutgoing}
              onChange={(event) => updateFilters({ hasOutgoing: event.target.value as GuidanceFilterState["hasOutgoing"] })}
              className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-xs font-normal text-zinc-700"
            >
              <option value="all">全部</option>
              <option value="yes">有出边</option>
              <option value="no">无出边</option>
            </select>
          </label>
        </div>

        <fieldset>
          <legend className="text-xs font-semibold text-zinc-600">关系类型</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {relationOptions.map(([relationType, label]) => (
              <label key={relationType} className="flex items-center gap-2 text-xs text-zinc-700">
                <input
                  type="checkbox"
                  checked={filters.relationTypes.includes(relationType)}
                  onChange={() => updateFilters({ relationTypes: toggleValue(filters.relationTypes, relationType) })}
                  className="accent-emerald-700"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex items-start gap-2 rounded-md border border-zinc-200 bg-white p-2.5 text-xs leading-5 text-zinc-700">
          <input
            type="checkbox"
            checked={filters.onlyShowMatches}
            onChange={(event) => updateFilters({ onlyShowMatches: event.target.checked })}
            className="mt-1 accent-emerald-700"
          />
          <span>
            <strong className="block text-zinc-800">仅显示匹配节点</strong>
            默认只弱化不匹配节点；开启后才从图中隐藏它们。
          </span>
        </label>

        <button
          type="button"
          onClick={() => onFiltersChange(defaultGuidanceFilters)}
          className="text-xs font-medium text-emerald-700 hover:text-emerald-900"
        >
          清除全部筛选
        </button>
      </div>

      <div className="mt-5 border-t border-zinc-200 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-zinc-600">卡片列表</h3>
          <span className="text-xs text-zinc-500">{sortedNodes.length}</span>
        </div>
        <div className="space-y-2 pb-3">
          {sortedNodes.map((node) => {
            const isSelected = selectedNodeId === node.id;
            return (
              <button
                key={node.id}
                type="button"
                onMouseEnter={() => onHoverNode(node.id)}
                onMouseLeave={() => onHoverNode(null)}
                onClick={() => onSelectNode(node.id)}
                className={`w-full rounded-md border p-3 text-left transition ${
                  isSelected
                    ? "border-emerald-500 bg-emerald-50 shadow-sm"
                    : "border-zinc-200 bg-white hover:border-emerald-300 hover:bg-emerald-50/40"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 text-sm font-medium leading-5 text-zinc-900">{node.title}</p>
                  {node.isMandatory ? <span className="text-xs text-red-700">强制</span> : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <KindBadge kind={node.kind} />
                  <StatusBadge status={node.status} />
                </div>
                <p className="mt-2 text-[11px] text-zinc-500">
                  入 {node.incomingEdgeIds.length} · 出 {node.outgoingEdgeIds.length} · 关联 {node.directNeighborIds.length}
                </p>
              </button>
            );
          })}
          {sortedNodes.length === 0 ? (
            <p className="rounded-md border border-dashed border-zinc-300 p-3 text-xs text-zinc-500">没有匹配的指导卡片。</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
