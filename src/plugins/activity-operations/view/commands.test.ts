import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import type { CommandDefinition, ViewCardState, ViewTransaction } from "@/contracts";
import { activityOperationsCommands } from "@/plugins/activity-operations/view/commands";
import { activityOperationsInvariants } from "@/plugins/activity-operations/view/invariants";

const objectId = "00000000-0000-4000-8000-000000000101";

function createActivityCommand(): CommandDefinition<Record<string, unknown>> {
  const command = activityOperationsCommands.find(
    (candidate) => candidate.key === "activity.create_activity",
  );
  if (!command) throw new Error("activity.create_activity command is missing");
  return command as CommandDefinition<Record<string, unknown>>;
}

function transactionFixture() {
  return {
    createCard: vi.fn().mockResolvedValue("00000000-0000-4000-8000-000000000201"),
  } as unknown as ViewTransaction;
}

async function executeCreateActivity(
  transaction: ViewTransaction,
  input: Record<string, unknown>,
) {
  const command = createActivityCommand();
  const parsed = command.inputSchema.parse(input);
  return command.execute({
    viewKey: "activity_operations",
    actor: { permissions: ["view.write"] },
    initiator: "human",
    transaction,
  }, parsed);
}

describe("activity.create_activity", () => {
  it("links a new ActivityCard to the supplied stable Object", async () => {
    const transaction = transactionFixture();

    await executeCreateActivity(transaction, {
      objectId,
      name: "Sydaris 验收赛",
      status: "PLANNING",
    });

    expect(transaction.createCard).toHaveBeenCalledWith(expect.objectContaining({
      cardTypeKey: "ActivityCard",
      relatedObjectIds: [objectId],
      dimensions: expect.objectContaining({ name: "Sydaris 验收赛", status: "PLANNING" }),
    }));
  });

  it("allows View-local Activity state without forcing a global Object anchor", async () => {
    const transaction = transactionFixture();

    await executeCreateActivity(transaction, { name: "人工录入活动" });

    expect(transaction.createCard).toHaveBeenCalledWith(expect.objectContaining({
      cardTypeKey: "ActivityCard",
      relatedObjectIds: [],
    }));
  });

  it("rejects a malformed Object ID before executing the command", () => {
    const command = createActivityCommand();

    expect(() => command.inputSchema.parse({
      objectId: "not-a-uuid",
      name: "Sydaris 验收赛",
    })).toThrow();
  });
});

class MemoryTransaction implements ViewTransaction {
  readonly cards = new Map<string, ViewCardState>();

  async getCard(cardId: string) {
    return this.cards.get(cardId);
  }

  async queryCards(query: { cardTypeKey?: string; relatedObjectId?: string } = {}) {
    return [...this.cards.values()].filter((card) =>
      (!query.cardTypeKey || card.cardTypeKey === query.cardTypeKey) &&
      (!query.relatedObjectId || card.relatedObjectIds.includes(query.relatedObjectId))
    );
  }

  async createCard(input: {
    cardTypeKey: string;
    dimensions?: Readonly<Record<string, unknown>>;
    relatedObjectIds?: readonly string[];
  }) {
    const id = randomUUID();
    this.cards.set(id, {
      id,
      viewKey: "activity_operations",
      cardTypeKey: input.cardTypeKey,
      dimensions: { ...(input.dimensions ?? {}) },
      slots: {},
      relatedObjectIds: [...(input.relatedObjectIds ?? [])],
    });
    return id;
  }

  async deleteCard(cardId: string) {
    this.cards.delete(cardId);
  }

  async setDimension(cardId: string, key: string, value: unknown) {
    const card = this.cards.get(cardId);
    if (!card) throw new Error("missing card");
    this.cards.set(cardId, { ...card, dimensions: { ...card.dimensions, [key]: value } });
  }

