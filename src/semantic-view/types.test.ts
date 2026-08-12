import { describe, expect, it } from "vitest";

import {
  businessViewDefinition,
  cardTypeDefinition,
  societyInformationCardTypes,
} from "@/semantic-view/card-types";
import {
  assertSameBusinessView,
  SemanticViewValidationError,
} from "@/semantic-view/service";
import { viewChangePayloadSchema } from "@/semantic-view/types";

const societyObjectId = "c28d1424-133c-5724-bad9-7cf80d899dd2";
const assertionId = "73f322cd-3062-42de-a96e-4f8a0e52dbb8";

describe("society_information change protocol", () => {
  it("accepts the three walking-skeleton SET operations", () => {
    const payload = viewChangePayloadSchema.parse({
      viewKey: "society_information",
      reason: "把已有事实形成可确认的社团信息。",
      changes: [
        {
          type: "CREATE_CARD",
          cardRef: "society",
          sourceObjectId: societyObjectId,
          cardTypeKey: "SocietyCard",
        },
        {
          type: "SET_CONTENT_DIMENSION",
          card: "new:society",
          name: "社团星级",
          contentMarkdown: "三星级社团",
          supportingAssertionIds: [assertionId],
        },
        {
          type: "SET_SLOT",
          card: "new:society",
          slotKey: "advisor",
          targets: [],
          supportingAssertionIds: [],
        },
      ],
    });

    expect(payload.changes.map((change) => change.type)).toEqual([
      "CREATE_CARD",
      "SET_CONTENT_DIMENSION",
      "SET_SLOT",
    ]);
  });

  it("accepts a user-confirmed ContentDimension change without Assertion support", () => {
    const payload = viewChangePayloadSchema.parse({
      viewKey: "society_information",
      reason: "用户明确要求修改正式业务状态",
      changes: [{
        type: "SET_CONTENT_DIMENSION",
        card: societyObjectId,
        name: "社团星级",
        contentMarkdown: "五星",
      }],
    });

    expect(payload.changes[0]).toMatchObject({
      type: "SET_CONTENT_DIMENSION",
      supportingAssertionIds: [],
    });
  });

  it("defines the formal Society Information card graph", () => {
    expect(businessViewDefinition("society_information")).toMatchObject({
      label: "社团信息",
      specializedLabel: "社团概览",
    });
    expect(Object.keys(societyInformationCardTypes)).toEqual([
      "SocietyCard",
      "PersonCard",
      "PositionCard",
      "ActivityCard",
      "PlatformCard",
    ]);
    expect(societyInformationCardTypes.SocietyCard.seedContentDimensions).toEqual([
      "社团星级",
      "成立时间",
      "宗旨",
      "简介",
    ]);
    expect(societyInformationCardTypes.SocietyCard.slots).toMatchObject({
      advisor: { allowedTargetCardTypes: ["PersonCard"], cardinality: "many" },
      positions: { allowedTargetCardTypes: ["PositionCard"], cardinality: "many" },
      activities: { allowedTargetCardTypes: ["ActivityCard"], cardinality: "many" },
      platforms: { allowedTargetCardTypes: ["PlatformCard"], cardinality: "many" },
    });
    expect(societyInformationCardTypes.PositionCard.slots.holders).toMatchObject({
      allowedTargetCardTypes: ["PersonCard"],
      cardinality: "many",
    });
  });

  it("resolves Card Types inside a Business View rather than globally", () => {
    expect(cardTypeDefinition("society_information", "ActivityCard")?.viewKey)
      .toBe("society_information");
    expect(cardTypeDefinition("unknown_view", "ActivityCard")).toBeUndefined();
  });

  it("deterministically rejects cross-View SlotBinding", () => {
    expect(() => assertSameBusinessView(
      { selector: "source", viewKey: "society_information" },
      { selector: "target", viewKey: "activity_operations" },
    )).toThrow(SemanticViewValidationError);
  });
});
