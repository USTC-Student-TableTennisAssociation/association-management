import { describe, expect, it } from "vitest";

import type { ViewCardState } from "@sydaris/plugin-sdk";
import type { EchoViewSnapshot } from "@sydaris/plugin-sdk/react";

import { buildActivityStudio, ownerNames } from "./activity-workspace-state";

let nextId = 1;
function card(cardTypeKey: string, dimensions: Record<string, unknown> = {}, slots: Record<string, readonly string[]> = {}, relatedObjectIds: readonly string[] = []): ViewCardState {
  return {
    id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    viewKey: "activity_operations",
    cardTypeKey,
    dimensions,
    slots,
    relatedObjectIds,
  };
}

function snapshot(cards: readonly ViewCardState[]): EchoViewSnapshot {
  return {
    viewKey: "activity_operations",
    pluginVersion: "1.3.0",
    schemaVersion: "3",
    stateVersion: "8",
    observedAt: "2026-08-28T00:00:00Z",
    manifest: { key: "activity_operations", label: "活动运营", schemaVersion: "3", description: "", defaultSettings: { aiWritePolicy: "approval_required" } },
    schema: { viewKey: "activity_operations", schemaVersion: "3", cardTypes: [] },
    cards,
    references: [],
    objects: [],
  };
}

describe("activity studio projection", () => {
  it("projects a nested playbook with branches and generated task suggestions", () => {
    nextId = 1;
    const taskDefinition = card("TaskDefinitionCard", { name: "确认场地" });
    const definition = card("WorkPackageDefinitionCard", { name: "场地与审批" }, { tasks: [taskDefinition.id] });
    const nested = card("ActivityPlaybookCard", { name: "现场执行", status: "READY" });
    const finish = card("GuideNodeCard", { name: "方案定稿", node_type: "END", lane: "统筹", row: 1 });
    const start = card("GuideNodeCard", { name: "确认活动边界", node_type: "ACTION", lane: "统筹", row: 0 }, { definition: [definition.id], next: [finish.id], subplaybook: [nested.id] });
    const playbook = card("ActivityPlaybookCard", { name: "社团活动标准流程", status: "READY", lanes: "统筹,现场" }, { nodes: [start.id, finish.id], start_nodes: [start.id] });
    const cards = [playbook, nested, start, finish, definition, taskDefinition];

    expect(buildActivityStudio(snapshot(cards)).playbook?.card.id).toBe(playbook.id);
    const selected = buildActivityStudio(snapshot(cards), { selectedPlaybookId: playbook.id }).playbook!;
    expect(selected.lanes).toEqual(["统筹", "现场"]);
    expect(selected.nodes[0].taskDefinitions.map(({ id }) => id)).toEqual([taskDefinition.id]);
    expect(selected.nodes[0].nestedPlaybook?.id).toBe(nested.id);
    expect(selected.nodes[0].edges).toEqual([expect.objectContaining({ to: finish.id, branch: "NEXT" })]);
  });

  it("projects work-package and task dependencies with execution risks", () => {
    nextId = 30;
    const owner = card("AssignmentCard", {}, {}, ["00000000-0000-4000-8000-000000000901"]);
    const firstTask = card("TaskCard", { name: "提交申请", status: "COMPLETED" });
    const secondTask = card("TaskCard", { name: "确认场馆", status: "BLOCKED", deadline: "2026-08-26" }, { dependencies: [firstTask.id], assignments: [owner.id] });
    const firstPackage = card("WorkPackageCard", { name: "立项", status: "COMPLETED" }, { tasks: [firstTask.id] });
    const secondPackage = card("WorkPackageCard", { name: "场地", status: "IN_PROGRESS" }, { tasks: [secondTask.id], dependencies: [firstPackage.id] });
    const activity = card("ActivityCard", { name: "2026 继往开来杯", status: "RUNNING" }, { work_packages: [firstPackage.id, secondPackage.id] });

    const model = buildActivityStudio(snapshot([activity, firstPackage, secondPackage, firstTask, secondTask, owner]), { today: "2026-08-28" });

    expect(model.workPackages[1].dependencies.map(({ id }) => id)).toEqual([firstPackage.id]);
    expect(model.workPackages[1].tasks[0].dependencies.map(({ id }) => id)).toEqual([firstTask.id]);
    expect(model.metrics).toEqual({ completed: 2, total: 4, blocked: 1, overdue: 1, unassigned: 1 });
  });

  it("uses a focused child card to select the correct activity and resolves owners", () => {
    nextId = 60;
    const task = card("TaskCard", { name: "任务 B" });
    const workPackage = card("WorkPackageCard", { name: "工作包 B" }, { tasks: [task.id] });
    const first = card("ActivityCard", { name: "活动 A", status: "RUNNING" });
    const second = card("ActivityCard", { name: "活动 B", status: "PLANNING" }, { work_packages: [workPackage.id] });
    const assignment = card("AssignmentCard", {}, {}, ["00000000-0000-4000-8000-000000000999"]);

    const model = buildActivityStudio(snapshot([first, second, workPackage, task, assignment]), { selectedActivityId: first.id, focusCardId: task.id });
    expect(model.activity?.id).toBe(second.id);
    expect(ownerNames([assignment], new Map([["00000000-0000-4000-8000-000000000999", "成员甲"]]))).toEqual(["成员甲"]);
  });
});
