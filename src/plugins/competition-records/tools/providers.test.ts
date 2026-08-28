import { describe, expect, it, vi } from "vitest";

import {
  projectCompetitionEditions,
  sequenceNumberFromTitle,
} from "@/plugins/competition-records/tools/edition-provider";
import {
  readUstcttaCompetitionData,
} from "@/plugins/competition-records/tools/source-provider";

describe("USTCTTA competition source Tool", () => {
  it("returns reusable competition data without participant identities", async () => {
    const query = vi.fn(async () => [{
      sourceId: "match-15",
      title: "[26夏季积分赛] 第十五周",
      description: "周度积分赛",
      dateTime: new Date("2026-06-26T11:00:00.000Z"),
      heldOn: "2026-06-26",
      location: "东区体育馆",
      isQuickMatch: false,
      matchType: "single" as const,
      status: "ongoing" as const,
      format: "group_only" as const,
      maxParticipants: 64,
      registrationDeadline: new Date("2026-06-26T10:00:00.000Z"),
      participantCount: 13,
      participantCountBasis: "active_individual_registrations" as const,
      competitorUnitCount: 13,
      resultCount: 24,
      sourceCreatedAt: new Date("2026-06-20T00:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-06-26T12:00:00.000Z"),
    }]);

    const result = await readUstcttaCompetitionData({
      includeQuickMatches: false,
      limit: 200,
    }, {
      query,
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      sourceSystem: "USTCTTA-site",
      sourceSchemaVersion: "1",
      records: [{
        sourceId: "match-15",
        title: "[26夏季积分赛] 第十五周",
        participantCount: 13,
        participantCountBasis: "active_individual_registrations",
        resultCount: 24,
      }],
    });
    expect(query).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/nickname|email|student/i);
  });
});

describe("competition Edition projection Tool", () => {
  it("maps source identity, participant count, date, and a deterministic ordinal", () => {
    const projected = projectCompetitionEditions({
      batch: {
        sourceSystem: "USTCTTA-site",
        sourceSchemaVersion: "1",
        retrievedAt: "2026-08-28T00:00:00.000Z",
        records: [{
          sourceId: "match-15",
          title: "[26夏季积分赛] 第十五周",
          description: null,
          dateTime: "2026-06-26T11:00:00.000Z",
          heldOn: "2026-06-26",
          location: null,
          isQuickMatch: false,
          matchType: "single",
          status: "ongoing",
          format: "group_only",
          maxParticipants: 64,
          registrationDeadline: "2026-06-26T10:00:00.000Z",
          participantCount: 13,
          participantCountBasis: "active_individual_registrations",
          competitorUnitCount: 13,
          resultCount: 24,
          sourceCreatedAt: "2026-06-20T00:00:00.000Z",
          sourceUpdatedAt: "2026-06-26T12:00:00.000Z",
        }],
      },
    });

    expect(projected.editions).toEqual([{
      sourceSystem: "USTCTTA-site",
      sourceId: "match-15",
      name: "[26夏季积分赛] 第十五周",
      participantCount: 13,
      sequenceNumber: 15,
      heldOn: "2026-06-26",
    }]);
    expect(sequenceNumberFromTitle("第105届会员大赛")).toBe(105);
  });
});
