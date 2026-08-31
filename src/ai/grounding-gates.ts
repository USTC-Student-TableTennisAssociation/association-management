import { allCitedRefs } from "@/ai/citation-refs";
import type { ChatPageContext } from "@/ai/types";
import { EvidenceLedger } from "@/evidence/ledger";
import type { EvidenceSemantics } from "@/evidence/types";
import type {
  EvidenceCoverage,
  EvidenceCoverageByLayer,
  EvidenceLayer,
} from "@/memory/types";

function searchable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/\.[a-z0-9]{1,10}$/iu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function coverageCopy(coverage: EvidenceCoverage): EvidenceCoverage {
  return {
    level: coverage.level,
    missingAspects: unique(coverage.missingAspects.map((item) => item.trim()).filter(Boolean)),
    ...(coverage.observationComplete === undefined
      ? {}
      : { observationComplete: coverage.observationComplete }),
    ...(coverage.contentPresence === undefined
      ? {}
      : { contentPresence: coverage.contentPresence }),
  };
}

function coverageMapCopy(input: EvidenceCoverageByLayer): EvidenceCoverageByLayer {
  return Object.fromEntries(
    Object.entries(input).map(([layer, coverage]) => [layer, coverageCopy(coverage)]),
  ) as EvidenceCoverageByLayer;
}

export type GroundingTargetKind =
  | "artifact"
  | "business_view"
  | "shared_brain"
  | "general";

export type BusinessViewGrounding = {
  ref: string;
  viewKey: string;
  viewLabel: string;
  totalCardCount: number;
  targetHints: string[];
  contentPresence: "present" | "absent" | "unknown";
  observationComplete: boolean;
};

export type GroundingContract = {
  targetKind: GroundingTargetKind;
  requiresReadableTarget: boolean;
  targetLabel?: string;
  targetLocated: boolean;
  targetReadable: boolean;
  targetSearchRef?: string;
  coverageByLayer: EvidenceCoverageByLayer;
  evidenceSemantics: EvidenceSemantics;
  businessView?: BusinessViewGrounding;
  businessViewActionRequested: boolean;
  knowledgeInventoryObserved?: boolean;
  memoryProvenance: {
    durableWriteCommitted: boolean;
    actorPrivateMemoryGrounded: boolean;
  };
};

type ArtifactSearchObservation = {
  queryTitle: string;
  purpose?: "locate" | "read" | "analyze";
  ref?: string;
  matchedCount?: number;
  truncated?: boolean;
  items: Array<{
    nodeId: string;
    name: string;
    matchKind?: string;
    ref?: string;
  }>;
};

type BusinessContextObservation = {
  view: {
    ref: string;
    viewKey: string;
    viewLabel: string;
    totalCardCount: number;
  };
  targetHints: string[];
  relevantCards: Array<{
    ref?: string;
    dimensions: Readonly<Record<string, unknown>>;
  }>;
  coverage?: EvidenceCoverage;
  semantics: EvidenceSemantics;
};

/** Request-local evidence contract. Tool observations can only strengthen it. */
export class GroundingState {
  private readonly activeLibraryNodeId?: string;
  private primaryArtifactQueryKey?: string;
  private primaryArtifactQuery?: string;
  private targetSearchRef?: string;
  private readonly targetNodeIds = new Set<string>();
  private targetLocated = false;
  private targetReadable = false;
  private readonly coverageByLayer: EvidenceCoverageByLayer = {};
  private readonly evidenceLedger = new EvidenceLedger();
  private businessView?: BusinessViewGrounding;
  private knowledgeInventoryObserved = false;
  private durableMemoryWriteCommitted = false;
  private actorPrivateMemoryGrounded = false;

  private targetKind: GroundingTargetKind = "general";
  private requiresReadableTarget = false;
  private businessViewActionRequested = false;

  constructor(
    _query: string,
    pageContext?: ChatPageContext,
  ) {
    this.activeLibraryNodeId = pageContext?.activePresentation === "library"
      ? pageContext.activeNodeId
      : undefined;
  }

  observeCoverage(layer: EvidenceLayer, coverage: EvidenceCoverage | undefined): void {
    if (coverage) this.coverageByLayer[layer] = coverageCopy(coverage);
  }

  observeSemantics(semantics: EvidenceSemantics | undefined): void {
    this.evidenceLedger.record(semantics);
  }

