"use client";

import { useState } from "react";

import type { ObjectChangeProposalPresentation } from "@/memory/object-management-types";

async function submitDecision(
  proposalId: string,
  decision: "approve" | "reject",
): Promise<ObjectChangeProposalPresentation> {
  const response = await fetch(`/api/object-management/proposals/${proposalId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  const body = await response.json() as {
    error?: string;
    proposal?: ObjectChangeProposalPresentation;
  };
  if (!response.ok || !body.proposal) {
    throw new Error(body.error || "Object Change Proposal 处理失败");
  }
  return body.proposal;
}

export function ObjectChangeProposalCard({
  proposal: initialProposal,
}: {
  proposal: ObjectChangeProposalPresentation;
}) {
  const [proposal, setProposal] = useState(initialProposal);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string>();

  async function decide(decision: "approve" | "reject") {
    if (busy || proposal.status !== "pending") return;
    setBusy(decision);
    setError(undefined);
    try {
      setProposal(await submitDecision(proposal.id, decision));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-3 rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-zinc-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">
            Object 身份修改建议
          </p>
          <p className="mt-1">{proposal.reason}</p>
        </div>
        <span className="rounded-full bg-white px-2 py-0.5 text-xs text-sky-800">
          {proposal.status}
        </span>
      </div>

      <div className="mt-3 space-y-2">
        {proposal.changes.map((change, index) => (
          <div key={`${change.type}-${index}`} className="rounded-md border border-sky-200 bg-white/80 p-2.5">
            <p className="font-medium text-zinc-900">{change.title}</p>
            <ul className="mt-1 list-disc pl-5 text-xs text-zinc-600">
              {change.details.map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
          </div>
        ))}
      </div>

      {proposal.invalidatesHigherMemory ? (
        <p className="mt-2 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">
          合并/拆分会使相关 Higher Memory 失效；旧文本不会被拼接到新身份。
        </p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      {proposal.status === "pending" ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void decide("approve")}
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {busy === "approve" ? "正在校验并应用…" : "批准"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void decide("reject")}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {busy === "reject" ? "正在拒绝…" : "拒绝"}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">
          {proposal.status === "applied"
            ? "已批准并原子应用 Object 身份修改。"
            : proposal.status === "rejected"
              ? "已拒绝；Object 图未发生变化。"
              : proposal.failureReason || "Proposal 已结束。"}
        </p>
      )}
    </section>
  );
}
