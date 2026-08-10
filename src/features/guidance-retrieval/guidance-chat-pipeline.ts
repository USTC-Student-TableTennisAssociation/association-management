import type {
  GuidanceGraphLinkInput,
  GuidanceGraphNodeInput,
} from "../guidance-inspector/guidance-types";
import {
  buildGuidanceContext,
  type GuidanceContextItem,
} from "./guidance-context";
import { expandGuidanceResults } from "./guidance-expand";
import { searchGuidelines } from "./guidance-search";

export type GuidanceChatPipelineOptions = {
  maxSearchItems?: number;
  maxRelatedItems?: number;
  maxContextItems?: number;
};

export function buildGuidanceChatContext(
  question: string,
  guidelines: readonly GuidanceGraphNodeInput[],
  links: readonly GuidanceGraphLinkInput[],
  options: GuidanceChatPipelineOptions = {},
): GuidanceContextItem[] {
  const maxSearchItems = Math.max(
    0,
    options.maxSearchItems ?? 3,
  );

  const searchResults = searchGuidelines(
    question,
    guidelines,
  ).slice(0, maxSearchItems);

  const expandedResults = expandGuidanceResults(
    searchResults,
    guidelines,
    links,
    {
      maxRelatedItems: options.maxRelatedItems ?? 2,
    },
  );

  return buildGuidanceContext(
    expandedResults,
    options.maxContextItems ?? 5,
  );
}
//这段代码的默认限制是：检索结果最多3条，关联卡片最多2条，最终上下文最多5条。