import type {
  GuidanceAnswer,
  GuidanceAnswerCitation,
} from "./guidance-answer";

export function parseGuidanceAnswer(
  rawText: string,
  allowedGuidelineIds: ReadonlySet<string>,
): GuidanceAnswer | null {
  const normalizedText = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;

  try {
    parsed = JSON.parse(normalizedText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;

  if (
    typeof candidate.answer !== "string" ||
    candidate.answer.trim().length === 0
  ) {
    return null;
  }

  if (!Array.isArray(candidate.citations)) {
    return null;
  }

  const citations: GuidanceAnswerCitation[] = [];
  const seenGuidelineIds = new Set<string>();

  for (const item of candidate.citations) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const citation = item as Record<string, unknown>;

    if (
      typeof citation.guidelineId !== "string" ||
      !allowedGuidelineIds.has(citation.guidelineId) ||
      typeof citation.reason !== "string" ||
      citation.reason.trim().length === 0
    ) {
      return null;
    }

    if (seenGuidelineIds.has(citation.guidelineId)) {
      continue;
    }

    citations.push({
      guidelineId: citation.guidelineId,
      reason: citation.reason.trim(),
    });

    seenGuidelineIds.add(citation.guidelineId);
  }

  const unresolved = Array.isArray(candidate.unresolved)
    ? candidate.unresolved
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  if (citations.length === 0 && unresolved.length === 0) {
    return null;
  }

  return {
    answer: candidate.answer.trim(),
    citations,
    unresolved,
  };
}