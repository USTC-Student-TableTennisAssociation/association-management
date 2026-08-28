import type {
  BusinessInvariant,
  ViewCardState,
  ViewTransaction,
} from "@sydaris/plugin-sdk";

function text(card: ViewCardState, key: string): string | undefined {
  const value = card.dimensions[key];
  return typeof value === "string" ? value : undefined;
}

function cardLabel(card: ViewCardState): string {
  return text(card, "name") ?? `${card.cardTypeKey} ${card.id}`;
}

function ownershipCounts(cards: readonly ViewCardState[], slotKey: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const card of cards) {
    for (const childId of card.slots[slotKey] ?? []) {
      counts.set(childId, (counts.get(childId) ?? 0) + 1);
    }
  }
  return counts;
}

function requireExactlyOneOwner(
  cards: readonly ViewCardState[],
  counts: ReadonlyMap<string, number>,
  ownerLabel: string,
): void {
  for (const card of cards) {
    const count = counts.get(card.id) ?? 0;
    if (count !== 1) {
      throw new Error(`${cardLabel(card)} 必须属于且只属于一个${ownerLabel}，当前为 ${count}`);
    }
  }
}

function assertAcyclic(cards: readonly ViewCardState[], slotKey: string, label: string): void {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (card: ViewCardState): void => {
    if (visiting.has(card.id)) throw new Error(`${label}依赖不能形成循环：${cardLabel(card)}`);
    if (visited.has(card.id)) return;
    visiting.add(card.id);
    for (const dependencyId of card.slots[slotKey] ?? []) {
      const dependency = byId.get(dependencyId);
      if (dependency) visit(dependency);
    }
    visiting.delete(card.id);
    visited.add(card.id);
  };
  for (const card of cards) visit(card);
}

const runtimeOwnership: BusinessInvariant = {
  key: "activity.runtime_cards_have_one_parent",
  description: "每个运行中的 Work Package、Task、Assignment 和 Milestone 都必须有且只有一个业务父级。",
  async validate(transaction: ViewTransaction) {
    const cards = await transaction.queryCards();
    const activities = cards.filter((card) => card.cardTypeKey === "ActivityCard");
    const workPackages = cards.filter((card) => card.cardTypeKey === "WorkPackageCard");
    const tasks = cards.filter((card) => card.cardTypeKey === "TaskCard");
    const assignments = cards.filter((card) => card.cardTypeKey === "AssignmentCard");
    const milestones = cards.filter((card) => card.cardTypeKey === "MilestoneCard");

    requireExactlyOneOwner(
      workPackages,
      ownershipCounts(activities, "work_packages"),
      " Activity",
    );
    requireExactlyOneOwner(tasks, ownershipCounts(workPackages, "tasks"), " Work Package");
    requireExactlyOneOwner(
      assignments,
      ownershipCounts(
        cards.filter((card) => [
          "ActivityCard",
          "WorkPackageCard",
          "TaskCard",
          "PurchaseCard",
          "ReimbursementCard",
        ].includes(card.cardTypeKey)),
        "assignments",
      ),
      "支持分工的工作项",
    );
    requireExactlyOneOwner(
      milestones,
      ownershipCounts([...activities, ...workPackages], "milestones"),
      " Activity 或 Work Package",
    );
  },
};

const completionConsistency: BusinessInvariant = {
  key: "activity.completion_matches_children",
  description: "已完成的 Activity 不能仍有活跃工作包，已完成的工作包不能仍有活跃任务。",
  async validate(transaction: ViewTransaction) {
    const cards = await transaction.queryCards();
    const byId = new Map(cards.map((card) => [card.id, card]));
    const inactive = new Set(["COMPLETED", "CANCELLED"]);

    for (const workPackage of cards.filter((card) => card.cardTypeKey === "WorkPackageCard")) {
      if (text(workPackage, "status") !== "COMPLETED") continue;
      const activeTask = (workPackage.slots.tasks ?? [])
        .map((cardId) => byId.get(cardId))
        .find((task) => task && !inactive.has(text(task, "status") ?? "NOT_STARTED"));
      if (activeTask) {
        throw new Error(`工作包“${cardLabel(workPackage)}”仍有未结束任务“${cardLabel(activeTask)}”，不能标记为已完成`);
      }
    }

    for (const activity of cards.filter((card) => card.cardTypeKey === "ActivityCard")) {
      if (text(activity, "status") !== "COMPLETED") continue;
      const activeWorkPackage = (activity.slots.work_packages ?? [])
        .map((cardId) => byId.get(cardId))
        .find((workPackage) =>
          workPackage && !inactive.has(text(workPackage, "status") ?? "NOT_STARTED")
        );
      if (activeWorkPackage) {
        throw new Error(`Activity“${cardLabel(activity)}”仍有未结束工作包“${cardLabel(activeWorkPackage)}”，不能标记为已结束`);
      }
    }
  },
};

