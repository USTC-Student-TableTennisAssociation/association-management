export type TurnHandoff = {
  reviewNeeded: boolean;
  candidateQuotes: string[];
};

export type TurnHandoffResolution = {
  handoffIsValid: boolean;
  reviewNeeded: boolean;
  candidateQuotes: string[];
  reviewSource: "handoff" | "missing_or_invalid";
};

/**
 * Accept only an explicit, internally consistent handoff whose evidence is
 * copied verbatim from the current user message. The runtime deliberately
 * does not guess whether natural language is a question or a statement.
 */
export function resolveTurnHandoff(input: {
  handoff?: TurnHandoff;
  currentUserText: string;
}): TurnHandoffResolution {
  const handoffIsValid = Boolean(
    input.handoff &&
      input.handoff.candidateQuotes.every((quote) =>
        input.currentUserText.includes(quote)
      ) &&
      (input.handoff.reviewNeeded
        ? input.handoff.candidateQuotes.length > 0
        : input.handoff.candidateQuotes.length === 0),
  );

  if (!handoffIsValid) {
    return {
      handoffIsValid: false,
      reviewNeeded: false,
      candidateQuotes: [],
      reviewSource: "missing_or_invalid",
    };
  }

  return {
    handoffIsValid: true,
    reviewNeeded: Boolean(input.handoff?.reviewNeeded),
    candidateQuotes: input.handoff?.candidateQuotes ?? [],
    reviewSource: "handoff",
  };
}
