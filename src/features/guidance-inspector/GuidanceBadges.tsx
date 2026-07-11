import {
  guidanceKindLabels,
  guidanceStatusLabels,
  type GuidanceKind,
  type GuidanceStatus,
} from "./guidance-types";

function kindBadgeStyle(kind: GuidanceKind): string {
  const styles: Record<GuidanceKind, string> = {
    workflow: "border-emerald-200 bg-emerald-50 text-emerald-700",
    rule: "border-blue-200 bg-blue-50 text-blue-700",
    checklist: "border-amber-200 bg-amber-50 text-amber-700",
    experience: "border-purple-200 bg-purple-50 text-purple-700",
  };
  return styles[kind];
}

export function KindBadge({ kind }: { kind: GuidanceKind }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${kindBadgeStyle(kind)}`}>
      {guidanceKindLabels[kind]}
    </span>
  );
}

export function StatusBadge({ status }: { status: GuidanceStatus }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
        status === "published"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-zinc-200 bg-zinc-100 text-zinc-600"
      }`}
    >
      {guidanceStatusLabels[status]}
    </span>
  );
}
