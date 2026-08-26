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
        pluginVersion: "1.0.0",
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
      aiSemanticInstructions: "每张成员 Card 只表示一个可唯一识别的真实个人。",
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
    expect(result.view.semanticInstructions).toBe(
      "每张成员 Card 只表示一个可唯一识别的真实个人。",
    );
    expect(result.relevantCards).toEqual([expect.objectContaining({ id: cardId })]);
    expect(result.evidence.objects).toEqual([
      expect.objectContaining({ id: objectId, canonicalName: "中国科大乒协" }),
    ]);
  });

  it("returns one-hop slot Cards with a matching parent", async () => {
    const societyObjectId = "00000000-0000-4000-8000-000000000011";
    const activityObjectId = "00000000-0000-4000-8000-000000000012";
    const societyCardId = "00000000-0000-4000-8000-000000000021";
    const activityCardId = "00000000-0000-4000-8000-000000000022";
    databaseState.findMany.mockResolvedValue([{
      id: societyObjectId,
      globalObjectKey: "organization:club",
      canonicalName: "测试社团",
      higherMemory: null,
    }, {
      id: activityObjectId,
      globalObjectKey: "activity:weekly",
      canonicalName: "周常训练",
      higherMemory: null,
    }]);

    const result = await buildViewContext({
      snapshot: {
        viewKey: "society_information",
        pluginVersion: "1.0.0",
        schemaVersion: "1",
        stateVersion: "state-1",
        observedAt: "2026-08-24T00:00:00.000Z",
        cards: [{
          id: societyCardId,
          viewKey: "society_information",
          cardTypeKey: "SocietyCard",
          dimensions: {},
          slots: { activities: [activityCardId] },
          relatedObjectIds: [societyObjectId],
        }, {
          id: activityCardId,
          viewKey: "society_information",
          cardTypeKey: "ActivityCard",
          dimensions: { frequency: "WEEKLY", status: "ACTIVE" },
          slots: {},
          relatedObjectIds: [activityObjectId],
        }],
        references: [{
          ref: "V1",
          label: "社团概览",
          target: { kind: "view", viewKey: "society_information" },
        }, {
          ref: "V2",
          label: "社团",
          target: { kind: "card", viewKey: "society_information", cardId: societyCardId },
        }, {
          ref: "V3",
          label: "活动",
          target: { kind: "card", viewKey: "society_information", cardId: activityCardId },
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
      }, {
        key: "ActivityCard",
        label: "活动",
        description: "长期活动",
        dimensions: [],
        slots: [],
      }],
      focus: "读取测试社团活动",
      targetHints: ["测试社团"],
    });

    expect(result.relevantCards).toEqual([
      expect.objectContaining({ id: societyCardId }),
      expect.objectContaining({
        id: activityCardId,
        dimensions: { frequency: "WEEKLY", status: "ACTIVE" },
      }),
    ]);
  });

  it("does not reinterpret optional empty fields through user-language matching", async () => {
    const societyObjectId = "00000000-0000-4000-8000-000000000031";
    const societyCardId = "00000000-0000-4000-8000-000000000032";
    databaseState.findMany.mockResolvedValue([{
      id: societyObjectId,
      globalObjectKey: "organization:club",
      canonicalName: "测试社团",
      higherMemory: null,
    }]);

    const result = await buildViewContext({
      snapshot: {
        viewKey: "society_information",
        pluginVersion: "1.0.0",
        schemaVersion: "1",
        stateVersion: "state-1",
        observedAt: "2026-08-24T00:00:00.000Z",
        cards: [{
          id: societyCardId,
          viewKey: "society_information",
          cardTypeKey: "SocietyCard",
          dimensions: { purpose: "已有宗旨" },
          slots: { advisor: [], team: [], activities: [], platforms: [] },
          relatedObjectIds: [societyObjectId],
        }],
        references: [{
          ref: "V1",
          label: "社团概览",
          target: { kind: "view", viewKey: "society_information" },
        }, {
          ref: "V2",
          label: "测试社团",
          target: { kind: "card", viewKey: "society_information", cardId: societyCardId },
        }],
      },
      viewLabel: "社团概览",
      viewDescription: "社团资料",
      cardTypes: [{
        key: "SocietyCard",
        label: "社团",
        description: "社团资料",
        dimensions: [
          { key: "purpose", label: "宗旨", type: "rich_text" },
          { key: "founded_on", label: "成立时间", type: "date" },
        ],
        slots: [{
          key: "advisor",
          label: "指导老师",
          cardinality: "many",
          allowedTargetCardTypes: ["PersonCard"],
        }, {
          key: "activities",
          label: "活动",
          cardinality: "many",
          allowedTargetCardTypes: ["ActivityCard"],
        }],
      }],
      focus: "完善社团资料、指导老师和活动",
      targetHints: ["测试社团"],
    });

    expect(result.unresolvedAspects).not.toEqual(expect.arrayContaining([
      expect.stringContaining("成立时间尚未记录"),
      expect.stringContaining("指导老师槽位为空"),
      expect.stringContaining("活动槽位为空"),
    ]));
  });
});
