"use client";

import { useMemo } from "react";
import type { AIInvocation } from "@sydaris/plugin-sdk";
import { useView } from "@sydaris/plugin-sdk/react";

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value, null, 2);
}

export function GenericViewInspector({
  viewKey,
  refreshRevision = 0,
  focusCardId,
  onClose,
  onOpenAI,
  onInvokeAI,
}: {
  viewKey: string;
  refreshRevision?: number;
  focusCardId?: string;
  onClose?: () => void;
  onOpenAI?: () => void;
  onInvokeAI?: (invocation: AIInvocation) => void;
}) {
  const { snapshot, error, loading, refresh } = useView(viewKey, refreshRevision);

  const schemaByType = useMemo(() => new Map(
    snapshot?.schema.cardTypes.map((cardType) => [cardType.key, cardType]) ?? [],
  ), [snapshot]);

  if (loading) return <div className="p-8 text-sm text-zinc-500">正在读取 View Inspector…</div>;
  if (!snapshot) return (
    <div className="p-8">
      <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error ?? "View 不可用"}</p>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-7xl p-6 lg:p-9">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">Read-only View Inspector</p>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-950">{snapshot.manifest.label}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">{snapshot.manifest.description}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500">
            <span className="rounded-full bg-zinc-100 px-2.5 py-1">Plugin {snapshot.pluginVersion}</span>
            <span className="rounded-full bg-zinc-100 px-2.5 py-1">Schema {snapshot.schemaVersion}</span>
            <span className="rounded-full bg-zinc-100 px-2.5 py-1">State {snapshot.stateVersion}</span>
            <span className="rounded-full bg-zinc-100 px-2.5 py-1">{snapshot.cards.length} Cards</span>
          </div>
        </div>
        <div className="flex gap-2">
          {onClose ? <button type="button" onClick={onClose} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50">返回工作视图</button> : null}
          <button type="button" onClick={refresh} className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50">刷新</button>
          {onOpenAI ? <button type="button" onClick={onOpenAI} className="rounded-lg bg-emerald-800 px-3 py-2 text-sm text-white hover:bg-emerald-900">打开 AI</button> : null}
        </div>
      </header>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <details>
          <summary className="cursor-pointer font-semibold text-zinc-900">View Schema</summary>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {snapshot.schema.cardTypes.map((cardType) => (
              <article key={cardType.key} className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
                <p className="font-medium text-zinc-900">{cardType.label}</p>
                <p className="mt-1 font-mono text-xs text-zinc-500">{cardType.key}</p>
                <p className="mt-2 text-sm leading-5 text-zinc-600">{cardType.description}</p>
                <p className="mt-3 text-xs font-semibold text-zinc-700">Typed Dimensions</p>
                <ul className="mt-1 space-y-1 text-xs text-zinc-600">
                  {cardType.dimensions.map((dimension) => (
                    <li key={dimension.key}>{dimension.label} <span className="font-mono text-zinc-400">{dimension.key}:{dimension.type}</span>{dimension.required ? " *" : ""}</li>
                  ))}
                  {!cardType.dimensions.length ? <li className="text-zinc-400">无</li> : null}
                </ul>
                <p className="mt-3 text-xs font-semibold text-zinc-700">Slots</p>
                <ul className="mt-1 space-y-1 text-xs text-zinc-600">
                  {cardType.slots.map((slot) => (
                    <li key={slot.key}>{slot.label} <span className="font-mono text-zinc-400">{slot.key}:{slot.cardinality} → {slot.allowedTargetCardTypes.join("|")}</span></li>
                  ))}
                  {!cardType.slots.length ? <li className="text-zinc-400">无</li> : null}
                </ul>
                <p className="mt-3 text-xs text-zinc-500">Related Objects: {cardType.relatedObjects ? JSON.stringify(cardType.relatedObjects) : "not allowed"}</p>
              </article>
            ))}
          </div>
        </details>
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-zinc-950">Cards</h2>
          {onInvokeAI ? <button type="button" onClick={() => onInvokeAI({ actionId: "sydaris.inspect-view", message: `请解读 ${viewKey} 的当前正式状态。` })} className="text-sm text-emerald-800 hover:underline">让 AI 解读</button> : null}
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {snapshot.cards.map((card) => {
            const cardType = schemaByType.get(card.cardTypeKey);
            return (
              <article key={card.id} className={`rounded-xl border bg-white p-5 shadow-sm ${focusCardId === card.id ? "border-emerald-500 ring-2 ring-emerald-100" : "border-zinc-200"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div><p className="font-semibold text-zinc-900">{cardType?.label ?? card.cardTypeKey}</p><p className="mt-1 font-mono text-[11px] text-zinc-400">{card.id}</p></div>
                  <span className="rounded-full bg-zinc-100 px-2 py-1 font-mono text-[11px] text-zinc-500">{card.cardTypeKey}</span>
                </div>
                <dl className="mt-4 space-y-3">
                  {cardType?.dimensions.map((dimension) => (
                    <div key={dimension.key} className="grid grid-cols-[9rem_1fr] gap-3 text-sm">
                      <dt className="text-zinc-500">{dimension.label}<span className="ml-1 font-mono text-[10px] text-zinc-300">{dimension.type}</span></dt>
                      <dd className="whitespace-pre-wrap break-words text-zinc-800">{card.dimensions[dimension.key] === undefined ? <span className="text-zinc-300">—</span> : displayValue(card.dimensions[dimension.key])}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-600">
                  <p><span className="font-semibold">Slots</span> {Object.entries(card.slots).map(([key, targets]) => `${key} → ${targets.join(", ")}`).join("；") || "无"}</p>
                  <p className="mt-2"><span className="font-semibold">Related Objects</span> {card.relatedObjectIds.join(", ") || "无"}</p>
                </div>
              </article>
            );
          })}
          {!snapshot.cards.length ? <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-400">当前 View 还没有 Card。Inspector 只读，请通过专属 Presentation、AI/Skill 或 Command API 写入。</p> : null}
        </div>
      </section>
    </div>
  );
}