  observeKnowledgeInventory(): void {
    this.knowledgeInventoryObserved = true;
  }

  observeSharedBrainTarget(): void {
    if (this.targetKind === "general") this.targetKind = "shared_brain";
  }

  observeBusinessViewActionRequest(): void {
    this.businessViewActionRequested = true;
  }

  observeDurableMemoryWrite(): void {
    this.durableMemoryWriteCommitted = true;
  }

  observeActorPrivateMemory(): void {
    this.actorPrivateMemoryGrounded = true;
  }

  observeArtifactSearch(result: ArtifactSearchObservation): void {
    if (this.targetKind === "general" || result.purpose === "analyze") {
      this.targetKind = "artifact";
    }
    if (result.purpose === "read" || result.purpose === "analyze") {
      this.requiresReadableTarget = true;
      if (this.activeLibraryNodeId) {
        this.targetNodeIds.add(this.activeLibraryNodeId);
        this.targetLocated = true;
      }
    }
    const queryKey = searchable(result.queryTitle);
    if (!this.primaryArtifactQueryKey) {
      this.primaryArtifactQueryKey = queryKey;
      this.primaryArtifactQuery = result.queryTitle.trim();
      this.targetSearchRef = result.ref;
    }
    this.observeCoverage("library", {
      level: result.truncated ? "partial" : "complete",
      missingAspects: result.truncated ? ["资料库标题查询仍有未返回结果。"] : [],
      observationComplete: !result.truncated,
      contentPresence: (result.matchedCount ?? result.items.length) > 0
        ? "present"
        : result.truncated
          ? "unknown"
          : "absent",
    });
    const alignedWithPrimary = Boolean(
      queryKey && this.primaryArtifactQueryKey &&
      (queryKey.includes(this.primaryArtifactQueryKey) ||
        this.primaryArtifactQueryKey.includes(queryKey)),
    );
    if (!alignedWithPrimary) return;
    for (const item of result.items) {
      if (item.matchKind !== "exact_title") continue;
      this.targetNodeIds.add(item.nodeId);
      this.targetLocated = true;
    }
  }

  observeArtifactKnowledge(input: {
    nodeId: string;
    assertionCount: number;
    coverage?: EvidenceCoverage;
  }): void {
    this.observeCoverage("library", input.coverage);
    if (!this.targetNodeIds.has(input.nodeId)) return;
    this.targetLocated = true;
    if (input.assertionCount > 0) this.targetReadable = true;
  }

  observeLibraryPreview(input: {
    items: Array<{ id?: string; nodeId?: string; available?: boolean }>;
  }): void {
    for (const item of input.items) {
      const nodeId = item.nodeId ?? item.id;
      if (nodeId && item.available === true && this.targetNodeIds.has(nodeId)) {
        this.targetLocated = true;
        this.targetReadable = true;
        this.observeCoverage("library", {
          level: "complete",
          missingAspects: [],
          observationComplete: true,
          contentPresence: "present",
        });
      }
    }
  }

  observeSourceDocument(input: {
    document: { title: string };
    blocks: unknown[];
  }): void {
    if (!input.blocks.length) return;
    const titleKey = searchable(input.document.title);
    const targetKey = this.primaryArtifactQueryKey;
    const aligned = targetKey
      ? titleKey.includes(targetKey) || targetKey.includes(titleKey)
      : false;
    if (!aligned) return;
    this.targetLocated = true;
    this.targetReadable = true;
    this.observeCoverage("source_document", {
      level: "complete",
      missingAspects: [],
      observationComplete: true,
      contentPresence: "present",
    });
  }

  observeBusinessContext(input: BusinessContextObservation): void {
    if (!this.requiresReadableTarget) this.targetKind = "business_view";
    this.observeCoverage("business_view", input.coverage);
    this.observeSemantics(input.semantics);
    const membership = input.semantics.observations.find((observation) =>
      observation.layer === "business_view" &&
      observation.predicate === "contains_matching_card"
    );
    this.businessView = {
      ref: input.view.ref,
      viewKey: input.view.viewKey,
      viewLabel: input.view.viewLabel,
      totalCardCount: input.view.totalCardCount,
      targetHints: unique(input.targetHints.map((hint) => hint.trim()).filter(Boolean)),
      contentPresence: membership?.status ?? input.coverage?.contentPresence ?? "unknown",
      observationComplete: membership?.completeness === "complete" ||
        input.coverage?.observationComplete === true,
    };
    if (this.targetKind !== "business_view") return;
    const relevantCards = input.relevantCards;
    if (!relevantCards.length) return;
    this.targetLocated = true;
    if (relevantCards.some((card) =>
      Object.values(card.dimensions).some((value) =>
        value !== undefined && value !== null && value !== ""
      )
    )) {
      this.targetReadable = true;
    }
  }

