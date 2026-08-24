import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/db", () => ({
  getDatabase: () => ({ memoryGlobalObject: { findMany: databaseState.findMany } }),
}));

import { buildViewContext } from "@/agent-runtime/view-context";

describe("buildViewContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches a sparse Card through its related Object canonical name", async () => {
    const objectId = "00000000-0000-4000-8000-000000000001";
    const cardId = "00000000-0000-4000-8000-000000000002";
    databaseState.findMany.mockResolvedValue([{
      id: objectId,
      globalObjectKey: "organization:ustc-table-tennis-association",
      canonicalName: "中国科大乒协",
      higherMemory: null,
    }]);

    const result = await buildViewContext({
      snapshot: {
        viewKey: "society_information",
        moduleVersion: "1.0.0",
        schemaVersion: "1",
        stateVersion: "state-1",
        observedAt: "2026-08-24T00:00:00.000Z",
        cards: [{
          id: cardId,
          viewKey: "society_information",
          cardTypeKey: "SocietyCard",
          dimensions: {},
          slots: {},
          relatedObjectIds: [objectId],
        }],
        references: [{
          ref: "V1",
          label: "社团概览",
          target: { kind: "view", viewKey: "society_information" },
        }, {
          ref: "V2",
          label: "乒协卡片",
          target: { kind: "card", viewKey: "society_information", cardId },
        }],
      },
      viewLabel: "社团概览",
      viewDescription: "社团资料",
      cardTypes: [{
        key: "SocietyCard",
        label: "社团",
        description: "社团资料",
        dimensions: [],
        slots: [],
      }],
      focus: "读取中国科大乒协概览",
      targetHints: ["中国科大乒协"],
    });

    expect(result.formalCardMissing).toBe(false);
    expect(result.relevantCards).toEqual([expect.objectContaining({ id: cardId })]);
    expect(result.evidence.objects).toEqual([
      expect.objectContaining({ id: objectId, canonicalName: "中国科大乒协" }),
    ]);
  });
});
