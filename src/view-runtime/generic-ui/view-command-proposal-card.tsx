"use client";

import { useState } from "react";

import type { ViewCommandProposalNotice } from "@/agent-runtime/view-types";

export function ViewCommandProposalCard({
  proposal,
  onApplied,
}: {
  proposal: ViewCommandProposalNotice;
  onApplied?: (viewKey: string) => void;
}) {
  const [status, setStatus] = useState<"pending" | "working" | "applied" | "rejected" | "failed">("pending");
  const [error, setError] = useState<string>();

  async function decide(decision: "approve" | "reject") {
    setStatus("working");
    setError(undefined);
    try {
      const response = await fetch(`/api/view-proposals/${proposal.proposalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = await response.json() as { error?: string; kind?: string };
      if (!response.ok) {
        setStatus("failed");
        setError(body.error ?? "无法处理 Proposal");
        return;
      }
      setStatus(decision === "approve" ? "applied" : "rejected");
      if (decision === "approve") onApplied?.(proposal.viewKey);
    } catch (cause) {
      setStatus("failed");
      setError(cause instanceof Error ? cause.message : "无法处理 Proposal");
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
      <p className="font-semibold">View Command Proposal</p>
      <p className="mt-1 font-mono">{proposal.commandKey}@{proposal.commandVersion}</p>
      <p className="mt-1">
        {proposal.viewKey} · 基于状态 {proposal.stateVersion}；批准时会在最新状态重新校验
      </p>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2">{JSON.stringify(proposal.input, null, 2)}</pre>
      {status === "pending" ? <div className="mt-3 flex gap-2"><button type="button" onClick={() => void decide("approve")} className="rounded bg-emerald-800 px-3 py-1.5 text-white">批准</button><button type="button" onClick={() => void decide("reject")} className="rounded border border-amber-300 bg-white px-3 py-1.5">拒绝</button></div> : null}
      {status === "working" ? <p className="mt-2">处理中…</p> : null}
      {status === "applied" ? <p className="mt-2 font-medium text-emerald-800">已批准并执行。</p> : null}
      {status === "rejected" ? <p className="mt-2">已拒绝。</p> : null}
      {error ? <p className="mt-2 text-red-700">{error}</p> : null}
    </div>
  );
}
