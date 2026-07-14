import type { GuidanceGraphNodeInput } from "../guidance-inspector/guidance-types";

export type GuidanceSearchResult = {
  guideline: GuidanceGraphNodeInput;
  score: number;
  matchedTerms: readonly string[];
};

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "");
}

function createSearchTerms(question: string): string[] {
  const normalizedQuestion = normalizeText(question);
  const terms = new Set<string>();

  for (let index = 0; index < normalizedQuestion.length - 1; index += 1) {
    terms.add(normalizedQuestion.slice(index, index + 2));
  }

  return [...terms];
}

export function searchGuidelines(
  question: string,
  guidelines: readonly GuidanceGraphNodeInput[],
): GuidanceSearchResult[] {
  const searchTerms = createSearchTerms(question);

  return guidelines
    .map((guideline) => {
      const normalizedTitle = normalizeText(guideline.title);
      const normalizedContent = normalizeText(guideline.contentMarkdown);

      const matchedTerms = searchTerms.filter(
        (term) =>
          normalizedTitle.includes(term) ||
          normalizedContent.includes(term),
      );

      const score = matchedTerms.reduce((total, term) => {
        const titleScore = normalizedTitle.includes(term) ? 3 : 0;
        const contentScore = normalizedContent.includes(term) ? 1 : 0;

        return total + titleScore + contentScore;
      }, 0);

      return {
        guideline,
        score,
        matchedTerms,
      };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score);
}