  async clearDimension(cardId: string, key: string) {
    const card = this.cards.get(cardId);
    if (!card) throw new Error("missing card");
    const dimensions = { ...card.dimensions };
    delete dimensions[key];
    this.cards.set(cardId, { ...card, dimensions });
  }

  async setSlot(cardId: string, key: string, targets: readonly string[]) {
    const card = this.cards.get(cardId);
    if (!card) throw new Error("missing card");
    this.cards.set(cardId, { ...card, slots: { ...card.slots, [key]: [...targets] } });
  }

  async setRelatedObjects(cardId: string, objectIds: readonly string[]) {
    const card = this.cards.get(cardId);
    if (!card) throw new Error("missing card");
    this.cards.set(cardId, { ...card, relatedObjectIds: [...objectIds] });
  }
}

function command(key: string): CommandDefinition<Record<string, unknown>> {
  const definition = activityOperationsCommands.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`missing ${key}`);
  return definition as CommandDefinition<Record<string, unknown>>;
}

async function execute(
  transaction: MemoryTransaction,
  key: string,
  input: Record<string, unknown>,
) {
  const definition = command(key);
  const result = await definition.execute({
    viewKey: "activity_operations",
    actor: { permissions: ["view.write"] },
    initiator: "human",
    transaction,
  }, definition.inputSchema.parse(input));
  for (const invariant of activityOperationsInvariants) await invariant.validate(transaction);
  return result;
}

async function initializeRuntime(transaction: MemoryTransaction) {
  const activity = await execute(transaction, "activity.create_activity", {
    name: "2026 继往开来杯",
    status: "PLANNING",
  });
  return (activity.summary as { cardId: string }).cardId;
}

describe("activity runtime operations", () => {
  it("creates and updates a Work Package inside one Activity", async () => {
    const transaction = new MemoryTransaction();
    const activityId = await initializeRuntime(transaction);
    const created = await execute(transaction, "activity.add_work_package", {
      activityId,
      name: "场地与审批",
      status: "NOT_STARTED",
      priority: "HIGH",
      deadline: "2026-09-01",
    });
    const workPackageId = (created.summary as { cardId: string }).cardId;

    await execute(transaction, "activity.update_work_package", {
      activityId,
      workPackageId,
      status: "IN_PROGRESS",
      progress: "已提交场地申请",
      deadline: null,
    });

    expect(transaction.cards.get(activityId)?.slots.work_packages).toEqual([workPackageId]);
    expect(transaction.cards.get(workPackageId)?.dimensions).toMatchObject({
      name: "场地与审批",
      status: "IN_PROGRESS",
      priority: "HIGH",
      progress: "已提交场地申请",
    });
    expect(transaction.cards.get(workPackageId)?.dimensions.deadline).toBeUndefined();
  });

  it("rejects updating a Work Package through another Activity", async () => {
    const transaction = new MemoryTransaction();
    const firstActivityId = await initializeRuntime(transaction);
    const second = await execute(transaction, "activity.create_activity", { name: "活动 B" });
    const secondActivityId = (second.summary as { cardId: string }).cardId;
    const created = await execute(transaction, "activity.add_work_package", {
      activityId: firstActivityId,
      name: "工作包 A",
    });
    const workPackageId = (created.summary as { cardId: string }).cardId;

    await expect(execute(transaction, "activity.update_work_package", {
      activityId: secondActivityId,
      workPackageId,
      status: "IN_PROGRESS",
    })).rejects.toThrow("不属于");
  });

  it("lets tasks carry owners and removes an obsolete task cleanly", async () => {
    const transaction = new MemoryTransaction();
    const activityId = await initializeRuntime(transaction);
    const workPackage = await execute(transaction, "activity.add_work_package", {
      activityId,
      name: "宣传与报名",
    });
    const workPackageId = (workPackage.summary as { cardId: string }).cardId;
    const task = await execute(transaction, "activity.add_task", {
      workPackageId,
      name: "发布报名通知",
      deadline: "2026-09-03",
    });
    const taskId = (task.summary as { cardId: string }).cardId;
    const assignment = await execute(transaction, "activity.assign_owner", {
      targetCardId: taskId,
      objectId,
      role: "主办",
    });
    const assignmentId = (assignment.summary as { cardId: string }).cardId;

    await expect(execute(transaction, "activity.assign_owner", {
      targetCardId: taskId,
      objectId,
    })).rejects.toThrow("已经承担");

    await execute(transaction, "activity.remove_task", {
      workPackageId,
      taskId,
      reason: "本届改为统一线上入口，不再单独发布",
    });

    expect(transaction.cards.has(taskId)).toBe(false);
    expect(transaction.cards.has(assignmentId)).toBe(false);
    expect(transaction.cards.get(workPackageId)?.slots.tasks).toEqual([]);
  });

  it("prevents completing a Work Package while one Task is still active", async () => {
    const transaction = new MemoryTransaction();
    const activityId = await initializeRuntime(transaction);
    const workPackage = await execute(transaction, "activity.add_work_package", {
      activityId,
      name: "报销",
    });
    const workPackageId = (workPackage.summary as { cardId: string }).cardId;
    await execute(transaction, "activity.add_task", {
      workPackageId,
      name: "补齐发票明细",
    });

    await expect(execute(transaction, "activity.update_work_package", {
      activityId,
      workPackageId,
      status: "COMPLETED",
    })).rejects.toThrow("仍有未结束任务");
  });
});

