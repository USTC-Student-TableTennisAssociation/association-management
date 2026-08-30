import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  maintain: vi.fn(),
}));
vi.mock("@/memory/higher-memory-maintenance", () => ({
  maintainHigherMemories: state.maintain,
}));

import { societyInformationViewModule } from "@/plugins/society-information/view/schema";
import { reconcileObjectHigherMemoryFromViewChange } from "@/memory/object-higher-memory-reconciliation";

const cardId = "00000000-0000-4000-8000-000000000001";
const existingObjectId = "00000000-0000-4000-8000-000000000002";
const coldObjectId = "00000000-0000-4000-8000-000000000003";
const executionId = "00000000-0000-4000-8000-000000000004";

function input() {
  return {
    viewModule: societyInformationViewModule,
    snapshot: {
      viewKey: "society_information",
      pluginVersion: "1.8.0",
      schemaVersion: "5",
      stateVersion: "3",
      observedAt: "2026-08-26T00:00:00.000Z",
      cards: [{
        id: cardId,
        viewKey: "society_information",
        cardTypeKey: "SocietyCard",
        dimensions: { rating: "四星级社团" },
        slots: {},
        relatedObjectIds: [existingObjectId, coldObjectId],
      }],
      references: [],
    },
    executions: [{
      id: executionId,
      commandKey: "society.update_profile",
      input: { societyCardId: cardId, changes: { rating: "四星级社团" } },
      result: { cardId },
      stateVersionBefore: "2",
      stateVersionAfter: "3",
      changes: [{
        kind: "dimension" as const,
        cardId,
        cardTypeKey: "SocietyCard",
        dimensionKey: "rating",
        before: { present: true as const, value: "三星级社团" },
        after: { present: true as const, value: "四星级社团" },
      }],
    }],
    events: [{
      type: "society.profile_updated",
      version: "1",
      payload: { cardId, changedDimensions: ["rating"] },
      stateVersion: "3",
    }],
    objects: [{
      id: existingObjectId,
      canonicalName: "已有高层记忆的社团",
      cognitiveMemory: { currentSituation: "仍为三星级社团" },
    }, {
      id: coldObjectId,
      canonicalName: "尚无高层记忆的对象",
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.maintain.mockResolvedValue({ objectMemories: 1, ambientMemories: 0 });
});

describe("Object Higher Memory reconciliation after a View change", () => {
  it("refreshes only related Objects that already have Higher Memory", async () => {
    await expect(reconcileObjectHigherMemoryFromViewChange(input())).resolves.toBe(1);

    const maintenance = state.maintain.mock.calls[0][0];
    expect(maintenance.queueDecision.targets).toEqual([{
      scope: "object",
      globalObjectId: existingObjectId,
    }]);
    expect(maintenance.existingObjectMemoriesOnly).toBe(true);
    expect(maintenance.semanticContext.toolExecutions[0]).toEqual(expect.objectContaining({
      toolName: "readAuthoritativeBusinessViewAfterCommand",
      success: true,
    }));
    expect(JSON.stringify(maintenance.semanticContext)).toContain("四星级社团");
    expect(JSON.stringify(maintenance.semanticContext)).not.toContain(cardId);
    expect(JSON.stringify(maintenance.semanticContext)).not.toContain(existingObjectId);
  });

  it("does nothing when none of the related Objects has Higher Memory", async () => {
    const value = input();
    value.objects = value.objects.map((object) => ({
      id: object.id,
      canonicalName: object.canonicalName,
    }));

    await expect(reconcileObjectHigherMemoryFromViewChange(value)).resolves.toBe(0);

    expect(state.maintain).not.toHaveBeenCalled();
  });
});
