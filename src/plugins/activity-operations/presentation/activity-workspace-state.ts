import type { ViewReaction, ViewCardState } from "@sydaris/plugin-sdk";
import type { ViewSnapshot } from "@sydaris/plugin-sdk/react";

export type MethodEdge = {
  id: string;
  from: string;
  to: string;
  branch: "NEXT" | "YES" | "NO";
};

export type GuideNodeModel = {
  card: ViewCardState;
  definition?: ViewCardState;
  taskDefinitions: readonly ViewCardState[];
  nestedPlaybook?: ViewCardState;
  edges: readonly MethodEdge[];
};

export type PlaybookModel = {
  card: ViewCardState;
  nodes: readonly GuideNodeModel[];
  lanes: readonly string[];
  startNodeIds: ReadonlySet<string>;
};

export type TaskMapTask = {
  card: ViewCardState;
  assignments: readonly ViewCardState[];
  dependencies: readonly ViewCardState[];
};

export type TaskMapPackage = {
  card: ViewCardState;
  assignments: readonly ViewCardState[];
  dependencies: readonly ViewCardState[];
  tasks: readonly TaskMapTask[];
};

export type ActivityStudioModel = {
  playbooks: readonly PlaybookModel[];
  playbook?: PlaybookModel;
  activities: readonly ViewCardState[];
  activity?: ViewCardState;
  workPackages: readonly TaskMapPackage[];
  selectedCard?: ViewCardState;
  metrics: { completed: number; total: number; blocked: number; overdue: number; unassigned: number };
};

