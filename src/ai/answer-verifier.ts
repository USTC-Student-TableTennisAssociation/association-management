import { allCitedRefs } from "@/ai/citation-refs";
import type { TurnEvidenceContract } from "@/evidence/turn-context";

export type AnswerVerificationViolation = {
  code:
    | "empty_answer"
    | "unknown_reference"
    | "target_not_readable"
    | "target_analysis_without_content_reference"
    | "view_state_without_reference";
  message: string;
  excerpt?: string;
  refs?: string[];
};

export type AnswerVerification = {
  accepted: boolean;
  violations: AnswerVerificationViolation[];
  warnings: string[];
};

function claimSegments(text: string): string[] {
  return (text.match(
    /[^。！？!?\n]+[。！？!?](?:\s*(?:\[(?:A|F|H|S|V)\d+\]|【(?:A|F|H|S|V)\d+】))*|[^。！？!?\n]+/gu,
  ) ?? [text]).map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Claim-scoped validation only. This verifier never authors or replaces the
 * user's answer; repair is a separate model step driven by these diagnostics.
 */
export function verifyGroundedAnswer(input: {
  text: string;
  contract: TurnEvidenceContract;
  validRefs: Iterable<string>;
}): AnswerVerification {
  const text = input.text.trim();
  const validRefs = new Set(input.validRefs);
  const violations: AnswerVerificationViolation[] = [];
  const warnings = input.contract.coverageByScope.flatMap((entry) =>
    entry.coverage.level === "complete"
      ? []
      : [`${entry.layer}/${entry.scope} 覆盖为 ${entry.coverage.level}` +
        (entry.coverage.missingAspects.length
          ? `：${entry.coverage.missingAspects.join("；")}`
          : "")]
  );

  if (!text) {
    violations.push({
      code: "empty_answer",
      message: "模型没有生成最终正文。",
    });
  }

  for (const segment of claimSegments(text)) {
    const unknownRefs = allCitedRefs(segment).filter((ref) => !validRefs.has(ref));
    if (!unknownRefs.length) continue;
    violations.push({
      code: "unknown_reference",
      message: `这段内容使用了本轮不存在的引用：${unknownRefs.join("、")}`,
      excerpt: segment.slice(0, 500),
      refs: unknownRefs,
    });
  }

  if (input.contract.requiresReadableTarget && !input.contract.targetReadable) {
    violations.push({
      code: "target_not_readable",
      message:
        `用户指定的目标${input.contract.targetLabel
          ? `“${input.contract.targetLabel}”`
          : ""}没有被读取到；不能分析其正文或当前内容。`,
    });
  }

  if (
    input.contract.requiresReadableTarget &&
    input.contract.targetReadable &&
    !allCitedRefs(text).some((ref) =>
      ["A", "S", "V"].some((prefix) => ref.startsWith(prefix)) && validRefs.has(ref)
    )
  ) {
    violations.push({
      code: "target_analysis_without_content_reference",
      message: "目标内容分析没有引用任何本轮真实读取的 Assertion、Source 或 View 状态。",
    });
  }

  if (
    input.contract.viewStateReads.length > 0 &&
    !allCitedRefs(text).some((ref) => ref.startsWith("V") && validRefs.has(ref))
  ) {
    violations.push({
      code: "view_state_without_reference",
      message: "回答使用了本轮正式 View 状态，但没有引用任何真实 [V#]。",
    });
  }

  return {
    accepted: violations.length === 0,
    violations,
    warnings,
  };
}

export function buildAnswerRepairPrompt(input: {
  originalText: string;
  verification: AnswerVerification;
  contract: TurnEvidenceContract;
  validRefs: readonly string[];
}): string {
  return [
    "请修正下面这份回答。保留所有不受影响且有用的内容，只修复列出的具体违规。",
    "不得发明新引用、工具结果或业务事实；证据不足的局部内容应明确说明未完成，而不是把整篇回答替换成某一条工具结果。",
    "只输出修正后的最终回答，不解释修正过程。",
    "",
    "违规：",
    JSON.stringify(input.verification.violations, null, 2),
    "",
    "可用引用：",
    input.validRefs.join("、") || "无",
    "",
    "Evidence Contract：",
    JSON.stringify(input.contract, null, 2),
    "",
    "原回答：",
    input.originalText,
  ].join("\n");
}

export function verificationFailureAnswer(
  verification: AnswerVerification,
): string {
  const reasons = verification.violations.map((violation) => violation.message);
  return [
    "本轮未完成：生成结果没有通过证据校验，修正后仍存在未解决的问题。",
    reasons.length ? `未解决：${reasons.join("；")}` : "未能生成可验证的最终正文。",
    "已停止发送未经验证的业务结论，可以重新发起请求继续完成。",
  ].join("\n\n");
}
