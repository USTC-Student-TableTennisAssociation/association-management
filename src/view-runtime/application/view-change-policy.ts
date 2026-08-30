import type {
  DomainEventDefinition,
  ViewChange,
  ViewChangePolicy,
  ViewModule,
  ViewReactionAttentionPolicy,
  ViewReactionKnowledgePolicy,
  ViewReactionTarget,
  ViewReactionTiming,
} from "@sydaris/plugin-sdk";

export type ResolvedViewChangeReaction = {
  attention: ViewReactionAttentionPolicy;
  knowledge: ViewReactionKnowledgePolicy;
  timing: ViewReactionTiming;
  settleMs?: number;
  guidance: readonly string[];
};

const attentionRank: Record<ViewReactionAttentionPolicy, number> = {
  never: 0,
  evaluate: 1,
  always: 2,
};

const timingRank: Record<ViewReactionTiming, number> = {
  after_settle: 0,
  immediate: 1,
};

function cardType(view: ViewModule, cardTypeKey: string) {
  return view.schema.cardTypes.find((candidate) => candidate.key === cardTypeKey);
}

export function policyForViewChange(
  view: ViewModule,
  change: ViewChange,
): ViewChangePolicy | undefined {
  const definition = cardType(
    view,
    change.kind === "card_created" || change.kind === "card_deleted"
      ? change.card.cardTypeKey
      : change.cardTypeKey,
  );
  if (!definition) return undefined;
  switch (change.kind) {
    case "card_created":
    case "card_deleted":
      return definition.changePolicy;
    case "dimension":
      return definition.dimensions.find((candidate) =>
        candidate.key === change.dimensionKey
      )?.changePolicy ?? definition.changePolicy;
    case "slot":
      return definition.slots.find((candidate) => candidate.key === change.slotKey)
        ?.changePolicy ?? definition.changePolicy;
    case "related_objects":
      return definition.relatedObjects?.changePolicy ?? definition.changePolicy;
  }
}

function mergePolicy(
  resolved: ResolvedViewChangeReaction,
  policy: ViewChangePolicy | undefined,
): ResolvedViewChangeReaction {
  if (!policy) return resolved;
  const attention = attentionRank[policy.attention] > attentionRank[resolved.attention]
    ? policy.attention
    : resolved.attention;
  const knowledge = policy.knowledge === "reconcile" ? "reconcile" : resolved.knowledge;
  const timing = timingRank[policy.timing ?? "after_settle"] > timingRank[resolved.timing]
    ? policy.timing ?? "after_settle"
    : resolved.timing;
  const settleMs = policy.settleMs === undefined
    ? resolved.settleMs
    : resolved.settleMs === undefined
    ? policy.settleMs
    : Math.min(resolved.settleMs, policy.settleMs);
  const guidance = policy.guidance?.trim()
    ? [...new Set([...resolved.guidance, policy.guidance.trim()])]
    : resolved.guidance;
  return {
    attention,
    knowledge,
    timing,
    ...(settleMs === undefined ? {} : { settleMs }),
    guidance,
  };
}

export function resolveViewChangeReaction(input: {
  viewModule: ViewModule;
  changes: readonly ViewChange[];
  eventDefinitions: readonly DomainEventDefinition[];
}): ResolvedViewChangeReaction {
  let resolved: ResolvedViewChangeReaction = {
    attention: "never",
    knowledge: "none",
    timing: "after_settle",
    guidance: [],
  };
  input.changes.forEach((change) => {
    resolved = mergePolicy(resolved, policyForViewChange(input.viewModule, change));
  });
  input.eventDefinitions.forEach((definition) => {
    resolved = mergePolicy(resolved, definition.reaction);
  });
  return resolved;
}

export function resolveViewPostCommitReaction(input: {
  viewModule: ViewModule;
  changes: readonly ViewChange[];
  eventDefinitions: readonly DomainEventDefinition[];
  initiator: "human" | "ai" | "system";
}): ResolvedViewChangeReaction {
  const resolved = resolveViewChangeReaction(input);
  if (input.initiator === "human") return resolved;
  return { ...resolved, attention: "never" };
}

export function targetsForViewChanges(changes: readonly ViewChange[]): ViewReactionTarget[] {
  const targets = new Map<string, ViewReactionTarget>();
  changes.forEach((change) => {
    const target: ViewReactionTarget = change.kind === "card_created" || change.kind === "card_deleted"
      ? { kind: "card", cardId: change.card.id, cardTypeKey: change.card.cardTypeKey }
      : change.kind === "dimension"
      ? {
          kind: "dimension",
          cardId: change.cardId,
          cardTypeKey: change.cardTypeKey,
          dimensionKey: change.dimensionKey,
        }
      : change.kind === "slot"
      ? {
          kind: "slot",
          cardId: change.cardId,
          cardTypeKey: change.cardTypeKey,
          slotKey: change.slotKey,
        }
      : {
          kind: "related_objects",
          cardId: change.cardId,
          cardTypeKey: change.cardTypeKey,
        };
    targets.set(JSON.stringify(target), target);
  });
  return [...targets.values()];
}
