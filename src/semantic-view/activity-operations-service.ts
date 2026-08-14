import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import { getDatabase } from "@/db";
import {
  ACTIVITY_DIMENSIONS,
  WORK_PACKAGE_DIMENSIONS,
} from "@/semantic-view/activity-operations-contract";
import {
  type ActivityEditorValues,
  type ActivityPortfolio,
  type ActivityPortfolioAction,
  type WorkPackageEditorValues,
  activityPortfolioActionSchema,
  buildActivityPortfolio,
} from "@/semantic-view/activity-portfolio";
import { cardTypeDefinition } from "@/semantic-view/card-types";
import {
  assertSlotTarget,
  getSemanticView,
  SemanticViewValidationError,
} from "@/semantic-view/service";
import {
  ACTIVITY_OPERATIONS_VIEW,
  SOCIETY_INFORMATION_VIEW,
  type BusinessViewKey,
} from "@/semantic-view/types";

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

async function requireCard(
  database: DatabaseClient,
  cardId: string,
  viewKey: BusinessViewKey,
  cardTypeKey: string,
) {
  const card = await database.semanticCard.findUnique({ where: { id: cardId } });
  if (!card || card.viewKey !== viewKey || card.cardTypeKey !== cardTypeKey) {
    throw new SemanticViewValidationError(`${cardTypeKey} ${cardId} 不存在`);
  }
  return card;
}

async function setDimensions(
  database: DatabaseClient,
  cardId: string,
  values: Record<string, string | number | null | undefined>,
) {
  for (const [name, value] of Object.entries(values)) {
    const contentMarkdown = value === null || value === undefined
      ? ""
      : String(value).trim();
    if (!contentMarkdown) {
      await database.semanticContentDimension.deleteMany({ where: { cardId, name } });
      continue;
    }
    await database.semanticContentDimension.upsert({
      where: { cardId_name: { cardId, name } },
      create: { cardId, name, contentMarkdown },
      update: { contentMarkdown },
    });
  }
}

async function createNativeCard(
  database: DatabaseClient,
  cardTypeKey: string,
  dimensions: Record<string, string | number | null | undefined>,
) {
  if (!cardTypeDefinition(ACTIVITY_OPERATIONS_VIEW, cardTypeKey)) {
    throw new SemanticViewValidationError(`不支持的 Card Type：${cardTypeKey}`);
  }
  const card = await database.semanticCard.create({
    data: {
      compilationId: null,
      sourceObjectId: null,
      viewKey: ACTIVITY_OPERATIONS_VIEW,
      cardTypeKey,
    },
  });
  await setDimensions(database, card.id, dimensions);
  return card;
}

function activityDimensions(values: ActivityEditorValues) {
  return {
    [ACTIVITY_DIMENSIONS.name]: values.name,
    [ACTIVITY_DIMENSIONS.description]: values.description,
    [ACTIVITY_DIMENSIONS.status]: values.status,
    [ACTIVITY_DIMENSIONS.progress]: values.progress,
    [ACTIVITY_DIMENSIONS.time]: values.time,
    [ACTIVITY_DIMENSIONS.format]: values.format,
    [ACTIVITY_DIMENSIONS.scale]: values.scale,
    [ACTIVITY_DIMENSIONS.participantCount]: values.participantCount,
  };
}

function workPackageDimensions(values: WorkPackageEditorValues) {
  return {
    [WORK_PACKAGE_DIMENSIONS.name]: values.name,
    [WORK_PACKAGE_DIMENSIONS.description]: values.description,
    [WORK_PACKAGE_DIMENSIONS.status]: values.status,
    [WORK_PACKAGE_DIMENSIONS.progress]: values.progress,
    [WORK_PACKAGE_DIMENSIONS.deadline]: values.deadline,
  };
}

async function addSlotTarget(
  database: DatabaseClient,
  sourceCardId: string,
  slotKey: string,
  targetCardId: string,
) {
  await database.semanticSlotBinding.create({
    data: { sourceCardId, slotKey, targetCardId },
  });
}

async function setOwner(
  database: DatabaseClient,
  cardId: string,
  personCardId: string | null,
) {
  const source = await database.semanticCard.findUnique({ where: { id: cardId } });
  if (
    !source || source.viewKey !== ACTIVITY_OPERATIONS_VIEW ||
    !["ActivityCard", "WorkPackageCard"].includes(source.cardTypeKey)
  ) {
    throw new SemanticViewValidationError("只有 Activity 或 Work Package 可以在此设置负责人");
  }
  const sourceType = cardTypeDefinition(source.viewKey, source.cardTypeKey)!;
  const assignmentSlot = sourceType.slots.assignments;
  const existing = await database.semanticSlotBinding.findMany({
    where: { sourceCardId: cardId, slotKey: "assignments" },
    orderBy: { createdAt: "asc" },
    include: { targetCard: true },
  });
  let assignment = existing.find(
    (binding) => binding.targetCard.cardTypeKey === "AssignmentCard",
  )?.targetCard;

  if (!personCardId) {
    for (const binding of existing) {
      await database.semanticSlotBinding.deleteMany({
        where: { sourceCardId: cardId, slotKey: "assignments", targetCardId: binding.targetCardId },
      });
      await database.semanticCard.delete({ where: { id: binding.targetCardId } });
    }
    return;
  }

  const person = await requireCard(
    database,
    personCardId,
    SOCIETY_INFORMATION_VIEW,
    "PersonCard",
  );
  if (!assignment) {
    assignment = await createNativeCard(database, "AssignmentCard", {});
    assertSlotTarget({
      sourceCard: { selector: source.id, viewKey: source.viewKey, cardTypeKey: source.cardTypeKey },
      targetCard: {
        selector: assignment.id,
        viewKey: assignment.viewKey,
        cardTypeKey: assignment.cardTypeKey,
      },
      slot: assignmentSlot,
    });
    await addSlotTarget(database, source.id, "assignments", assignment.id);
  }
  const assigneeSlot = cardTypeDefinition(
    ACTIVITY_OPERATIONS_VIEW,
    "AssignmentCard",
  )!.slots.assignee;
  assertSlotTarget({
    sourceCard: {
      selector: assignment.id,
      viewKey: assignment.viewKey,
      cardTypeKey: assignment.cardTypeKey,
    },
    targetCard: { selector: person.id, viewKey: person.viewKey, cardTypeKey: person.cardTypeKey },
    slot: assigneeSlot,
  });
  await database.semanticSlotBinding.deleteMany({
    where: { sourceCardId: assignment.id, slotKey: "assignee" },
  });
  await addSlotTarget(database, assignment.id, "assignee", person.id);
}

