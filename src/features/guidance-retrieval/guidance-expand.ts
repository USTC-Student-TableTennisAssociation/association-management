import type {
  GuidanceGraphLinkInput,
  GuidanceGraphNodeInput,
} from "../guidance-inspector/guidance-types";
import type { GuidanceSearchResult } from "./guidance-search";

export type ExpandedGuidanceResult = {
  guideline: GuidanceGraphNodeInput;
  source: "search" | "relation";
  score: number;
  matchedTerms: readonly string[];
  relation: GuidanceGraphLinkInput | null;
};

export type ExpandGuidanceOptions = {
  maxRelatedItems?: number;
};

export function expandGuidanceResults(
  searchResults: readonly GuidanceSearchResult[],
  guidelines: readonly GuidanceGraphNodeInput[],
  links: readonly GuidanceGraphLinkInput[],
  options: ExpandGuidanceOptions = {},
): ExpandedGuidanceResult[] {
  const guidelineById = new Map(
    guidelines.map((guideline) => [guideline.id, guideline]),
  );

  const maxRelatedItems = Math.max(
    0,
    options.maxRelatedItems ?? Number.POSITIVE_INFINITY,
  );

  const addedGuidelineIds = new Set<string>();
  const expandedResults: ExpandedGuidanceResult[] = [];
  let relatedItemCount = 0;

  for (const result of searchResults) {
    if (addedGuidelineIds.has(result.guideline.id)) {
      continue;
    }

    expandedResults.push({
      ...result,
      source: "search",
      relation: null,
    });

    addedGuidelineIds.add(result.guideline.id);
  }

  for (const result of searchResults) {
    if (relatedItemCount >= maxRelatedItems) {
      break;
    }

    for (const link of links) {
      if (relatedItemCount >= maxRelatedItems) {
        break;
      }

      let relatedGuidelineId: string | null = null;

      if (link.fromGuidelineId === result.guideline.id) {
        relatedGuidelineId = link.toGuidelineId;
      } else if (link.toGuidelineId === result.guideline.id) {
        relatedGuidelineId = link.fromGuidelineId;
      }

      if (
        relatedGuidelineId === null ||
        addedGuidelineIds.has(relatedGuidelineId)
      ) {
        continue;
      }

      const relatedGuideline = guidelineById.get(relatedGuidelineId);

      if (!relatedGuideline) {
        continue;
      }

      expandedResults.push({
        guideline: relatedGuideline,
        source: "relation",
        score: 0,
        matchedTerms: [],
        relation: link,
      });

      addedGuidelineIds.add(relatedGuidelineId);
      relatedItemCount += 1;
    }
  }

  return expandedResults;
}

//这个文件实现的是：保留检索结果；关联一层卡片；去重；保留关系信息；限制关联卡片数量