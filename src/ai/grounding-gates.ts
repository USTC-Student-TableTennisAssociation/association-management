import { allCitedRefs } from "@/ai/citation-refs";
import type { ChatPageContext } from "@/ai/types";
import { EvidenceLedger } from "@/evidence/ledger";
import type { EvidenceSemantics } from "@/evidence/types";
import type {
  EvidenceCoverage,
  EvidenceCoverageByLayer,
  EvidenceLayer,
} from "@/memory/types";

const DOCUMENT_NOUN_PATTERN =
  /(操作手册|手册|指南|文档|文件|报告|方案|申请表|通知|规程|制度)/u;
const DOCUMENT_ANALYSIS_PATTERN =
  /(分析|看看|看一下|阅读|审阅|评价|评估|复杂|简化|修改|重写|改写|优化|总结|概括|内容|说了什么|怎么完成|如何完成|为什么|问题|准备什么|怎么做|如何做|步骤|要求|流程)/u;
const EVIDENCE_BOUNDARY_PATTERN =
  /(无法|不能确认|尚未|缺少|仅能|只能|部分|证据不足|未覆盖|未读取|没有读取|没有匹配|未找到|不能替代|不足以)/u;
const ARTIFACT_METADATA_PATTERN =
  /(路径\s*[:：]|处理状态|处理档位|发布到\s*Shared Brain|尚未发布|已发布|资料库.{0,12}(?:找到|未找到|存在|没有|匹配)|文件名\s*(?:为|是)|目录项|catalog|coarse|deep|ready|\d+\s*条\s*Assertion|\d+\s*个\s*Object)/iu;
const BUSINESS_VIEW_PATTERN =
  /(业务视角|业务视图|正式视图|正式\s*View|Business\s*View|Activity\s*Operations|正式\s*Card|业务卡片)/iu;
const SHARED_BRAIN_PATTERN =
  /(Shared\s*Brain|Assertion|Higher\s*Memory|GlobalObject|组织记忆)/iu;
const DEICTIC_CONTINUATION_PATTERN =
  /(这个|那个|它|这里|刚才|上面|前面|我说的是|不是说|所以|那现在|清楚吗|看不到)/u;
const BUSINESS_VIEW_ACTION_PATTERN =
  /(?:请|帮我|需要|把|将|能否|可以).{0,20}(?:新增|添加|修改|更新|改成|写入|收录|建立|创建|删除|补建)/u;
const BUSINESS_VIEW_ABSENCE_ACK_PATTERN =
  /(?:没有.{0,50}(?:Card|卡片|条目|收录|内容)|(?:未|尚未|暂未).{0,30}(?:收录|建立|创建)|(?:0|零)\s*个?\s*(?:Card|卡片|条目)|(?:正式\s*View|业务视角).{0,30}(?:是空的|为空|看不到)|看不到.{0,30}(?:内容|Card|卡片|条目))/iu;

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
};

type ArtifactSearchObservation = {
  queryTitle: string;
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
    objectName: string;
    contentDimensions?: Array<{
      ref?: string;
      contentMarkdown?: string | null;
      isMissing?: boolean;
    }>;
  }>;
  coverage?: EvidenceCoverage;
  semantics: EvidenceSemantics;
};

/** Request-local evidence contract. Tool observations can only strengthen it. */
export class GroundingState {
  private readonly queryKey: string;
  private readonly pageContext?: ChatPageContext;
  private primaryArtifactQueryKey?: string;
  private primaryArtifactQuery?: string;
  private targetSearchRef?: string;
  private readonly targetNodeIds = new Set<string>();
  private targetLocated = false;
  private targetReadable = false;
  private readonly coverageByLayer: EvidenceCoverageByLayer = {};
  private readonly evidenceLedger = new EvidenceLedger();
  private businessView?: BusinessViewGrounding;

  readonly targetKind: GroundingTargetKind;
  readonly requiresReadableTarget: boolean;
  readonly businessViewActionRequested: boolean;