  contract(): GroundingContract {
    return {
      targetKind: this.targetKind,
      requiresReadableTarget: this.requiresReadableTarget,
      ...(this.primaryArtifactQuery ? { targetLabel: this.primaryArtifactQuery } : {}),
      targetLocated: this.targetLocated,
      targetReadable: this.targetReadable,
      ...(this.targetSearchRef ? { targetSearchRef: this.targetSearchRef } : {}),
      coverageByLayer: coverageMapCopy(this.coverageByLayer),
      evidenceSemantics: this.evidenceLedger.snapshot(),
      ...(this.businessView ? { businessView: { ...this.businessView } } : {}),
      businessViewActionRequested: this.businessViewActionRequested,
      knowledgeInventoryObserved: this.knowledgeInventoryObserved,
      memoryProvenance: {
        durableWriteCommitted: this.durableMemoryWriteCommitted,
        actorPrivateMemoryGrounded: this.actorPrivateMemoryGrounded,
      },
    };
  }

  instruction(): string {
    const contract = this.contract();
    const lines = [
      "服务端 Grounding Contract：引用与明确来源主张会经过校验；证据覆盖缺口会被标注，但不会仅因页面位置或检索不完整而整体替换回答。",
      "只能引用本轮工具真实返回的 [V#]/[A#]/[H#]/[S#]/[F#]。F# 只证明资料库查询或文件元数据，不能证明文件正文。",
    ];
    if (contract.knowledgeInventoryObserved) {
      lines.push(
        "知识环境库存门：本轮已完成分层库存盘点；可直接报告工具返回的精确总量，但不得把库存总量解释为已读取具体正文。",
      );
    }
    lines.push(
      contract.memoryProvenance.durableWriteCommitted
        ? "长期记忆写入状态：本轮已观察到同步写入成功；只能依据成功 Tool Result 描述实际写入范围。"
        : "长期记忆写入状态：本轮尚未观察到同步写入成功；不得声称已经记住、写入或归档。",
      contract.memoryProvenance.actorPrivateMemoryGrounded
        ? "Actor 私有记忆状态：当前 Actor 已有可验证的私有 Higher Memory 或本轮同步修订成功；只能按真实 scope 描述。"
        : "Actor 私有记忆状态：当前没有可验证的 Actor 私有 Higher Memory；不得承诺私人称呼或约定已经跨会话、跨用户隔离生效。",
    );
    if (contract.requiresReadableTarget) {
      lines.push(
        contract.targetReadable
          ? "目标证据门：已读取到目标内容；分析结论必须引用支撑它的正文/Assertion/View 证据。"
          : "目标证据门：尚未读取到目标内容。相关文件或相邻资料不能替代目标；最终只能说明边界，不得分析、推测或给出目标正文结论。",
      );
    }
    if (contract.targetKind === "business_view" && !contract.businessView) {
      lines.push(
        "Business View 目标门：尚未读取正式 View。回答其收录状态或表达清晰度前必须调用 openBusinessContext。",
      );
    }
    const coverageEntries = Object.entries(contract.coverageByLayer);
    if (coverageEntries.length) {
      lines.push("分层覆盖状态：");
      for (const [layer, coverage] of coverageEntries) {
        lines.push(
          `- ${layer}: ${coverage.level}; presence=${coverage.contentPresence ?? "unknown"}; ` +
            `observationComplete=${coverage.observationComplete ?? "unknown"}` +
            (coverage.missingAspects.length
              ? `；缺少：${coverage.missingAspects.join("；")}`
              : ""),
        );
      }
    }
    const answerability = contract.evidenceSemantics.answerability.slice(-8);
    if (answerability.length) {
      lines.push("工具已经建立的可回答性（描述已完成的读取，不是后续检索计划）：");
      for (const item of answerability) {
        lines.push(
          `- ${item.status}: ${item.question}；${item.reason}` +
            (item.refs.length ? ` [${item.refs.join("][")}]` : ""),
        );
      }
    }
    if (
      contract.targetKind === "business_view" &&
      !contract.businessViewActionRequested &&
      contract.businessView?.observationComplete &&
      contract.businessView.contentPresence === "absent"
    ) {
      lines.push(
        "Business View 空状态是已验证的完整否定结果，不是检索失败。最终回答必须明确说明能看到正式 View、但没有匹配 Card，不得用相关 Shared Brain 内容冒充正式 View。",
      );
    }
    return lines.join("\n");
  }
}

