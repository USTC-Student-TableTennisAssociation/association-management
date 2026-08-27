import { describe, expect, it } from "vitest";

import type { ViewCardState } from "@/contracts";
import { diffViewCards } from "@/view-runtime/application/view-change-set";

function card(input: Partial<ViewCardState> & Pick<ViewCardState, "id">): ViewCardState {
  return {
    id: input.id,
    viewKey: input.viewKey ?? "society_information",
    cardTypeKey: input.cardTypeKey ?? "SocietyCard",
    dimensions: input.dimensions ?? {},
    slots: input.slots ?? {},
    relatedObjectIds: input.relatedObjectIds ?? [],
  };
}

describe("View change set", () => {
  it("records dimension presence and before/after values", () => {
    const changes = diffViewCards(
      [card({ id: "card-1", dimensions: { rating: "three", purpose: "old" } })],
      [card({ id: "card-1", dimensions: { rating: "four", description: "new" } })],
    );

    expect(changes).toEqual([
      {
        kind: "dimension",
        cardId: "card-1",
        cardTypeKey: "SocietyCard",
        dimensionKey: "description",
        before: { present: false },
        after: { present: true, value: "new" },
      },
      {
        kind: "dimension",
        cardId: "card-1",
        cardTypeKey: "SocietyCard",
        dimensionKey: "purpose",
        before: { present: true, value: "old" },
        after: { present: false },
      },
      {
        kind: "dimension",
        cardId: "card-1",
        cardTypeKey: "SocietyCard",
        dimensionKey: "rating",
        before: { present: true, value: "three" },
        after: { present: true, value: "four" },
      },
    ]);
  });

  it("records ordered Slot, Related Object and Card lifecycle changes", () => {
    const deleted = card({ id: "deleted", cardTypeKey: "ActivityCard" });
    const created = card({ id: "created", cardTypeKey: "PlatformCard" });
    const previous = card({
      id: "card-1",
      slots: { activities: ["a", "b"] },
      relatedObjectIds: ["object-1"],
    });
    const current = card({
      id: "card-1",
      slots: { activities: ["b", "a"] },
      relatedObjectIds: ["object-2"],
    });

    expect(diffViewCards([deleted, previous], [current, created])).toEqual([
      { kind: "card_deleted", card: deleted },
      { kind: "card_created", card: created },
      {
        kind: "slot",
        cardId: "card-1",
        cardTypeKey: "SocietyCard",
        slotKey: "activities",
        before: ["a", "b"],
        after: ["b", "a"],
      },
      {
        kind: "related_objects",
        cardId: "card-1",
        cardTypeKey: "SocietyCard",
        before: ["object-1"],
        after: ["object-2"],
      },
    ]);
  });
});
