export type TurnHandoff = {
  reviewNeeded: boolean;
  candidateQuotes: string[];
};

export type TurnHandoffResolution = {
  handoffIsValid: boolean;
  reviewNeeded: boolean;
  candidateQuotes: string[];
  reviewSource: "handoff" | "fallback";
};

export function resolveTurnHandoff(input: {
  handoff?: TurnHandoff;
  currentUserText: string;
}): TurnHandoffResolution {
  const handoffIsValid = Boolean(
    input.handoff &&
      input.handoff.candidateQuotes.every((quote) => input.currentUserText.includes(quote)) &&
      (input.handoff.reviewNeeded
        ? input.handoff.candidateQuotes.length > 0
        : input.handoff.candidateQuotes.length === 0),
  );

  if (handoffIsValid) {
    return {
      handoffIsValid: true,
      reviewNeeded: Boolean(input.handoff?.reviewNeeded),
      candidateQuotes: input.handoff?.candidateQuotes ?? [],
      reviewSource: "handoff",
    };
  }

  return {
    handoffIsValid: false,
    reviewNeeded: true,
    candidateQuotes: [],
    reviewSource: "fallback",
  };
}
