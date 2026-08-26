import { z } from "zod";

import type { CommandDefinition, ViewCardState } from "@/contracts";
import { zodContractSchema } from "@/contracts";

const activityStatusSchema = z.enum([
  "PLANNING",
  "RUNNING",
  "WRAP_UP",
  "COMPLETED",
  "CANCELLED",
]);
const workStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);
const dateRangeSchema = z.object({
  start: z.string(),
  end: z.string().optional(),
});

const createActivitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5_000).optional(),
  status: activityStatusSchema.default("PLANNING"),
  progress: z.string().max(5_000).optional(),
  time: dateRangeSchema.optional(),
  format: z.string().max(200).optional(),
  scale: z.string().max(200).optional(),
  participantCount: z.number().int().min(0).optional(),
});

const addWorkPackageSchema = z.object({
  activityId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5_000).optional(),
  status: workStatusSchema.default("NOT_STARTED"),
  progress: z.string().max(5_000).optional(),
  deadline: z.string().optional(),
});

const addTaskSchema = z.object({
  workPackageId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  status: workStatusSchema.default("NOT_STARTED"),
});

const assignOwnerSchema = z.object({
  targetCardId: z.string().uuid(),
  objectId: z.string().uuid(),
});

const updateActivitySchema = z.object({
  activityId: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5_000).optional(),
  status: activityStatusSchema.optional(),
  progress: z.string().max(5_000).optional(),
  time: dateRangeSchema.optional(),
  format: z.string().max(200).optional(),
  scale: z.string().max(200).optional(),
  participantCount: z.number().int().min(0).optional(),
}).refine((input) => Object.keys(input).some((key) => key !== "activityId"), {
  message: "至少需要一个要更新的字段",
});

function dimensions(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

function requireType(card: ViewCardState | undefined, type: string): ViewCardState {
  if (!card || card.cardTypeKey !== type) {
    throw new Error(`需要 ${type} Card`);
  }
  return card;
}

const createActivity: CommandDefinition<z.infer<typeof createActivitySchema>> = {
  key: "activity.create_activity",
  version: "1",
  label: "创建活动",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(createActivitySchema),
  inputReferences: [{
    path: ["objectId"],
    kind: "object",
    inferFromCanonicalNamePath: ["name"],
  }],
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const cardId = await context.transaction.createCard({
      cardTypeKey: "ActivityCard",
      dimensions: dimensions({
        name: input.name,
        description: input.description,
        status: input.status,
        progress: input.progress,
        time: input.time,
        format: input.format,
        scale: input.scale,
        participant_count: input.participantCount,
      }),
    });
    return {
      summary: { cardId },
      events: [{ type: "activity.activity_created", version: "1", payload: { cardId } }],
    };
  },
};

const addWorkPackage: CommandDefinition<z.infer<typeof addWorkPackageSchema>> = {
  key: "activity.add_work_package",
  version: "1",
  label: "添加工作包",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(addWorkPackageSchema),
  inputReferences: [{ path: ["activityId"], kind: "card" }],
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const activity = requireType(await context.transaction.getCard(input.activityId), "ActivityCard");
    const cardId = await context.transaction.createCard({
      cardTypeKey: "WorkPackageCard",
      dimensions: dimensions({
        name: input.name,
        description: input.description,
        status: input.status,
        progress: input.progress,
        deadline: input.deadline,
      }),
    });
    await context.transaction.setSlot(
      activity.id,
      "work_packages",
      [...(activity.slots.work_packages ?? []), cardId],
    );
    return {
      summary: { cardId, activityId: activity.id },
      events: [{
        type: "activity.work_package_added",
        version: "1",
        payload: { cardId, activityId: activity.id },
      }],
    };
  },
};

const addTask: CommandDefinition<z.infer<typeof addTaskSchema>> = {
  key: "activity.add_task",
  version: "1",
  label: "添加任务",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(addTaskSchema),
  inputReferences: [{ path: ["workPackageId"], kind: "card" }],
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const workPackage = requireType(
      await context.transaction.getCard(input.workPackageId),
      "WorkPackageCard",
    );
    const cardId = await context.transaction.createCard({
      cardTypeKey: "TaskCard",
      dimensions: { name: input.name, status: input.status },
    });
    await context.transaction.setSlot(
      workPackage.id,
      "tasks",
      [...(workPackage.slots.tasks ?? []), cardId],
    );
    return {
      summary: { cardId, workPackageId: workPackage.id },
      events: [{
        type: "activity.task_added",
        version: "1",
        payload: { cardId, workPackageId: workPackage.id },
      }],
    };
  },
};

const assignOwner: CommandDefinition<z.infer<typeof assignOwnerSchema>> = {
  key: "activity.assign_owner",
  version: "1",
  label: "分配负责人",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(assignOwnerSchema),
  inputReferences: [
    { path: ["targetCardId"], kind: "card" },
    { path: ["objectId"], kind: "object" },
  ],
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const target = await context.transaction.getCard(input.targetCardId);
    if (!target || !["ActivityCard", "WorkPackageCard"].includes(target.cardTypeKey)) {
      throw new Error("只能为 Activity 或 Work Package 分配负责人");
    }
    const cardId = await context.transaction.createCard({
      cardTypeKey: "AssignmentCard",
      relatedObjectIds: [input.objectId],
    });
    await context.transaction.setSlot(
      target.id,
      "assignments",
      [...(target.slots.assignments ?? []), cardId],
    );
    return {
      summary: { cardId, targetCardId: target.id, objectId: input.objectId },
      events: [{
        type: "activity.owner_assigned",
        version: "1",
        payload: { cardId, targetCardId: target.id, objectId: input.objectId },
      }],
    };
  },
};

const updateActivity: CommandDefinition<z.infer<typeof updateActivitySchema>> = {
  key: "activity.update_activity",
  version: "1",
  label: "更新活动",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(updateActivitySchema),
  inputReferences: [{ path: ["activityId"], kind: "card" }],
  async execute(context, input) {
    const activity = requireType(
      await context.transaction.getCard(input.activityId),
      "ActivityCard",
    );
    for (const [key, value] of Object.entries(dimensions({
      name: input.name,
      description: input.description,
      status: input.status,
      progress: input.progress,
      time: input.time,
      format: input.format,
      scale: input.scale,
      participant_count: input.participantCount,
    }))) {
      await context.transaction.setDimension(activity.id, key, value);
    }
    return {
      summary: { cardId: activity.id },
      events: [{ type: "activity.activity_updated", version: "1", payload: { cardId: activity.id } }],
    };
  },
};

export const activityOperationsCommands: readonly CommandDefinition[] = [
  createActivity,
  updateActivity,
  addWorkPackage,
  addTask,
  assignOwner,
];