  constructor(
    query: string,
    pageContext?: ChatPageContext,
    conversation: Array<{ role: "user" | "assistant"; text: string }> = [],
  ) {
    this.queryKey = searchable(query);
    this.pageContext = pageContext;
    const userTurns = conversation
      .filter((message) => message.role === "user")
      .map((message) => message.text);
    if (userTurns.at(-1)?.trim() === query.trim()) userTurns.pop();
    const recentUserContext = userTurns.slice(-3).join("\n");
    const currentBusinessTarget = BUSINESS_VIEW_PATTERN.test(query);
    const inheritedBusinessTarget = DEICTIC_CONTINUATION_PATTERN.test(query) &&
      BUSINESS_VIEW_PATTERN.test(recentUserContext);
    // Page location is only a routing hint. It must never turn an otherwise
    // general design/affordance question into a mandatory Business View read.
    this.targetKind = currentBusinessTarget || inheritedBusinessTarget
      ? "business_view"
      : SHARED_BRAIN_PATTERN.test(query)
        ? "shared_brain"
        : DOCUMENT_NOUN_PATTERN.test(query)
          ? "artifact"
          : "general";
    this.businessViewActionRequested = this.targetKind === "business_view" &&
      BUSINESS_VIEW_ACTION_PATTERN.test(query);
    const documentAnalysis = DOCUMENT_NOUN_PATTERN.test(query) &&
      DOCUMENT_ANALYSIS_PATTERN.test(query);
    this.requiresReadableTarget = this.targetKind === "artifact" && documentAnalysis;
    if (
      this.requiresReadableTarget &&
      pageContext?.activePresentation === "library" &&
      pageContext.activeNodeId
    ) {
      this.targetNodeIds.add(pageContext.activeNodeId);
      this.targetLocated = true;
    }
  }

  observeCoverage(layer: EvidenceLayer, coverage: EvidenceCoverage | undefined): void {
    if (coverage) this.coverageByLayer[layer] = coverageCopy(coverage);
  }

  observeSemantics(semantics: EvidenceSemantics | undefined): void {
    this.evidenceLedger.record(semantics);
  }

  observeArtifactSearch(result: ArtifactSearchObservation): void {
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
      : titleKey.length >= 4 && this.queryKey.includes(titleKey);
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
      card.contentDimensions?.some((dimension) =>
        !dimension.isMissing && Boolean(dimension.contentMarkdown?.trim())
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
    };
  }

  instruction(): string {
    const contract = this.contract();
    const lines = [
      "服务端 Grounding Contract：引用与明确来源主张会经过校验；证据覆盖缺口会被标注，但不会仅因页面位置或检索不完整而整体替换回答。",
      "只能引用本轮工具真实返回的 [V#]/[A#]/[H#]/[S#]/[F#]。F# 只证明资料库查询或文件元数据，不能证明文件正文。",
    ];
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
    if (
      ARTIFACT_METADATA_PATTERN.test(segment) &&
      !refs.some((ref) => ref.startsWith("F") && input.validRefs.has(ref))
    ) {
      issues.push("artifact_claim_without_f_ref");
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
    const acknowledgesAbsence = BUSINESS_VIEW_ABSENCE_ACK_PATTERN.test(text);
    if (!viewRefCited || !acknowledgesAbsence) {
      const deterministicText = businessViewAbsentAnswer(
        input.contract.businessView,
        validRefs,
      );
      if (deterministicText) {
        return {
          text: deterministicText,
          changed: deterministicText !== text,
          mode: "deterministic_answer",
          issues: [
            !viewRefCited
              ? "business_view_absence_without_view_ref"
              : "business_view_absence_not_acknowledged",
          ],
        };
      }
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

  if (
    coverage?.level === "partial" &&
    !EVIDENCE_BOUNDARY_PATTERN.test(text)
  ) {
    issues.push("coverage_boundary_missing");
    const missing = coverage.missingAspects.length
      ? `未覆盖：${coverage.missingAspects.join("；")}`
      : "本轮只获得了部分可验证证据";
    notices.push(`${missing}；不要把未覆盖部分理解为 Echo 当前事实。`);
  }

  const redaction = redactUnsupportedClaims({ text, validRefs });
  issues.push(...redaction.issues);

  if (
    input.contract.requiresReadableTarget &&
    !EVIDENCE_BOUNDARY_PATTERN.test(redaction.text) &&
    !allCitedRefs(redaction.text).some((ref) =>
      /^(?:A|S|V)\d+$/.test(ref) && validRefs.has(ref)
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
    mode: redaction.redactedCount ? "redacted" : changed ? "annotated" : "passed",
    issues: unique(issues),
  };
}