export function text(card: ViewCardState | undefined, key: string): string | undefined {
  const value = card?.dimensions[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberValue(card: ViewCardState | undefined, key: string): number | undefined {
  const value = card?.dimensions[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function cardsInSlot(card: ViewCardState | undefined, slotKey: string, cardsById: ReadonlyMap<string, ViewCardState>): ViewCardState[] {
  return (card?.slots[slotKey] ?? []).flatMap((cardId) => {
    const target = cardsById.get(cardId);
    return target ? [target] : [];
  });
}

function activityRank(card: ViewCardState): number {
  const status = text(card, "status") ?? "PLANNING";
  return status === "RUNNING" ? 0 : status === "PLANNING" ? 1 : status === "WRAP_UP" ? 2 : 3;
}

function playbookRank(card: ViewCardState): number {
  const status = text(card, "status") ?? "DRAFT";
  return status === "READY" ? 0 : status === "DRAFT" ? 1 : 2;
}

function edgesFor(node: ViewCardState): MethodEdge[] {
  return [
    ...(node.slots.next ?? []).map((to) => ({ id: `${node.id}:NEXT:${to}`, from: node.id, to, branch: "NEXT" as const })),
    ...(node.slots.when_yes ?? []).map((to) => ({ id: `${node.id}:YES:${to}`, from: node.id, to, branch: "YES" as const })),
    ...(node.slots.when_no ?? []).map((to) => ({ id: `${node.id}:NO:${to}`, from: node.id, to, branch: "NO" as const })),
  ];
}

function playbookModels(snapshot: ViewSnapshot, cardsById: ReadonlyMap<string, ViewCardState>): PlaybookModel[] {
  const nestedPlaybookIds = new Set(
    snapshot.cards
      .filter((card) => card.cardTypeKey === "GuideNodeCard")
      .flatMap((card) => card.slots.subplaybook ?? []),
  );
  return snapshot.cards
    .filter((card) => card.cardTypeKey === "ActivityPlaybookCard")
    .sort((left, right) =>
      Number(nestedPlaybookIds.has(left.id)) - Number(nestedPlaybookIds.has(right.id)) ||
      playbookRank(left) - playbookRank(right) ||
      (text(left, "name") ?? "").localeCompare(text(right, "name") ?? "", "zh-CN")
    )
    .map((playbook) => {
      const rawLanes = (text(playbook, "lanes") ?? "").split(/[，,\n]/).map((lane) => lane.trim()).filter(Boolean);
      const nodeCards = cardsInSlot(playbook, "nodes", cardsById);
      const discoveredLanes = nodeCards.flatMap((node) => text(node, "lane") ? [text(node, "lane")!] : []);
      const needsGeneralLane = !rawLanes.length || nodeCards.some((node) => !text(node, "lane"));
      const lanes = [...new Set([
        ...rawLanes,
        ...discoveredLanes,
        ...(needsGeneralLane ? ["通用"] : []),
      ])];
      const laneRank = new Map(lanes.map((lane, index) => [lane, index]));
      const nodes = nodeCards
        .sort((left, right) => {
          const lane = (laneRank.get(text(left, "lane") ?? "通用") ?? lanes.length) - (laneRank.get(text(right, "lane") ?? "通用") ?? lanes.length);
          const row = (numberValue(left, "row") ?? Number.MAX_SAFE_INTEGER) - (numberValue(right, "row") ?? Number.MAX_SAFE_INTEGER);
          return lane || row || (text(left, "name") ?? "").localeCompare(text(right, "name") ?? "", "zh-CN");
        })
        .map((node): GuideNodeModel => {
          const definition = cardsInSlot(node, "definition", cardsById)[0];
          return {
            card: node,
            definition,
            taskDefinitions: cardsInSlot(definition, "tasks", cardsById),
            nestedPlaybook: cardsInSlot(node, "subplaybook", cardsById)[0],
            edges: edgesFor(node),
          };
        });
      return { card: playbook, nodes, lanes, startNodeIds: new Set(playbook.slots.start_nodes ?? []) };
    });
}

function activityForFocus(activities: readonly ViewCardState[], cardsById: ReadonlyMap<string, ViewCardState>, focusCardId: string | undefined): ViewCardState | undefined {
  if (!focusCardId) return undefined;
  for (const activity of activities) {
    if (activity.id === focusCardId) return activity;
    for (const workPackage of cardsInSlot(activity, "work_packages", cardsById)) {
      if (workPackage.id === focusCardId || Object.values(workPackage.slots).flat().includes(focusCardId)) return activity;
      for (const task of cardsInSlot(workPackage, "tasks", cardsById)) {
        if (task.id === focusCardId || Object.values(task.slots).flat().includes(focusCardId)) return activity;
      }
    }
  }
  return undefined;
}

function playbookForFocus(playbooks: readonly PlaybookModel[], focusCardId: string | undefined): PlaybookModel | undefined {
  if (!focusCardId) return undefined;
  return playbooks.find(({ card, nodes }) => card.id === focusCardId || nodes.some(({ card: node, definition, taskDefinitions }) =>
    node.id === focusCardId || definition?.id === focusCardId || taskDefinitions.some(({ id }) => id === focusCardId)
  ));
}

function isActive(card: ViewCardState): boolean {
  const status = text(card, "status") ?? "NOT_STARTED";
  return status !== "COMPLETED" && status !== "CANCELLED";
}

export function buildActivityStudio(snapshot: ViewSnapshot, options: {
  selectedActivityId?: string;
  selectedPlaybookId?: string;
  selectedCardId?: string;
  focusCardId?: string;
  today?: string;
} = {}): ActivityStudioModel {
  const cardsById = new Map(snapshot.cards.map((card) => [card.id, card]));
  const playbooks = playbookModels(snapshot, cardsById);
  const activities = snapshot.cards
    .filter((card) => card.cardTypeKey === "ActivityCard")
    .sort((left, right) => activityRank(left) - activityRank(right) || (text(left, "name") ?? "").localeCompare(text(right, "name") ?? "", "zh-CN"));
  const playbook = playbookForFocus(playbooks, options.focusCardId) ?? playbooks.find(({ card }) => card.id === options.selectedPlaybookId) ?? playbooks[0];
  const activity = activityForFocus(activities, cardsById, options.focusCardId) ?? activities.find(({ id }) => id === options.selectedActivityId) ?? activities[0];
  const workPackages = activity ? cardsInSlot(activity, "work_packages", cardsById).map((workPackage): TaskMapPackage => ({
    card: workPackage,
    assignments: cardsInSlot(workPackage, "assignments", cardsById),
    dependencies: cardsInSlot(workPackage, "dependencies", cardsById),
    tasks: cardsInSlot(workPackage, "tasks", cardsById).map((task): TaskMapTask => ({
      card: task,
      assignments: cardsInSlot(task, "assignments", cardsById),
      dependencies: cardsInSlot(task, "dependencies", cardsById),
    })),
  })) : [];
  const workCards = workPackages.flatMap((workPackage) => [workPackage.card, ...workPackage.tasks.map(({ card }) => card)]);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  return {
    playbooks,
    playbook,
    activities,
    activity,
    workPackages,
    selectedCard: options.selectedCardId ? cardsById.get(options.selectedCardId) : undefined,
    metrics: {
      completed: workCards.filter((card) => text(card, "status") === "COMPLETED").length,
      total: workCards.length,
      blocked: workCards.filter((card) => text(card, "status") === "BLOCKED").length,
      overdue: workCards.filter((card) => {
        const deadline = text(card, "deadline");
        return Boolean(deadline && deadline < today && isActive(card));
      }).length,
      unassigned: workCards.filter((card) => !(card.slots.assignments ?? []).length && isActive(card)).length,
    },
  };
}

export function ownerNames(assignments: readonly ViewCardState[], objectNames: ReadonlyMap<string, string>): string[] {
  return assignments.flatMap((assignment) => {
    const objectId = assignment.relatedObjectIds[0];
    return objectId ? [objectNames.get(objectId) ?? "待确认"] : [];
  });
}

export type ActivityReactionTone = "checking" | "attention" | "inform" | "failed" | "verified";

export function reactionTone(reaction: ViewReaction | undefined): ActivityReactionTone | undefined {
  if (!reaction) return undefined;
  if (reaction.attention.status === "queued" || reaction.attention.status === "running" || reaction.knowledge.status === "queued" || reaction.knowledge.status === "running") return "checking";
  if (reaction.attention.status === "failed" || reaction.knowledge.status === "failed") return "failed";
  if (reaction.attention.status === "needs_confirmation") return "attention";
  if (reaction.attention.status === "inform") return "inform";
  if (reaction.attention.status === "silent" || reaction.knowledge.status === "completed") return "verified";
  return undefined;
}

function reactionPriority(reaction: ViewReaction): number {
  const tone = reactionTone(reaction);
  const priority = tone === "attention" ? 5 : tone === "failed" ? 4 : tone === "inform" ? 3 : tone === "checking" ? 2 : 1;
  return (reaction.seenAt ? 0 : 10) + priority;
}

export function reactionsByCard(reactions: readonly ViewReaction[]): ReadonlyMap<string, ViewReaction> {
  const byCard = new Map<string, ViewReaction>();
  for (const reaction of reactions) {
    for (const target of reaction.targets) {
      const current = byCard.get(target.cardId);
      if (!current || reactionPriority(reaction) > reactionPriority(current)) byCard.set(target.cardId, reaction);
    }
  }
  return byCard;
}
