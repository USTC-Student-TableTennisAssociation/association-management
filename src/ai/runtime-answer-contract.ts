import type { CapabilityLedgerSnapshot } from "@/ai/capability-ledger";
import type { TurnEvidenceContract } from "@/evidence/turn-context";

export type RuntimeAnswerContract = {
  version: "runtime-answer-contract.v1";
  mode: "direct" | "evidence_envelope" | "claim_frame" | "proposal_receipt" | "write_receipt";
  sourceLayers: string[];
  incompleteScopes: string[];
  conflictingScopes: string[];
  successfulReads: string[];
  pendingProposals: string[];
  committedWrites: string[];
  constraints: string[];
};

function conflictingScopes(contract: TurnEvidenceContract): string[] {
  const statuses = new Map<string, Set<string>>();
  for (const observation of contract.evidenceSemantics.observations) {
    if (observation.authority !== "authoritative") continue;
    const key = `${observation.layer}:${observation.scope}:${observation.subject}:${observation.predicate}`;
    const values = statuses.get(key) ?? new Set<string>();
    values.add(observation.status);
    statuses.set(key, values);
  }
  return [...statuses].flatMap(([scope, values]) =>
    values.has("present") && values.has("absent") ? [scope] : []
  );
}

function toolSourceLayer(toolName: string): string | undefined {
  if (toolName.startsWith("external_")) return "external_provider";
  if (toolName === "listViewCards" || toolName === "readViewState" ||
      toolName === "locateObjectViews" ||
      toolName.startsWith("query_")) return "business_view";
  if ([
    "listLibrary",
    "inspectLibraryNodes",
    "previewLibraryFiles",
    "readLibraryCompilation",
    "openArtifacts",
    "openArtifactKnowledge",
  ].includes(toolName)) return "library";
  if (["searchMemory", "expandEvidence", "followObject"].includes(toolName)) {
    return "shared_brain";
  }
  if (toolName === "readSourceDocument") return "source_document";
  return undefined;
}

export function buildRuntimeAnswerContract(input: {
  evidence: TurnEvidenceContract;
  capabilities: CapabilityLedgerSnapshot;
}): RuntimeAnswerContract {
  const sourceLayers = [...new Set([
    ...input.evidence.coverageByScope.map((item) => item.layer),
    ...input.capabilities.successfulReads.flatMap((toolName) => {
      const layer = toolSourceLayer(toolName);
      return layer ? [layer] : [];
    }),
  ])];
  const incompleteScopes = input.evidence.coverageByScope.flatMap((item) =>
    item.coverage.level === "complete" ? [] : [`${item.layer}:${item.scope}`]
  );
  const conflicts = conflictingScopes(input.evidence);
  const mode: RuntimeAnswerContract["mode"] = input.capabilities.committedWrites.length
    ? "write_receipt"
    : input.capabilities.pendingProposals.length
      ? "proposal_receipt"
      : conflicts.length || sourceLayers.length > 1
        ? "claim_frame"
        : sourceLayers.length === 1
          ? "evidence_envelope"
          : "direct";
  const constraints = [
    ...(incompleteScopes.length
      ? ["覆盖不完整的 scope 不能支持全称否定或‘不存在’结论；只能说明本次未读到或仍未知。"]
      : []),
    ...(conflicts.length
      ? ["同一权威 scope 存在冲突观察；陈述当前观察与边界，不得猜测同步、权限、上传时间等冲突原因。"]
      : []),
    ...(input.capabilities.pendingProposals.length
      ? ["本轮成功生成的 Proposal 仍待用户审批，不得说成已经应用或写入正式状态。"]
      : []),
    ...(input.capabilities.committedWrites.length
      ? []
      : ["没有成功写入回执；不得声称已经保存、更新、启动、发布或归档。"]),
  ];
  return {
    version: "runtime-answer-contract.v1",
    mode,
    sourceLayers,
    incompleteScopes,
    conflictingScopes: conflicts,
    successfulReads: [...input.capabilities.successfulReads],
    pendingProposals: [...input.capabilities.pendingProposals],
    committedWrites: [...input.capabilities.committedWrites],
    constraints,
  };
}

export function runtimeAnswerContractInstruction(
  contract: RuntimeAnswerContract,
): string {
  if (
    !contract.successfulReads.length &&
    !contract.pendingProposals.length &&
    !contract.committedWrites.length
  ) return "";
  return [
    "【Runtime Answer Contract】",
    "这是运行时根据真实工具轨迹、Evidence 覆盖和副作用回执生成的回答边界，不是写作模板。",
    JSON.stringify(contract),
    "自然回答用户问题；只需遵守 constraints，不要向用户展示本协议字段。",
  ].join("\n");
}
