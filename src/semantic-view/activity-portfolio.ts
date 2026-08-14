import { z } from "zod";

import {
  ACTIVITY_STATUSES,
  ACTIVITY_STATUS_LABELS,
  WORK_PACKAGE_STATUSES,
  WORK_PACKAGE_STATUS_LABELS,
  type ActivityStatus,
  type WorkPackageStatus,
} from "@/semantic-view/activity-operations-contract";
import type { SemanticViewCard, SemanticViewState } from "@/semantic-view/types";

const optionalText = z.string().trim().max(5_000).optional();

export const activityEditorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: optionalText,
  status: z.enum(ACTIVITY_STATUSES),
  progress: optionalText,
  time: z.string().trim().max(200).optional(),
  format: z.string().trim().max(200).optional(),
  scale: z.string().trim().max(100).optional(),
  participantCount: z.number().int().min(0).max(1_000_000).nullable().optional(),
});

export const workPackageEditorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: optionalText,
  status: z.enum(WORK_PACKAGE_STATUSES),
  progress: optionalText,
  deadline: z.string().trim().max(200).optional(),
});

export const activityPortfolioActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("CREATE_ACTIVITY"),
    values: activityEditorSchema,
    ownerPersonCardId: z.string().uuid().nullable().optional(),
  }),
  z.object({
    type: z.literal("UPDATE_ACTIVITY"),
    cardId: z.string().uuid(),
    values: activityEditorSchema,
    ownerPersonCardId: z.string().uuid().nullable().optional(),
  }),
  z.object({
    type: z.literal("CREATE_WORK_PACKAGE"),
    activityCardId: z.string().uuid(),
    values: workPackageEditorSchema,
    ownerPersonCardId: z.string().uuid().nullable().optional(),
  }),
  z.object({
    type: z.literal("UPDATE_WORK_PACKAGE"),
    cardId: z.string().uuid(),
    values: workPackageEditorSchema,
    ownerPersonCardId: z.string().uuid().nullable().optional(),
  }),
  z.object({
    type: z.literal("SET_OWNER"),
    cardId: z.string().uuid(),
    personCardId: z.string().uuid().nullable(),
  }),
  z.object({
    type: z.literal("CANCEL_WORK_PACKAGE"),
    cardId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("DELETE_WORK_PACKAGE"),
    activityCardId: z.string().uuid(),
    cardId: z.string().uuid(),
  }),
]);

export type ActivityEditorValues = z.infer<typeof activityEditorSchema>;
export type WorkPackageEditorValues = z.infer<typeof workPackageEditorSchema>;
export type ActivityPortfolioAction = z.infer<typeof activityPortfolioActionSchema>;

export type ActivityPortfolioPerson = {
  cardId: string;
  name: string;
};

export type ActivityPortfolioWorkPackage = WorkPackageEditorValues & {
  cardId: string;
  owner: ActivityPortfolioPerson | null;
  taskCount: number;
  completedTaskCount: number;
};

export type ActivityPortfolioActivity = ActivityEditorValues & {
  cardId: string;
  owner: ActivityPortfolioPerson | null;
  workPackages: ActivityPortfolioWorkPackage[];
  completedWorkPackageCount: number;
};

export type ActivityPortfolio = {
  activities: ActivityPortfolioActivity[];
  people: ActivityPortfolioPerson[];
};

function dimension(card: SemanticViewCard, name: string): string {
  return card.contentDimensions.find((item) => item.name === name)
    ?.contentMarkdown.trim() ?? "";
}

function targets(card: SemanticViewCard, slotKey: string) {
  return card.slots.find((slot) => slot.key === slotKey)?.targets ?? [];
}

function statusValue<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function ownerFor(
  card: SemanticViewCard,
  cardsById: Map<string, SemanticViewCard>,
): ActivityPortfolioPerson | null {
  const assignmentTarget = targets(card, "assignments")[0];
  if (!assignmentTarget) return null;
  const assignment = cardsById.get(assignmentTarget.cardId);
  const assignee = assignment && targets(assignment, "assignee")[0];
  return assignee ? { cardId: assignee.cardId, name: assignee.objectName } : null;
}

export function buildActivityPortfolio(
  activityView: SemanticViewState,
  societyView: SemanticViewState,
): ActivityPortfolio {
  const cardsById = new Map(activityView.cards.map((card) => [card.id, card]));
  const people = societyView.cards
    .filter((card) => card.cardTypeKey === "PersonCard")
    .map((card) => ({ cardId: card.id, name: card.objectName }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  const activities = activityView.cards
    .filter((card) => card.cardTypeKey === "ActivityCard")
    .map((activity): ActivityPortfolioActivity => {
      const workPackages = targets(activity, "work_packages")
        .map((target) => cardsById.get(target.cardId))
        .filter((card): card is SemanticViewCard =>
          Boolean(card?.cardTypeKey === "WorkPackageCard")
        )
        .map((workPackage): ActivityPortfolioWorkPackage => {
          const tasks = targets(workPackage, "tasks")
            .map((target) => cardsById.get(target.cardId))
            .filter((card): card is SemanticViewCard => Boolean(card));
          return {
            cardId: workPackage.id,
            name: dimension(workPackage, "名称") || workPackage.objectName,
            description: dimension(workPackage, "简介"),
            status: statusValue(
              dimension(workPackage, "状态"),
              WORK_PACKAGE_STATUSES,
              "NOT_STARTED",
            ),
            progress: dimension(workPackage, "进度"),
            deadline: dimension(workPackage, "截止时间"),
            owner: ownerFor(workPackage, cardsById),
            taskCount: tasks.length,
            completedTaskCount: tasks.filter(
              (task) => dimension(task, "状态") === "COMPLETED",
            ).length,
          };
        });

      return {
        cardId: activity.id,
        name: dimension(activity, "名称") || activity.objectName,
        description: dimension(activity, "简介"),
        status: statusValue(
          dimension(activity, "状态"),
          ACTIVITY_STATUSES,
          "PLANNING",
        ),
        progress: dimension(activity, "进度"),
        time: dimension(activity, "活动时间"),
        format: dimension(activity, "活动形式"),
        scale: dimension(activity, "活动规模"),
        participantCount: (() => {
          const raw = dimension(activity, "参与人数");
          if (!raw) return null;
          const count = Number(raw);
          return Number.isInteger(count) && count >= 0 ? count : null;
        })(),
        owner: ownerFor(activity, cardsById),
        workPackages,
        completedWorkPackageCount: workPackages.filter(
          (workPackage) => workPackage.status === "COMPLETED",
        ).length,
      };
    });

  return { activities, people };
}

export function activityStatusLabel(status: ActivityStatus): string {
  return ACTIVITY_STATUS_LABELS[status];
}

export function workPackageStatusLabel(status: WorkPackageStatus): string {
  return WORK_PACKAGE_STATUS_LABELS[status];
}
