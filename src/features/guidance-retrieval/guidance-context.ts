import type { GuidanceSearchResult } from "./guidance-search";

export type GuidanceContextItem = {
  id: string;
  title: string;
  kind: GuidanceSearchResult["guideline"]["kind"];
  status: GuidanceSearchResult["guideline"]["status"];
  authority: "official" | "pending_confirmation";
  isMandatory: boolean;
  contentMarkdown: string;
  score: number;
};

export function buildGuidanceContext(
  results: readonly GuidanceSearchResult[],
  maxItems = 5,
): GuidanceContextItem[] {
  const safeMaxItems = Math.max(0, maxItems);

  return results
    .slice(0, safeMaxItems)
    .map((result) => ({
      id: result.guideline.id,
      title: result.guideline.title,
      kind: result.guideline.kind,
      status: result.guideline.status,
      authority:
        result.guideline.status === "published"
          ? "official"
          : "pending_confirmation",
      isMandatory: result.guideline.isMandatory,
      contentMarkdown: result.guideline.contentMarkdown,
      score: result.score,
    }));
}