export type GroundingAudit = {
  text: string;
  changed: boolean;
  mode: "passed" | "annotated" | "redacted" | "safe_fallback" | "deterministic_answer";
  issues: string[];
};

function withKnownSearchCitation(
  sentence: string,
  contract: GroundingContract,
  validRefs: Set<string>,
): string {
  return contract.targetSearchRef && validRefs.has(contract.targetSearchRef)
    ? `${sentence} [${contract.targetSearchRef}]`
    : sentence;
}

function targetFallback(contract: GroundingContract, validRefs: Set<string>): string {
  const target = contract.targetLabel ? `“${contract.targetLabel}”` : "你指定的当前资料";
  const status = contract.targetLocated
    ? `本轮虽然在资料库中定位到了${target}，但没有读取到足以支持分析的正文或已发布知识。`
    : `本轮没有在资料库中精确定位并读取到${target}。`;
  return withKnownSearchCitation(
    `${status} 检索到的其他文件或相关资料只能作为背景，不能替代目标正文；因此我现在不能可靠分析它的内容、复杂度或当前版本。请指定准确文件，或先完成该文件的解析/发布后再试。`,
    contract,
    validRefs,
  );
}

function primaryCoverage(contract: GroundingContract): EvidenceCoverage | undefined {
  switch (contract.targetKind) {
    case "artifact":
      return contract.coverageByLayer.library ?? contract.coverageByLayer.source_document;
    case "business_view":
      return contract.coverageByLayer.business_view;
    case "shared_brain":
      return contract.coverageByLayer.shared_brain;
    case "general": {
      const observed = Object.values(contract.coverageByLayer);
      return observed.length === 1 ? observed[0] : undefined;
    }
  }
}

function businessViewAbsentAnswer(
  view: BusinessViewGrounding,
  validRefs: Set<string>,
): string | undefined {
  if (!validRefs.has(view.ref)) return undefined;
  const target = view.targetHints.length
    ? `“${view.targetHints.slice(0, 2).join("、")}”`
    : "用户所指业务";
  const state = view.totalCardCount === 0
    ? `当前共有 0 个 Card，正式 View 目前是空的`
    : `当前共有 ${view.totalCardCount} 个 Card，但没有匹配${target}的 Card`;
  return [
    `我能看到 ${view.viewLabel} 业务视角。本轮读取的是完整的正式 View：${state} [${view.ref}]。`,
    `因此现在无法评价${target}在业务视角里“写得清不清楚”——它不是已有条目表述不清，而是尚未作为正式业务条目收录。Shared Brain 或资料库中的相关内容只能用于后续补建，不能冒充当前 Business View。`,
  ].join("\n\n");
}

function citationFallback(issues: string[]): string {
  return `这次生成的回答没有通过证据引用校验（${issues.join("；")}），因此未发送其中未经验证的结论。请重新检索后再回答。`;
}

function boundaryNotice(message: string): string {
  return `> 证据边界：${message}`;
}

function redactUnsupportedClaims(input: {
  text: string;
  validRefs: ReadonlySet<string>;
}): { text: string; issues: string[]; redactedCount: number } {
  const issues: string[] = [];
  let redactedCount = 0;
  // Keep citations immediately following punctuation attached to the claim
  // they support, so redaction cannot leave the prose behind and remove only
  // its invalid [V#]/[A#]/... token.
  const segments = input.text.match(
    /[^。！？!?\n]+[。！？!?](?:\s*(?:\[(?:A|F|H|S|V)\d+\]|【(?:A|F|H|S|V)\d+】))*|[^。！？!?\n]+|\n+/gu,
  ) ?? [input.text];
  const kept = segments.map((segment) => {
    if (!segment.trim()) return segment;
    const refs = allCitedRefs(segment);
    const unknownRefs = refs.filter((ref) => !input.validRefs.has(ref));
    if (unknownRefs.length) {
      issues.push(`unknown_refs:${unique(unknownRefs).join(",")}`);
      redactedCount += 1;
      return "";
    }
    return segment;
  });
  return {
    text: kept.join("").replace(/\n{3,}/gu, "\n\n").trim(),
    issues: unique(issues),
    redactedCount,
  };
}

