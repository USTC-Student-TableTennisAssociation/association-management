"use client";

import { useState } from "react";

import type { LibraryPlanPresentation } from "@/library/types";

const STATUS_LABELS: Record<LibraryPlanPresentation["status"], string> = {
  pending: "待确认",
  rejected: "已拒绝",
  applied: "已应用",
  failed: "应用失败",
};

export function LibraryProposalCard({ proposal }: { proposal: LibraryPlanPresentation }) {
  const [current, setCurrent] = useState(proposal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/library/plans/${encodeURIComponent(current.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = await response.json() as LibraryPlanPresentation & { error?: string };
      if (!response.ok) throw new Error(body.error || "无法处理资料库建议");
      setCurrent(body);
      if (body.status === "applied") window.dispatchEvent(new Event("sydaris-library-changed"));
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-3 overflow-hidden rounded-lg border border-emerald-200 bg-white text-zinc-800">
      <header className="flex items-center justify-between gap-3 bg-emerald-50 px-3 py-2">
        <p className="text-xs font-semibold text-emerald-900">资料库整理建议</p>
        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-emerald-800">{STATUS_LABELS[current.status]}</span>
      </header>
      <div className="p-3 text-xs">
        <p className="leading-5 text-zinc-600">{current.reason}</p>
        <ol className="mt-2 space-y-1.5">
          {current.operations.map((operation, index) => (
            <li key={`${operation.type}-${index}`} className="rounded bg-zinc-50 px-2.5 py-1.5">
              {index + 1}. {operation.description}
            </li>
          ))}
        </ol>
        {current.failureReason || error ? <p className="mt-2 text-red-700">{current.failureReason || error}</p> : null}
        {current.status === "pending" ? (
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => void decide("reject")} className="rounded border border-zinc-200 px-2.5 py-1.5 disabled:opacity-50">拒绝</button>
            <button type="button" disabled={busy} onClick={() => void decide("approve")} className="rounded bg-emerald-700 px-2.5 py-1.5 font-medium text-white disabled:opacity-50">{busy ? "处理中…" : "批准并应用"}</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
