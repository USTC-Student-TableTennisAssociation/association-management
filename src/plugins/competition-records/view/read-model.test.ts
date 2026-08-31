import { describe, expect, it } from "vitest";

import type { ViewCardState } from "@sydaris/plugin-sdk";
import {
  buildCompetitionRecordsModel,
} from "@/plugins/competition-records/view/read-model";

function card(input: Partial<ViewCardState> & Pick<ViewCardState, "id" | "cardTypeKey">) {
  return {
    id: input.id,
    viewKey: "competition_records",
    cardTypeKey: input.cardTypeKey,
    dimensions: input.dimensions ?? {},
    slots: input.slots ?? {},
    relatedObjectIds: input.relatedObjectIds ?? [],
  } satisfies ViewCardState;
}

describe("competition records read model", () => {
  it("groups editions through the Series Slot and derives chart statistics", () => {
    const model = buildCompetitionRecordsModel([
      card({
        id: "series-1",
        cardTypeKey: "CompetitionSeriesCard",
        dimensions: { name: "积分赛", cadence: "每学期多次" },
      }),
      card({
        id: "edition-1",
        cardTypeKey: "CompetitionEditionCard",
        dimensions: {
          name: "第一周",
          participant_count: 30,
          held_on: "2025-09-01",
          source_system: "USTCTTA-site",
        },
        slots: { series: ["series-1"] },
      }),
      card({
        id: "edition-2",
        cardTypeKey: "CompetitionEditionCard",
        dimensions: {
          name: "第二周",
          participant_count: 42,
          held_on: "2025-09-08",
          source_system: "USTCTTA-site",
        },
        slots: { series: ["series-1"] },
      }),
      card({
        id: "edition-3",
        cardTypeKey: "CompetitionEditionCard",
        dimensions: {
          name: "院系杯",
          participant_count: 72,
          held_on: "2026-04-12",
          source_system: "USTCTTA-site",
        },
      }),
    ]);

    expect(model.editions.map((edition) => edition.id)).toEqual([
      "edition-3",
      "edition-2",
      "edition-1",
    ]);
    expect(model.series[0]).toMatchObject({
      name: "积分赛",
      totalParticipants: 72,
      averageParticipants: 36,
      peakParticipants: 42,
      firstHeldOn: "2025-09-01",
      latestHeldOn: "2025-09-08",
    });
    expect(model.unassignedEditions.map((edition) => edition.id)).toEqual(["edition-3"]);
    expect(model.yearStats).toEqual([
      { year: "2025", editionCount: 2, participantCount: 72 },
      { year: "2026", editionCount: 1, participantCount: 72 },
    ]);
    expect(model.totalParticipants).toBe(144);
  });

  it("treats a dangling Series Slot as unassigned and normalizes invalid counts", () => {
    const model = buildCompetitionRecordsModel([
      card({
        id: "edition-1",
        cardTypeKey: "CompetitionEditionCard",
        dimensions: {
          name: " ",
          participant_count: -4,
          source_system: "",
        },
        slots: { series: ["missing-series"] },
      }),
    ]);

    expect(model.editions[0]).toMatchObject({
      name: "未命名比赛",
      participantCount: 0,
      sourceSystem: "未知来源",
      seriesId: undefined,
    });
    expect(model.unassignedEditions).toHaveLength(1);
    expect(model.yearStats).toEqual([]);
  });
});
