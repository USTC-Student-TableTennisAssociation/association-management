import { describe, expect, it, vi } from "vitest";

import { activityOperationsViewModule } from "@/plugins/activity-operations/view/schema";
import { societyInformationViewModule } from "@/plugins/society-information/view/schema";
import { PrismaCardGraphTransaction } from "@/view-runtime/persistence/prisma-card-graph";

const objectId = "00000000-0000-4000-8000-000000000101";

function databaseFixture() {
  return {
    memoryGlobalObject: {
      findMany: vi.fn().mockResolvedValue([{ id: objectId }]),
    },
    viewCard: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000201",
      }),
    },
  };
}

describe("PrismaCardGraphTransaction Related Objects", () => {
  it("persists an allowed existing Object relation", async () => {
    const database = databaseFixture();
    const graph = new PrismaCardGraphTransaction(
      database as never,
      activityOperationsViewModule,
    );

    await expect(graph.createCard({
      cardTypeKey: "ActivityCard",
      dimensions: { name: "Sydaris 验收赛" },
      relatedObjectIds: [objectId],
    })).resolves.toBe("00000000-0000-4000-8000-000000000201");

    expect(database.viewCard.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        relatedObjects: { create: [{ objectId }] },
      }),
    }));
  });

  it("rejects a relation to a missing GlobalObject", async () => {
    const database = databaseFixture();
    database.memoryGlobalObject.findMany.mockResolvedValue([]);
    const graph = new PrismaCardGraphTransaction(
      database as never,
      activityOperationsViewModule,
    );

    await expect(graph.createCard({
      cardTypeKey: "ActivityCard",
      dimensions: { name: "Sydaris 验收赛" },
      relatedObjectIds: [objectId],
    })).rejects.toThrow(`Related Objects 不存在：${objectId}`);

    expect(database.viewCard.create).not.toHaveBeenCalled();
  });

  it("rejects a second ActivityCard for the same Object", async () => {
    const database = databaseFixture();
    database.viewCard.findFirst.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000202",
    });
    const graph = new PrismaCardGraphTransaction(
      database as never,
      activityOperationsViewModule,
    );

    await expect(graph.createCard({
      cardTypeKey: "ActivityCard",
      dimensions: { name: "Sydaris 验收赛" },
      relatedObjectIds: [objectId],
    })).rejects.toThrow(`ActivityCard 已有关联 Object ${objectId} 的 Card`);

    expect(database.viewCard.create).not.toHaveBeenCalled();
  });

  it("keeps an ActivityCard without an Object relation valid", async () => {
    const database = databaseFixture();
    const graph = new PrismaCardGraphTransaction(
      database as never,
      activityOperationsViewModule,
    );

    await expect(graph.createCard({
      cardTypeKey: "ActivityCard",
      dimensions: { name: "人工录入活动" },
    })).resolves.toBe("00000000-0000-4000-8000-000000000201");

    expect(database.memoryGlobalObject.findMany).not.toHaveBeenCalled();
  });
});

describe("PrismaCardGraphTransaction ordered Slots", () => {
  it("persists the caller-provided target order as explicit positions", async () => {
    const societyCardId = "00000000-0000-4000-8000-000000000301";
    const activityA = "00000000-0000-4000-8000-000000000302";
    const activityB = "00000000-0000-4000-8000-000000000303";
    const database = {
      viewCard: {
        findFirst: vi.fn().mockResolvedValue({
          id: societyCardId,
          cardTypeKey: "SocietyCard",
        }),
        findMany: vi.fn().mockResolvedValue([
          { id: activityA, viewKey: "society_information", cardTypeKey: "ActivityCard" },
          { id: activityB, viewKey: "society_information", cardTypeKey: "ActivityCard" },
        ]),
      },
      viewSlotBinding: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const graph = new PrismaCardGraphTransaction(
      database as never,
      societyInformationViewModule,
    );

    await graph.setSlot(societyCardId, "activities", [activityB, activityA]);

    expect(database.viewSlotBinding.createMany).toHaveBeenCalledWith({
      data: [
        {
          sourceCardId: societyCardId,
          slotKey: "activities",
          targetCardId: activityB,
          position: 0,
        },
        {
          sourceCardId: societyCardId,
          slotKey: "activities",
          targetCardId: activityA,
          position: 1,
        },
      ],
    });
  });
});
