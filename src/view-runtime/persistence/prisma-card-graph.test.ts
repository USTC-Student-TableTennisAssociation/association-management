import { describe, expect, it, vi } from "vitest";

import { activityOperationsViewModule } from "@/plugins/activity-operations/view/schema";
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
      dimensions: { name: "Echo 验收赛" },
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
      dimensions: { name: "Echo 验收赛" },
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
      dimensions: { name: "Echo 验收赛" },
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
