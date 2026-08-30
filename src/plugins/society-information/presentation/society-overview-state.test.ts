import { describe, expect, it } from "vitest";

import type { ViewReaction } from "@sydaris/plugin-sdk";

import {
  galleryEdges,
  presentSocietyReaction,
  projectedActivityIndex,
  reactionsByCard,
} from "./society-overview-state";

function reaction(input: Partial<ViewReaction> & Pick<ViewReaction, "id">): ViewReaction {
  return {
    id: input.id,
    executionId: input.executionId ?? `execution-${input.id}`,
    viewKey: input.viewKey ?? "society.overview",
    stateVersion: input.stateVersion ?? "state-1",
    targets: input.targets ?? [{ kind: "card", cardId: "card-1", cardTypeKey: "ActivityCard" }],
    attention: input.attention ?? { policy: "evaluate", status: "silent" },
    knowledge: input.knowledge ?? { policy: "reconcile", status: "completed" },
    seenAt: input.seenAt,
    createdAt: input.createdAt ?? "2026-08-28T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-28T00:00:00.000Z",
  };
}

describe("society overview presentation state", () => {
  it("surfaces active and confirmation reactions with distinct tones", () => {
    expect(presentSocietyReaction(reaction({
      id: "running",
      attention: { policy: "evaluate", status: "running" },
      knowledge: { policy: "reconcile", status: "running" },
    }))).toEqual({ label: "Echo 正在核对", tone: "checking" });
    expect(presentSocietyReaction(reaction({
      id: "confirm",
      attention: { policy: "always", status: "needs_confirmation", message: "请确认" },
    }))).toEqual({ label: "需要确认", tone: "attention" });
  });

  it("prefers an unseen actionable reaction for each card", () => {
    const seen = reaction({ id: "seen", seenAt: "2026-08-28T01:00:00.000Z" });
    const unseen = reaction({
      id: "unseen",
      attention: { policy: "always", status: "inform", message: "有更新" },
    });
    expect(reactionsByCard([seen, unseen]).get("card-1")?.id).toBe("unseen");
  });

  it("projects a flick toward the next activity and reports gallery edges", () => {
    expect(projectedActivityIndex({
      centers: [100, 400, 700],
      startIndex: 0,
      deltaX: 80,
      velocityX: 1_500,
    })).toBe(1);
    expect(galleryEdges({ scrollLeft: 0, clientWidth: 500, scrollWidth: 900 })).toEqual({
      atStart: true,
      atEnd: false,
    });
    expect(galleryEdges({ scrollLeft: 400, clientWidth: 500, scrollWidth: 900 })).toEqual({
      atStart: false,
      atEnd: true,
    });
  });
});