describe("activity organization methods", () => {
  it("turns an ordered Playbook into idempotent work packages, tasks and dependencies", async () => {
    const transaction = new MemoryTransaction();
    const activityId = await initializeRuntime(transaction);
    const playbookResult = await execute(transaction, "activity.create_playbook", {
      name: "标准校园活动",
      status: "DRAFT",
      lanes: "统筹,现场",
    });
    const playbookId = (playbookResult.summary as { cardId: string }).cardId;
    const firstResult = await execute(transaction, "activity.add_guide_node", {
      playbookId,
      name: "明确活动边界",
      nodeType: "ACTION",
      lane: "统筹",
      row: 0,
      expectedOutcome: "目标、规模与预算边界已确认",
      taskSuggestions: ["确认目标", "确认预算上限"],
    });
    const secondResult = await execute(transaction, "activity.add_guide_node", {
      playbookId,
      name: "落实现场方案",
      nodeType: "ACTION",
      lane: "现场",
      row: 1,
      taskSuggestions: ["确认场地"],
    });
    const firstNodeId = (firstResult.summary as { cardId: string }).cardId;
    const secondNodeId = (secondResult.summary as { cardId: string }).cardId;
    const endResult = await execute(transaction, "activity.add_guide_node", {
      playbookId,
      name: "活动方案可执行",
      nodeType: "END",
      lane: "统筹",
      row: 2,
    });
    const endNodeId = (endResult.summary as { cardId: string }).cardId;
    await execute(transaction, "activity.set_guide_edge", {
      playbookId,
      fromNodeId: firstNodeId,
      toNodeId: secondNodeId,
      branch: "NEXT",
      connected: true,
    });
    await execute(transaction, "activity.set_guide_edge", {
      playbookId,
      fromNodeId: secondNodeId,
      toNodeId: endNodeId,
      branch: "NEXT",
      connected: true,
    });
    await execute(transaction, "activity.update_playbook", {
      playbookId,
      status: "READY",
    });

    const applied = await execute(transaction, "activity.apply_playbook", { activityId, playbookId });
    const activity = transaction.cards.get(activityId)!;
    const packages = (activity.slots.work_packages ?? []).map((id) => transaction.cards.get(id)!);

    expect(applied.summary).toMatchObject({ createdWorkPackages: 2, createdTasks: 3 });
    expect(activity.slots.adopted_playbook).toEqual([playbookId]);
    expect(packages.map((item) => item.dimensions.name)).toEqual(["明确活动边界", "落实现场方案"]);
    expect(packages[1].slots.dependencies).toEqual([packages[0].id]);
    expect(packages[0].slots.tasks).toHaveLength(2);

    const secondApply = await execute(transaction, "activity.apply_playbook", { activityId, playbookId });
    expect(secondApply.summary).toMatchObject({ createdWorkPackages: 0, createdTasks: 0 });
    expect(transaction.cards.get(activityId)?.slots.work_packages).toHaveLength(2);
  });

  it("creates a complete reusable method graph atomically from local references", async () => {
    const transaction = new MemoryTransaction();
    const created = await execute(transaction, "activity.create_playbook_graph", {
      name: "大型活动标准方法",
      description: "组织一次跨团队大型活动的通用方法。",
      applicableScenario: "参与者多、周期长且需要正式审批的活动。",
      overview: "先明确边界，再判断是否需要额外审批，最后形成可执行方案。",
      lanes: ["统筹", "执行"],
      status: "READY",
      startNodeKeys: ["scope"],
      nodes: [{
        key: "scope",
        name: "明确活动边界",
        nodeType: "ACTION",
        lane: "统筹",
        guide: "确认目标、范围、约束与关键协作者。",
        requiredInformation: "活动目标与现有约束。",
        expectedOutcome: "形成经核对的活动边界说明。",
        workPackage: {
          description: "形成活动边界和初始约束。",
          tasks: [{
            key: "collect",
            name: "收集约束",
            deliverable: "约束清单完成",
          }, {
            key: "confirm",
            name: "确认边界",
            deliverable: "活动边界获得确认",
            dependsOnTaskKeys: ["collect"],
          }],
        },
      }, {
        key: "approval_check",
        name: "是否需要额外审批",
        nodeType: "DECISION",
        lane: "统筹",
        guide: "根据范围和风险判断审批要求。",
      }, {
        key: "approval",
        name: "完成额外审批",
        nodeType: "ACTION",
        lane: "执行",
        guide: "按要求提交材料并跟进结果。",
        expectedOutcome: "所需审批已经取得并可核验。",
        workPackage: {
          description: "取得活动所需的额外批准。",
          tasks: [{
            key: "submit",
            name: "提交审批材料",
            deliverable: "审批结果可查",
          }],
        },
      }, {
        key: "ready",
        name: "活动方案可执行",
        nodeType: "END",
        lane: "统筹",
        expectedOutcome: "方法所需的前置工作已经完成。",
      }],
      edges: [
        { fromNodeKey: "scope", toNodeKey: "approval_check", branch: "NEXT" },
        { fromNodeKey: "approval_check", toNodeKey: "approval", branch: "YES" },
        { fromNodeKey: "approval_check", toNodeKey: "ready", branch: "NO" },
        { fromNodeKey: "approval", toNodeKey: "ready", branch: "NEXT" },
      ],
    });

    expect(created.summary).toMatchObject({
      createdNodes: 4,
      createdWorkPackageDefinitions: 2,
      createdTaskDefinitions: 3,
    });
    const playbookId = (created.summary as { cardId: string }).cardId;
    const playbook = transaction.cards.get(playbookId)!;
    expect(playbook.dimensions).toMatchObject({
      name: "大型活动标准方法",
      status: "READY",
      lanes: "统筹\n执行",
    });
    expect(playbook.slots.nodes).toHaveLength(4);
    expect(playbook.slots.start_nodes).toHaveLength(1);
    expect([...transaction.cards.values()].filter(({ cardTypeKey }) =>
      cardTypeKey === "TaskDefinitionCard"
    )).toHaveLength(3);
  });

  it("expands a compact playbook blueprint into an atomic method graph", async () => {
    const transaction = new MemoryTransaction();
    const created = await execute(transaction, "activity.create_playbook_from_blueprint", {
      name: "大型活动方法",
      purpose: "把跨团队活动组织成可复用工作流。",
      appliesWhen: "活动需要正式审批和多人协作。",
      lanes: ["统筹", "执行"],
      startNodeKeys: ["scope"],
      nodes: [{
        key: "scope",
        name: "明确边界",
        nodeType: "ACTION",
        lane: "统筹",
        instruction: "确认目标、范围与约束。",
        doneWhen: "边界获得确认。",
        taskTemplates: [{
          name: "收集约束",
          deliverable: "约束清单",
        }, {
          name: "确认边界",
          deliverable: "边界说明",
          afterTaskIndexes: [0],
        }],
      }, {
        key: "ready",
        name: "可以执行",
        nodeType: "END",
        lane: "执行",
      }],
      edges: [{ fromNodeKey: "scope", toNodeKey: "ready", branch: "NEXT" }],
    });

    expect(created.summary).toMatchObject({
      createdNodes: 2,
      createdWorkPackageDefinitions: 1,
      createdTaskDefinitions: 2,
    });
    const tasks = [...transaction.cards.values()].filter(({ cardTypeKey }) =>
      cardTypeKey === "TaskDefinitionCard"
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[1].slots.dependencies).toEqual([tasks[0].id]);
  });

  it("rejects a method graph with an incomplete decision before execution", () => {
    const definition = command("activity.create_playbook_graph");
    expect(() => definition.inputSchema.parse({
      name: "不完整方法",
      description: "用于验证输入约束。",
      applicableScenario: "测试",
      overview: "测试",
      lanes: ["统筹"],
      startNodeKeys: ["decision"],
      nodes: [{
        key: "decision",
        name: "是否继续",
        nodeType: "DECISION",
        lane: "统筹",
      }, {
        key: "end",
        name: "结束",
        nodeType: "END",
        lane: "统筹",
      }],
      edges: [{ fromNodeKey: "decision", toNodeKey: "end", branch: "YES" }],
    })).toThrow(/YES 和 NO/);
  });

  it("rejects cyclic task-map dependencies", async () => {
    const transaction = new MemoryTransaction();
    const activityId = await initializeRuntime(transaction);
    const first = await execute(transaction, "activity.add_work_package", { activityId, name: "前期" });
    const second = await execute(transaction, "activity.add_work_package", { activityId, name: "现场" });
    const firstId = (first.summary as { cardId: string }).cardId;
    const secondId = (second.summary as { cardId: string }).cardId;
    await execute(transaction, "activity.set_work_package_dependency", {
      activityId,
      workPackageId: secondId,
      dependsOnWorkPackageId: firstId,
      connected: true,
    });

    await expect(execute(transaction, "activity.set_work_package_dependency", {
      activityId,
      workPackageId: firstId,
      dependsOnWorkPackageId: secondId,
      connected: true,
    })).rejects.toThrow("依赖不能形成循环");
  });

  it("rejects recursive nested Playbooks", async () => {
    const transaction = new MemoryTransaction();
    const first = await execute(transaction, "activity.create_playbook", { name: "主流程" });
    const second = await execute(transaction, "activity.create_playbook", { name: "子流程" });
    const firstId = (first.summary as { cardId: string }).cardId;
    const secondId = (second.summary as { cardId: string }).cardId;
    const firstNode = await execute(transaction, "activity.add_guide_node", { playbookId: firstId, name: "展开子流程", nodeType: "REFERENCE" });
    const secondNode = await execute(transaction, "activity.add_guide_node", { playbookId: secondId, name: "回到主流程", nodeType: "REFERENCE" });
    await execute(transaction, "activity.set_nested_playbook", {
      playbookId: firstId,
      nodeId: (firstNode.summary as { cardId: string }).cardId,
      nestedPlaybookId: secondId,
    });

    await expect(execute(transaction, "activity.set_nested_playbook", {
      playbookId: secondId,
      nodeId: (secondNode.summary as { cardId: string }).cardId,
      nestedPlaybookId: firstId,
    })).rejects.toThrow("嵌套不能形成循环");
  });
});
