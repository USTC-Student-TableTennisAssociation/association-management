import { z } from "zod";

import type { DomainEventDefinition } from "@sydaris/plugin-sdk";
import { zodContractSchema } from "@sydaris/plugin-sdk";

const uuid = z.string().uuid();
const cardEventSchema = z.object({ cardId: uuid });
const changedCardEventSchema = cardEventSchema.extend({
  changedDimensions: z.array(z.string().min(1)),
});
const playbookMemberEventSchema = cardEventSchema.extend({ playbookId: uuid });

export const activityOperationsEvents: readonly DomainEventDefinition[] = [
  {
    key: "activity.activity_created",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema),
  },
  {
    key: "activity.activity_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCardEventSchema),
  },
  {
    key: "activity.work_package_added",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({ activityId: uuid })),
  },
  {
    key: "activity.work_package_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCardEventSchema.extend({ activityId: uuid })),
  },
  {
    key: "activity.task_added",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({ workPackageId: uuid })),
  },
  {
    key: "activity.task_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCardEventSchema.extend({ workPackageId: uuid })),
  },
  {
    key: "activity.task_removed",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({
      workPackageId: uuid,
      reason: z.string().min(1).max(1_000),
    })),
  },
  {
    key: "activity.owner_assigned",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({
      targetCardId: uuid,
      objectId: uuid,
    })),
  },
  {
    key: "activity.owner_unassigned",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({
      targetCardId: uuid,
      reason: z.string().min(1).max(1_000),
    })),
  },
  {
    key: "activity.milestone_added",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({
      activityId: uuid,
      parentCardId: uuid,
    })),
  },
  {
    key: "activity.milestone_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCardEventSchema.extend({ activityId: uuid })),
  },
  {
    key: "activity.playbook_created",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema),
  },
  {
    key: "activity.playbook_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCardEventSchema),
  },
  {
    key: "activity.guide_node_added",
    version: "1",
    payloadSchema: zodContractSchema(playbookMemberEventSchema),
  },
  {
    key: "activity.guide_node_updated",
    version: "1",
    payloadSchema: zodContractSchema(playbookMemberEventSchema.extend({
      changedDimensions: z.array(z.string().min(1)),
    })),
  },
  {
    key: "activity.guide_edge_changed",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      playbookId: uuid,
      fromNodeId: uuid,
      toNodeId: uuid,
      branch: z.enum(["NEXT", "YES", "NO"]),
      connected: z.boolean(),
    })),
  },
  {
    key: "activity.nested_playbook_changed",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      playbookId: uuid,
      nodeId: uuid,
      nestedPlaybookId: uuid.nullable(),
    })),
  },
  {
    key: "activity.playbook_applied",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({
      playbookId: uuid,
      createdWorkPackages: z.number().int().min(0),
      createdTasks: z.number().int().min(0),
    })),
  },
  {
    key: "activity.dependency_changed",
    version: "1",
    payloadSchema: zodContractSchema(cardEventSchema.extend({
      dependencyId: uuid,
      dependencyType: z.enum(["WORK_PACKAGE", "TASK"]),
      connected: z.boolean(),
    })),
  },
];
