import { describe, expect, it, vi } from "vitest";

import { getDatabase } from "@/db";
import { getSemanticView } from "@/semantic-view/service";

vi.mock("@/db", () => ({ getDatabase: vi.fn() }));

const activityId = "11111111-1111-4111-8111-111111111111";
const assignmentId = "22222222-2222-4222-8222-222222222222";
const personId = "33333333-3333-4333-8333-333333333333";

function nativeCard(input: {
  id: string;
  cardTypeKey: string;
  dimensions?: Array<{ id: string; name: string; contentMarkdown: string }>;
  outgoingSlots?: unknown[];
}) {
  return {
    id: input.id,
    compilationId: null,
    sourceObjectId: null,
    viewKey: "activity_operations",
    cardTypeKey: input.cardTypeKey,
    createdAt: new Date("2026-08-14T00:00:00Z"),
    updatedAt: new Date("2026-08-14T00:00:00Z"),
    sourceObject: null,
    contentDimensions: input.dimensions ?? [],
    outgoingSlots: input.outgoingSlots ?? [],
  };
}

describe("native Activity Operations Card reads", () => {
  it("rebuilds native Runtime Cards without a Compilation and preserves the Person Slot target", async () => {
    const assignment = nativeCard({
      id: assignmentId,
      cardTypeKey: "AssignmentCard",
      outgoingSlots: [{
        sourceCardId: assignmentId,
        slotKey: "assignee",
        targetCardId: personId,
        createdAt: new Date("2026-08-14T00:00:00Z"),
        targetCard: {
          id: personId,
          compilationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sourceObjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          viewKey: "society_information",
          cardTypeKey: "PersonCard",
          sourceObject: { canonicalName: "雷岳鑫" },
          contentDimensions: [],
        },
      }],
    });
    const activity = nativeCard({
      id: activityId,
      cardTypeKey: "ActivityCard",
      dimensions: [
        { id: "name", name: "名称", contentMarkdown: "2026 秋单打赛" },
        { id: "progress", name: "进度", contentMarkdown: "场地正在确认。" },
      ],
      outgoingSlots: [{
        sourceCardId: activityId,
        slotKey: "assignments",
        targetCardId: assignmentId,
        createdAt: new Date("2026-08-14T00:00:00Z"),
        targetCard: {
          ...assignment,
          contentDimensions: [],
        },
      }],
    });
    const database = {
      memoryCompilation: { findFirst: vi.fn().mockResolvedValue(null) },
      semanticCard: {
        findMany: vi.fn()
          .mockResolvedValueOnce([{ compilationId: null }, { compilationId: null }])
          .mockResolvedValueOnce([activity, assignment]),
      },
    };
    vi.mocked(getDatabase).mockReturnValue(database as never);

    const result = await getSemanticView("activity_operations");

    expect(result).toMatchObject({
      viewKey: "activity_operations",
      compilationId: null,
      compatible: true,
    });
    expect(result.cards[0]).toMatchObject({
      id: activityId,
      objectName: "2026 秋单打赛",
    });
    expect(result.cards[0].objectId).toBeUndefined();
    expect(result.cards[1].slots.find((slot) => slot.key === "assignee")?.targets)
      .toEqual([{
        cardId: personId,
        viewKey: "society_information",
        cardTypeKey: "PersonCard",
        objectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        objectName: "雷岳鑫",
      }]);
  });
});