const dependencyGraph: BusinessInvariant = {
  key: "activity.dependencies_are_acyclic",
  description: "Work Package 和 Task 的前置依赖不能形成循环。",
  async validate(transaction: ViewTransaction) {
    const cards = await transaction.queryCards();
    assertAcyclic(
      cards.filter((card) => card.cardTypeKey === "WorkPackageCard"),
      "dependencies",
      "工作包",
    );
    assertAcyclic(
      cards.filter((card) => card.cardTypeKey === "TaskCard"),
      "dependencies",
      "任务",
    );
  },
};

const playbookStructure: BusinessInvariant = {
  key: "activity.playbook_structure_is_consistent",
  description: "每个指南步骤只能属于一个 Playbook，流程连线不能越过 Playbook 边界。",
  async validate(transaction: ViewTransaction) {
    const cards = await transaction.queryCards();
    const playbooks = cards.filter((card) => card.cardTypeKey === "ActivityPlaybookCard");
    const nodes = cards.filter((card) => card.cardTypeKey === "GuideNodeCard");
    requireExactlyOneOwner(nodes, ownershipCounts(playbooks, "nodes"), " Playbook");

    for (const playbook of playbooks) {
      const nodeIds = new Set(playbook.slots.nodes ?? []);
      for (const startNodeId of playbook.slots.start_nodes ?? []) {
        if (!nodeIds.has(startNodeId)) throw new Error(`${cardLabel(playbook)} 的起点不属于该 Playbook`);
      }
      for (const node of nodes.filter(({ id }) => nodeIds.has(id))) {
        for (const targetId of [
          ...(node.slots.next ?? []),
          ...(node.slots.when_yes ?? []),
          ...(node.slots.when_no ?? []),
        ]) {
          if (!nodeIds.has(targetId)) {
            throw new Error(`${cardLabel(node)} 的后续步骤越过了 Playbook 边界`);
          }
        }
      }
      const nodeById = new Map(nodes.filter(({ id }) => nodeIds.has(id)).map((node) => [node.id, node]));
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (node: ViewCardState): void => {
        if (visiting.has(node.id)) {
          throw new Error(`${cardLabel(playbook)} 的步骤连接不能形成循环：${cardLabel(node)}`);
        }
        if (visited.has(node.id)) return;
        visiting.add(node.id);
        for (const targetId of [
          ...(node.slots.next ?? []),
          ...(node.slots.when_yes ?? []),
          ...(node.slots.when_no ?? []),
        ]) {
          const target = nodeById.get(targetId);
          if (target) visit(target);
        }
        visiting.delete(node.id);
        visited.add(node.id);
      };
      for (const node of nodeById.values()) visit(node);
    }
  },
};

const nestedPlaybooksAreAcyclic: BusinessInvariant = {
  key: "activity.nested_playbooks_are_acyclic",
  description: "嵌套的 Playbook 不能直接或间接包含自身。",
  async validate(transaction: ViewTransaction) {
    const cards = await transaction.queryCards();
    const playbooks = cards.filter((card) => card.cardTypeKey === "ActivityPlaybookCard");
    const byId = new Map(playbooks.map((card) => [card.id, card]));
    const cardById = new Map(cards.map((card) => [card.id, card]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (playbook: ViewCardState): void => {
      if (visiting.has(playbook.id)) {
        throw new Error(`Playbook 嵌套不能形成循环：${cardLabel(playbook)}`);
      }
      if (visited.has(playbook.id)) return;
      visiting.add(playbook.id);
      for (const nodeId of playbook.slots.nodes ?? []) {
        const node = cardById.get(nodeId);
        for (const nestedId of node?.slots.subplaybook ?? []) {
          const nested = byId.get(nestedId);
          if (nested) visit(nested);
        }
      }
      visiting.delete(playbook.id);
      visited.add(playbook.id);
    };
    for (const playbook of playbooks) visit(playbook);
  },
};

const assignmentUniqueness: BusinessInvariant = {
  key: "activity.assignment_is_unique_per_target",
  description: "同一个人物 Object 在同一工作项上只能有一份 Assignment。",
  async validate(transaction: ViewTransaction) {
    const cards = await transaction.queryCards();
    const byId = new Map(cards.map((card) => [card.id, card]));
    for (const target of cards) {
      const seen = new Set<string>();
      for (const assignmentId of target.slots.assignments ?? []) {
        const assignment = byId.get(assignmentId);
        const objectId = assignment?.relatedObjectIds[0];
        if (!objectId) continue;
        if (seen.has(objectId)) {
          throw new Error(`${cardLabel(target)} 中同一人物存在重复工作分配`);
        }
        seen.add(objectId);
      }
    }
  },
};

export const activityOperationsInvariants: readonly BusinessInvariant[] = [
  runtimeOwnership,
  completionConsistency,
  dependencyGraph,
  playbookStructure,
  nestedPlaybooksAreAcyclic,
  assignmentUniqueness,
];
