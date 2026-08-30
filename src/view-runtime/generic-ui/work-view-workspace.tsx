"use client";

import { useMemo } from "react";
import type { AIInvocation } from "@sydaris/plugin-sdk";
import { useView, useViewReactions } from "@sydaris/plugin-sdk/react";

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value, null, 2);
}

export function WorkViewWorkspace({
  viewKey,
  refreshRevision = 0,
  focusCardId,
  onOpenInspector,
  onInvokeAI,
}: {
  viewKey: string;
  refreshRevision?: number;
  focusCardId?: string;
  onOpenInspector: () => void;
  onInvokeAI: (invocation: AIInvocation) => void;
}) {
  const { reactions } = useViewReactions(viewKey);
  const { snapshot, error, loading, refresh } = useView(viewKey, refreshRevision);
  const cardTypes = useMemo(() => new Map(
    snapshot?.schema.cardTypes.map((cardType) => [cardType.key, cardType]) ?? [],
  ), [snapshot]);
  const groupedCards = useMemo(() => snapshot?.schema.cardTypes.map((cardType) => ({
    cardType,
    cards: snapshot.cards.filter((card) => card.cardTypeKey === cardType.key),
  })).filter((group) => group.cards.length) ?? [], [snapshot]);

  if (loading) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-zinc-500">正在恢复 Work View…</div>;
  }
  if (!snapshot) {
    return (
      <div className="p-8">
        <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error ?? "Work View 不可用"}</p>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-[#f7f8f6]">
      <header className="border-b border-zinc-200 bg-white px-5 py-5 lg:px-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">Work View</p>
            <h1 className="mt-1.5 text-2xl font-semibold tracking-[-0.02em] text-zinc-950">{snapshot.manifest.label}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">{snapshot.manifest.description}</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onOpenInspector}
              className="rounded-lg px-2 py-2 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            >
              高级
            </button>
            <button
              type="button"
              onClick={refresh}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50"
            >
              刷新
            </button>
            <button
              type="button"
              onClick={() => onInvokeAI({
                actionId: "sydaris.inspect-view",
                message: `请解读 ${viewKey} 的当前正式状态。`,
              })}
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
            >
              让 AI 解读
            </button>
          </div>
        </div>
      </header>

      <div className="space-y-6 p-5 lg:p-7">
        {groupedCards.map(({ cardType, cards }) => (
          <section key={cardType.key}>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-zinc-900">{cardType.label}</h2>
                <p className="mt-0.5 text-xs text-zinc-500">{cardType.description}</p>
              </div>
              <span className="shrink-0 text-xs text-zinc-400">{cards.length} 项</span>
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              {cards.map((card) => (
                <article
                  key={card.id}
                  className={`rounded-xl border bg-white p-4 shadow-sm ${
                    focusCardId === card.id
                      ? "border-emerald-500 ring-2 ring-emerald-100"
                      : "border-zinc-200"
                  }`}
                >
                  {(() => {
                    const reaction = reactions.find((candidate) =>
                      candidate.targets.some((target) => target.cardId === card.id)
                    );
                    if (!reaction) return null;
                    const active = reaction.attention.status === "queued" ||
                      reaction.attention.status === "running" ||
                      reaction.knowledge.status === "queued" ||
                      reaction.knowledge.status === "running";
                    const label = active
                      ? "Sydaris 正在核对"
                      : reaction.attention.status === "needs_confirmation"
                      ? "需要确认"
                      : reaction.attention.status === "inform"
                      ? "Sydaris 有一条说明"
                      : reaction.attention.status === "failed" || reaction.knowledge.status === "failed"
                      ? "核对暂不可用"
                      : undefined;
                    return label ? (
                      <div className="mb-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600" role="status">
                        <span className="font-medium">{label}</span>
                        {reaction.attention.message ? (
                          <p className="mt-1 leading-5 text-zinc-500">{reaction.attention.message}</p>
                        ) : null}
                      </div>
                    ) : null;
                  })()}
                  <dl className="space-y-3">
                    {(cardTypes.get(card.cardTypeKey)?.dimensions ?? []).map((dimension) => {
                      const value = card.dimensions[dimension.key];
                      return (
                        <div key={dimension.key} className="grid gap-1 text-sm sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-3">
                          <dt className="text-zinc-500">{dimension.label}</dt>
                          <dd className="whitespace-pre-wrap break-words text-zinc-800">
                            {value === undefined ? <span className="text-zinc-300">—</span> : displayValue(value)}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </article>
              ))}
            </div>
          </section>
        ))}

        {!snapshot.cards.length ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center">
            <p className="text-sm font-medium text-zinc-700">当前 Work View 还没有正式条目</p>
            <p className="mt-1 text-xs leading-5 text-zinc-400">可在 AI Pane 中描述工作内容，由 Sydaris 通过现有 Proposal / Command 流程协助建立。</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