export async function getActivityPortfolio(): Promise<ActivityPortfolio> {
  const [activityView, societyView] = await Promise.all([
    getSemanticView(ACTIVITY_OPERATIONS_VIEW),
    getSemanticView(SOCIETY_INFORMATION_VIEW),
  ]);
  return buildActivityPortfolio(activityView, societyView);
}

export async function executeActivityPortfolioAction(
  input: ActivityPortfolioAction,
): Promise<ActivityPortfolio> {
  const action = activityPortfolioActionSchema.parse(input);
  const database = getDatabase();
  await database.$transaction(async (transaction) => {
    switch (action.type) {
      case "CREATE_ACTIVITY":
      {
        const activity = await createNativeCard(
          transaction,
          "ActivityCard",
          activityDimensions(action.values),
        );
        if (action.ownerPersonCardId !== undefined) {
          await setOwner(transaction, activity.id, action.ownerPersonCardId);
        }
        break;
      }
      case "UPDATE_ACTIVITY":
        await requireCard(transaction, action.cardId, ACTIVITY_OPERATIONS_VIEW, "ActivityCard");
        await setDimensions(transaction, action.cardId, activityDimensions(action.values));
        if (action.ownerPersonCardId !== undefined) {
          await setOwner(transaction, action.cardId, action.ownerPersonCardId);
        }
        break;
      case "CREATE_WORK_PACKAGE": {
        await requireCard(
          transaction,
          action.activityCardId,
          ACTIVITY_OPERATIONS_VIEW,
          "ActivityCard",
        );
        const workPackage = await createNativeCard(
          transaction,
          "WorkPackageCard",
          workPackageDimensions(action.values),
        );
        await addSlotTarget(
          transaction,
          action.activityCardId,
          "work_packages",
          workPackage.id,
        );
        if (action.ownerPersonCardId !== undefined) {
          await setOwner(transaction, workPackage.id, action.ownerPersonCardId);
        }
        break;
      }
      case "UPDATE_WORK_PACKAGE":
        await requireCard(
          transaction,
          action.cardId,
          ACTIVITY_OPERATIONS_VIEW,
          "WorkPackageCard",
        );
        await setDimensions(transaction, action.cardId, workPackageDimensions(action.values));
        if (action.ownerPersonCardId !== undefined) {
          await setOwner(transaction, action.cardId, action.ownerPersonCardId);
        }
        break;
      case "SET_OWNER":
        await setOwner(transaction, action.cardId, action.personCardId);
        break;
      case "CANCEL_WORK_PACKAGE":
        await requireCard(
          transaction,
          action.cardId,
          ACTIVITY_OPERATIONS_VIEW,
          "WorkPackageCard",
        );
        await setDimensions(transaction, action.cardId, {
          [WORK_PACKAGE_DIMENSIONS.status]: "CANCELLED",
        });
        break;
      case "DELETE_WORK_PACKAGE": {
        await requireCard(
          transaction,
          action.activityCardId,
          ACTIVITY_OPERATIONS_VIEW,
          "ActivityCard",
        );
        await requireCard(
          transaction,
          action.cardId,
          ACTIVITY_OPERATIONS_VIEW,
          "WorkPackageCard",
        );
        const link = await transaction.semanticSlotBinding.findUnique({
          where: {
            sourceCardId_slotKey_targetCardId: {
              sourceCardId: action.activityCardId,
              slotKey: "work_packages",
              targetCardId: action.cardId,
            },
          },
        });
        if (!link) throw new SemanticViewValidationError("Work Package 不属于该 Activity");
        const taskCount = await transaction.semanticSlotBinding.count({
          where: { sourceCardId: action.cardId, slotKey: "tasks" },
        });
        if (taskCount) {
          throw new SemanticViewValidationError("已有 Task 的 Work Package 不能删除，请改为取消");
        }
        await setOwner(transaction, action.cardId, null);
        await transaction.semanticSlotBinding.delete({
          where: {
            sourceCardId_slotKey_targetCardId: {
              sourceCardId: action.activityCardId,
              slotKey: "work_packages",
              targetCardId: action.cardId,
            },
          },
        });
        await transaction.semanticCard.delete({ where: { id: action.cardId } });
        break;
      }
    }
  });
  return getActivityPortfolio();
}
