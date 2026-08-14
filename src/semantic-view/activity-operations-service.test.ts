import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDatabase } from "@/db";
import {
  executeActivityPortfolioAction,
} from "@/semantic-view/activity-operations-service";
import { getSemanticView } from "@/semantic-view/service";
import type { BusinessViewKey, SemanticViewState } from "@/semantic-view/types";

vi.mock("@/db", () => ({ getDatabase: vi.fn() }));
vi.mock("@/semantic-view/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/semantic-view/service")>();
  return { ...actual, getSemanticView: vi.fn() };
});

const activityId = "11111111-1111-4111-8111-111111111111";
const workPackageId = "22222222-2222-4222-8222-222222222222";
const assignmentId = "33333333-3333-4333-8333-333333333333";
const personId = "44444444-4444-4444-8444-444444444444";

function emptyView(viewKey: BusinessViewKey): SemanticViewState {
  return {
    viewKey,
    viewLabel: viewKey,
    viewDescription: viewKey,
    compilationId: null,
    compatible: true,
    cardTypes: [],
    cards: [],
  };
}

function databaseMock() {
  const transaction = {
    semanticCard: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    semanticContentDimension: {
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
    semanticSlotBinding: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn(),
    },
  };
  const database = {
    ...transaction,
    $transaction: vi.fn(async (
      callback: (client: typeof transaction) => Promise<unknown>,
    ) => callback(transaction)),
  };
  return { database, transaction };
}

describe("Activity Portfolio write service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSemanticView).mockImplementation(async (viewKey) =>
      emptyView(viewKey as BusinessViewKey)
    );
  });

  it("creates a WorkPackage Card, its dimensions, and owner Slot chain in one transaction", async () => {
    const { database, transaction } = databaseMock();
    transaction.semanticCard.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === activityId) {
        return {
          id: activityId,
          viewKey: "activity_operations",
          cardTypeKey: "ActivityCard",
        };
      }
      if (where.id === workPackageId) {
        return {
          id: workPackageId,
          viewKey: "activity_operations",
          cardTypeKey: "WorkPackageCard",
        };
      }
      if (where.id === personId) {
        return {
          id: personId,
          viewKey: "society_information",
          cardTypeKey: "PersonCard",
        };
      }
      return null;
    });
    transaction.semanticCard.create
      .mockResolvedValueOnce({
        id: workPackageId,
        viewKey: "activity_operations",
        cardTypeKey: "WorkPackageCard",
      })
      .mockResolvedValueOnce({
        id: assignmentId,
        viewKey: "activity_operations",
        cardTypeKey: "AssignmentCard",
      });
    vi.mocked(getDatabase).mockReturnValue(database as never);

    await executeActivityPortfolioAction({
      type: "CREATE_WORK_PACKAGE",
      activityCardId: activityId,
      values: {
        name: "场地申请",
        description: "申请比赛场地。",
        status: "IN_PROGRESS",
        progress: "申请已提交，正在等待确认。",
        deadline: "10/10",
      },
      ownerPersonCardId: personId,
    });

    expect(database.$transaction).toHaveBeenCalledOnce();
    expect(transaction.semanticCard.create).toHaveBeenNthCalledWith(1, {
      data: {
        compilationId: null,
        sourceObjectId: null,
        viewKey: "activity_operations",
        cardTypeKey: "WorkPackageCard",
      },
    });
    expect(transaction.semanticContentDimension.upsert).toHaveBeenCalledWith({
      where: { cardId_name: { cardId: workPackageId, name: "进度" } },
      create: {
        cardId: workPackageId,
        name: "进度",
        contentMarkdown: "申请已提交，正在等待确认。",
      },
      update: { contentMarkdown: "申请已提交，正在等待确认。" },
    });
    expect(transaction.semanticSlotBinding.create.mock.calls.map(
      ([input]) => input.data,
    )).toEqual([
      { sourceCardId: activityId, slotKey: "work_packages", targetCardId: workPackageId },
      { sourceCardId: workPackageId, slotKey: "assignments", targetCardId: assignmentId },
      { sourceCardId: assignmentId, slotKey: "assignee", targetCardId: personId },
    ]);
    expect(transaction.semanticSlotBinding.findMany).toHaveBeenCalledWith({
      where: { sourceCardId: workPackageId, slotKey: "assignments" },
      orderBy: { createdAt: "asc" },
      include: { targetCard: true },
    });
    expect(getSemanticView).toHaveBeenCalledWith("activity_operations");
    expect(getSemanticView).toHaveBeenCalledWith("society_information");
  });

  it("deletes an empty WorkPackage and its Activity SlotBinding", async () => {
    const { database, transaction } = databaseMock();
    transaction.semanticCard.findUnique.mockImplementation(async ({ where }) => ({
      id: where.id,
      viewKey: "activity_operations",
      cardTypeKey: where.id === activityId ? "ActivityCard" : "WorkPackageCard",
    }));
    transaction.semanticSlotBinding.findUnique.mockResolvedValue({
      sourceCardId: activityId,
      slotKey: "work_packages",
      targetCardId: workPackageId,
    });
    vi.mocked(getDatabase).mockReturnValue(database as never);

    await executeActivityPortfolioAction({
      type: "DELETE_WORK_PACKAGE",
      activityCardId: activityId,
      cardId: workPackageId,
    });

    expect(transaction.semanticSlotBinding.count).toHaveBeenCalledWith({
      where: { sourceCardId: workPackageId, slotKey: "tasks" },
    });
    expect(transaction.semanticSlotBinding.delete).toHaveBeenCalledWith({
      where: {
        sourceCardId_slotKey_targetCardId: {
          sourceCardId: activityId,
          slotKey: "work_packages",
          targetCardId: workPackageId,
        },
      },
    });
    expect(transaction.semanticCard.delete).toHaveBeenCalledWith({
      where: { id: workPackageId },
    });
  });

  it("refuses to delete a WorkPackage with Tasks and leaves its Card intact", async () => {
    const { database, transaction } = databaseMock();
    transaction.semanticCard.findUnique.mockImplementation(async ({ where }) => ({
      id: where.id,
      viewKey: "activity_operations",
      cardTypeKey: where.id === activityId ? "ActivityCard" : "WorkPackageCard",
    }));
    transaction.semanticSlotBinding.findUnique.mockResolvedValue({
      sourceCardId: activityId,
      slotKey: "work_packages",
      targetCardId: workPackageId,
    });
    transaction.semanticSlotBinding.count.mockResolvedValue(1);
    vi.mocked(getDatabase).mockReturnValue(database as never);

    await expect(executeActivityPortfolioAction({
      type: "DELETE_WORK_PACKAGE",
      activityCardId: activityId,
      cardId: workPackageId,
    })).rejects.toThrow("已有 Task 的 Work Package 不能删除，请改为取消");

    expect(transaction.semanticSlotBinding.delete).not.toHaveBeenCalled();
    expect(transaction.semanticCard.delete).not.toHaveBeenCalled();
    expect(getSemanticView).not.toHaveBeenCalled();
  });
});
