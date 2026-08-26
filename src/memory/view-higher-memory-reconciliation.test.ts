import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  maintain: vi.fn(),
  findCompilation: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDatabase: () => ({
    memoryCompilation: { findFirst: state.findCompilation },
  }),
}));
vi.mock("@/memory/higher-memory-maintenance", () => ({
  maintainHigherMemories: state.maintain,
}));

import { societyInformationViewModule } from "@/plugins/society-information/view/schema";
import { reconcileViewHigherMemory } from "@/memory/view-higher-memory-reconciliation";

const cardId = "00000000-0000-4000-8000-000000000001";
const existingObjectId = "00000000-0000-4000-8000-000000000002";
const coldObjectId = "00000000-0000-4000-8000-000000000003";
const executionId = "00000000-0000-4000-8000-000000000004";
const compilationId = "00000000-0000-4000-8000-000000000005";

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
    }],
    events: [{
      type: "society.profile_updated",
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
  state.findCompilation.mockResolvedValue({ id: compilationId });
  state.maintain.mockResolvedValue({ objectMemories: 1, ambientMemories: 0 });
});

describe("View Higher Memory reconciliation", () => {
  it("refreshes only related Objects that already have Higher Memory", async () => {
    await expect(reconcileViewHigherMemory(input())).resolves.toBe(1);

    const maintenance = state.maintain.mock.calls[0][0];
    expect(maintenance.queueDecision.targets).toEqual([{
      scope: "object",
      globalObjectId: existingObjectId,
    }]);
    expect(maintenance.existingObjectMemoriesOnly).toBe(true);
    expect(maintenance.semanticContext.toolExecutions[0]).toEqual(expect.objectContaining({
      toolName: "readAuthoritativeBusinessViewAfterHumanChange",
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

    await expect(reconcileViewHigherMemory(value)).resolves.toBe(0);

    expect(state.findCompilation).not.toHaveBeenCalled();
    expect(state.maintain).not.toHaveBeenCalled();
  });
});
