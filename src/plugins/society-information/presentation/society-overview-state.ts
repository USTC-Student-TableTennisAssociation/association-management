import type { ViewReaction } from "@sydaris/plugin-sdk";

export type SocietyReactionTone =
  | "checking"
  | "verified"
  | "inform"
  | "attention"
  | "failed";

export type SocietyReactionPresentation = {
  label: string;
  tone: SocietyReactionTone;
};

export function presentSocietyReaction(
  reaction: ViewReaction | undefined,
): SocietyReactionPresentation | undefined {
  if (!reaction) return undefined;
  const active = reaction.attention.status === "queued" ||
    reaction.attention.status === "running" ||
    reaction.knowledge.status === "queued" ||
    reaction.knowledge.status === "running";
  if (active) return { label: "Echo 正在核对", tone: "checking" };
  if (
    reaction.attention.status === "failed" ||
    reaction.knowledge.status === "failed"
  ) {
    return { label: "核对暂不可用", tone: "failed" };
  }
  if (reaction.attention.status === "needs_confirmation") {
    return { label: "需要确认", tone: "attention" };
  }
  if (reaction.attention.status === "inform") {
    return { label: "Echo 有一条说明", tone: "inform" };
  }
  if (
    reaction.attention.status === "silent" ||
    reaction.knowledge.status === "completed"
  ) {
    return { label: "已核对", tone: "verified" };
  }
  return undefined;
}

function reactionPriority(reaction: ViewReaction): number {
  const presentation = presentSocietyReaction(reaction);
  const tonePriority = presentation?.tone === "attention"
    ? 5
    : presentation?.tone === "failed"
    ? 4
    : presentation?.tone === "inform"
    ? 3
    : presentation?.tone === "checking"
    ? 2
    : presentation?.tone === "verified"
    ? 1
    : 0;
  return (reaction.seenAt ? 0 : 10) + tonePriority;
}

export function reactionsByCard(
  reactions: readonly ViewReaction[],
): ReadonlyMap<string, ViewReaction> {
  const byCard = new Map<string, ViewReaction>();
  for (const reaction of reactions) {
    for (const target of reaction.targets) {
      const current = byCard.get(target.cardId);
      if (!current || reactionPriority(reaction) > reactionPriority(current)) {
        byCard.set(target.cardId, reaction);
      }
    }
  }
  return byCard;
}

export function projectedActivityIndex(input: {
  centers: readonly number[];
  startIndex: number;
  deltaX: number;
  velocityX: number;
}): number {
  const { centers, startIndex, deltaX, velocityX } = input;
  if (!centers.length || startIndex < 0 || startIndex >= centers.length) return startIndex;
  const decelerationRate = 0.99;
  const projectedTravel = (velocityX / 1_000) * decelerationRate / (1 - decelerationRate);
  const projectedCenter = centers[startIndex] + deltaX + projectedTravel;
  return centers.reduce((closest, center, index) =>
    Math.abs(center - projectedCenter) < Math.abs(centers[closest] - projectedCenter)
      ? index
      : closest
  , startIndex);
}

export function galleryEdges(input: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): { atStart: boolean; atEnd: boolean } {
  const tolerance = 2;
  return {
    atStart: input.scrollLeft <= tolerance,
    atEnd: input.scrollLeft + input.clientWidth >= input.scrollWidth - tolerance,
  };
}