/**
 * Final server-side grounding audit.
 *
 * Hard replacement is reserved for high-confidence provenance failures: an
 * explicitly requested document was not read, or document analysis has no
 * content citation at all. Coverage gaps and an unopened Business View are
 * rendered as boundaries, while invalid citation-bearing claims are removed
 * locally so unrelated useful prose survives.
 */
export function auditGroundedAnswer(input: {
  text: string;
  contract: GroundingContract;
  validRefs: Iterable<string>;
}): GroundingAudit {
  const text = input.text.trim();
  const validRefs = new Set(input.validRefs);
  const issues: string[] = [];
  const notices: string[] = [];

  if (
    input.contract.targetKind === "business_view" &&
    !input.contract.businessViewActionRequested &&
    input.contract.businessView?.observationComplete &&
    input.contract.businessView.contentPresence === "absent"
  ) {
    const viewRefCited = allCitedRefs(text).includes(input.contract.businessView.ref) &&
      validRefs.has(input.contract.businessView.ref);
    const deterministicText = businessViewAbsentAnswer(
      input.contract.businessView,
      validRefs,
    );
    if (deterministicText && deterministicText !== text) {
      return {
        text: deterministicText,
        changed: true,
        mode: "deterministic_answer",
        issues: [viewRefCited
          ? "business_view_absence_normalized"
          : "business_view_absence_without_view_ref"],
      };
    }
    if (!deterministicText) {
      issues.push("business_view_ref_unavailable");
    }
  }

  if (
    input.contract.targetKind === "business_view" &&
    !input.contract.businessView?.observationComplete
  ) {
    issues.push("business_view_not_read");
    notices.push(
      "本轮没有读取正式 Business View；下面只能作为一般设计说明或基于用户已给信息的建议，不能代表当前 View 已收录的正式状态。",
    );
  }

  if (input.contract.requiresReadableTarget && !input.contract.targetReadable) {
    issues.push("target_not_readable");
    return {
      text: targetFallback(input.contract, validRefs),
      changed: true,
      mode: "safe_fallback",
      issues,
    };
  }

  const coverage = primaryCoverage(input.contract);
  if (coverage?.level === "insufficient") {
    issues.push("coverage_insufficient");
    const missing = coverage.missingAspects.length
      ? `仍缺少：${coverage.missingAspects.join("；")}`
      : "现有检索尚不足以覆盖问题的关键事实";
    notices.push(`${missing}；下面超出已引用证据的内容只能作为一般性说明。`);
  }

  if (coverage?.level === "partial") {
    issues.push("coverage_boundary_missing");
    const missing = coverage.missingAspects.length
      ? `未覆盖：${coverage.missingAspects.join("；")}`
      : "本轮只获得了部分可验证证据";
    notices.push(`${missing}；不要把未覆盖部分理解为 Sydaris 当前事实。`);
  }

  const redaction = redactUnsupportedClaims({
    text,
    validRefs,
  });
  issues.push(...redaction.issues);

  if (
    input.contract.requiresReadableTarget &&
    !allCitedRefs(redaction.text).some((ref) =>
      ["A", "S", "V"].some((prefix) => ref.startsWith(prefix)) && validRefs.has(ref)
    )
  ) {
    return {
      text: citationFallback(["target_analysis_without_content_ref"]),
      changed: true,
      mode: "safe_fallback",
      issues: unique([...issues, "target_analysis_without_content_ref"]),
    };
  }

  if (!redaction.text) {
    return {
      text: citationFallback(redaction.issues),
      changed: true,
      mode: "safe_fallback",
      issues: unique(issues),
    };
  }

  if (redaction.redactedCount) {
    notices.push(`已省略 ${redaction.redactedCount} 处使用无效引用或缺少正确来源引用的事实主张。`);
  }
  const auditedText = notices.length
    ? `${notices.map(boundaryNotice).join("\n\n")}\n\n${redaction.text}`
    : redaction.text;
  const changed = auditedText !== text;
  return {
    text: auditedText,
    changed,
    mode: redaction.redactedCount
      ? "redacted"
      : changed
        ? "annotated"
        : "passed",
    issues: unique(issues),
  };
}
