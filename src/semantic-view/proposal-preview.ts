import type {
  SemanticViewFocus,
  ViewProposalPresentation,
} from "@/semantic-view/types";

export function proposalChangeFocus(
  change: ViewProposalPresentation["changes"][number],
): SemanticViewFocus {
  if (change.type === "CREATE_CARD") {
    return { proposalCardSelector: change.cardSelector };
  }
  return {
    ...(change.cardId ? { cardId: change.cardId } : {}),
    proposalCardSelector: change.cardSelector,
    ...(change.type === "SET_CONTENT_DIMENSION"
      ? { dimensionName: change.dimensionName }
      : { slotKey: change.slotKey }),
  };
}
