import { describe, expect, it, vi } from "vitest";

import {
  projectCompetitionEditions,
  sequenceNumberFromTitle,
} from "@/plugins/competition-records/tools/edition-provider";
import {
  readUstcttaCompetitionData,
  type UstcttaCompetitionQuery,
  type UstcttaCompetitionSnapshotRunner,
} from "@/plugins/competition-records/tools/source-provider";
import { competitionSourceReadInputSchema } from "@/plugins/competition-records/tools/contracts";

function sourceRow(input: {
  sourceId?: string;
  dateTime?: string;
  title?: string;
  participantCount?: number;
} = {}) {
  const dateTime = input.dateTime ?? "2026-06-26T11:00:00.000Z";
  return {
    sourceId: input.sourceId ?? "match-15",
    title: input.title ?? "[26夏季积分赛] 第十五周",
    description: "周度积分赛",
    dateTime: new Date(dateTime),
    heldOn: dateTime.slice(0, 10),
    location: "东区体育馆",
    isQuickMatch: false,
    matchType: "single" as const,
    status: "ongoing" as const,
    format: "group_only" as const,
    maxParticipants: 64,
    registrationDeadline: new Date("2026-06-26T10:00:00.000Z"),
    participantCount: input.participantCount ?? 13,
    participantCountBasis: "active_individual_registrations" as const,
    competitorUnitCount: input.participantCount ?? 13,
    resultCount: 24,
    sourceCreatedAt: new Date("2026-06-20T00:00:00.000Z"),
    sourceUpdatedAt: new Date("2026-06-26T12:00:00.000Z"),
  };
}

function snapshotRunner(
  query: UstcttaCompetitionQuery,
): UstcttaCompetitionSnapshotRunner {
  return async (read) => read({
    sourceSnapshotAt: "2026-08-28T00:00:00.000Z",
    query,
  });
}

describe("USTCTTA competition source Tool", () => {
  it("returns reusable competition data without participant identities", async () => {
    const query = vi.fn(async () => [sourceRow()]);

    const result = await readUstcttaCompetitionData({
      includeQuickMatches: false,
    }, {
      runInSnapshot: snapshotRunner(query),
    });

    expect(result).toMatchObject({
      sourceSystem: "USTCTTA-site",
      sourceSchemaVersion: "1",
      sourceSnapshotAt: "2026-08-28T00:00:00.000Z",
      complete: true,
      pageCount: 1,
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

  it("reads every internal page without exposing a total-result limit", async () => {
    const newest = sourceRow({
      sourceId: "match-3",
      dateTime: "2026-06-03T11:00:00.000Z",
    });
    const middle = sourceRow({
      sourceId: "match-2",
      dateTime: "2026-06-02T11:00:00.000Z",
    });
    const oldest = sourceRow({
      sourceId: "match-1",
      dateTime: "2026-06-01T11:00:00.000Z",
    });
    const query = vi.fn(async (_text: string, values: readonly unknown[]) =>
      values.length === 1 ? [newest, middle, oldest] : [oldest]
    );

    const result = await readUstcttaCompetitionData({
      includeQuickMatches: false,
    }, {
      runInSnapshot: snapshotRunner(query),
      pageSize: 2,
    });

    expect(result.records.map((record) => record.sourceId)).toEqual([
      "match-3",
      "match-2",
      "match-1",
    ]);
    expect(result).toMatchObject({ complete: true, pageCount: 2 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual([
      "2026-06-02T11:00:00.000Z",
      "match-2",
      3,
    ]);
  });

  it("rejects the removed limit and unsafe updatedAfter inputs", () => {
    expect(competitionSourceReadInputSchema.safeParse({ limit: 200 }).success).toBe(false);
    expect(competitionSourceReadInputSchema.safeParse({
      updatedAfter: "2026-08-28T00:00:00.000Z",
    }).success).toBe(false);
  });
});

describe("competition Edition projection Tool", () => {
  it("maps source identity, participant count, date, and a deterministic ordinal", () => {
    const projected = projectCompetitionEditions({
      batch: {
        sourceSystem: "USTCTTA-site",
        sourceSchemaVersion: "1",
        sourceSnapshotAt: "2026-08-28T00:00:00.000Z",
        complete: true,
        pageCount: 1,
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
