import { describe, expect, it } from "vitest";

import type { ViewCardState, ViewQueryDefinition, ViewReadSnapshot } from "@/contracts";
import { competitionRecordsQueries } from "@/plugins/competition-records/view/queries";

const IDS = {
  series: "00000000-0000-4000-8000-000000000101",
  first: "00000000-0000-4000-8000-000000000201",
  second: "00000000-0000-4000-8000-000000000202",
  other: "00000000-0000-4000-8000-000000000203",
  undated: "00000000-0000-4000-8000-000000000204",
};

function card(
  input: Partial<ViewCardState> & Pick<ViewCardState, "id" | "cardTypeKey">,
): ViewCardState {
  return {
    id: input.id,
    viewKey: "competition_records",
    cardTypeKey: input.cardTypeKey,
    dimensions: input.dimensions ?? {},
    slots: input.slots ?? {},
    relatedObjectIds: input.relatedObjectIds ?? [],
  };
}

const snapshot: ViewReadSnapshot = {
  viewKey: "competition_records",
  pluginVersion: "0.4.0",
  schemaVersion: "1",
  stateVersion: "8",
  observedAt: "2026-08-31T00:00:00.000Z",
  cards: [
    card({
      id: IDS.series,
      cardTypeKey: "CompetitionSeriesCard",
      dimensions: { name: "积分赛" },
    }),
    card({
      id: IDS.first,
      cardTypeKey: "CompetitionEditionCard",
      dimensions: {
        name: "第一周积分赛",
        participant_count: 30,
        held_on: "2025-09-01",
        source_system: "USTCTTA-site",
      },
      slots: { series: [IDS.series] },
    }),
    card({
      id: IDS.second,
      cardTypeKey: "CompetitionEditionCard",
      dimensions: {
        name: "第二周积分赛",
        participant_count: 42,
        held_on: "2025-09-08",
        source_system: "USTCTTA-site",
      },
      slots: { series: [IDS.series] },
    }),
    card({
      id: IDS.other,
      cardTypeKey: "CompetitionEditionCard",
      dimensions: {
        name: "院系杯",
        participant_count: 72,
        held_on: "2026-04-12",
        source_system: "USTCTTA-site",
      },
    }),
    card({
      id: IDS.undated,
      cardTypeKey: "CompetitionEditionCard",
      dimensions: {
        name: "早期积分赛",
        participant_count: 10,
        source_system: "USTCTTA-site",
      },
      slots: { series: [IDS.series] },
    }),
  ],
};

function query(key: string): ViewQueryDefinition {
  const definition = competitionRecordsQueries.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`Query ${key} is missing`);
  return definition;
}

async function execute(key: string, input: unknown) {
  const definition = query(key);
  const parsed = definition.inputSchema.parse(input);
  const outcome = await definition.execute(snapshot, parsed);
  return {
    ...outcome,
    data: definition.outputSchema.parse(outcome.data),
  };
}

describe("Competition Records View Queries", () => {
  it("filters and bounds Edition records while reporting partial coverage", async () => {
    const outcome = await execute("list_editions", {
      seriesName: "积分赛",
      limit: 1,
    });

    expect(outcome.data).toEqual({
      matchedCount: 3,
      returnedCount: 1,
      truncated: true,
      editions: [{
        name: "第二周积分赛",
        participantCount: 42,
        heldOn: "2025-09-08",
        sourceSystem: "USTCTTA-site",
        seriesName: "积分赛",
      }],
    });
    expect(outcome.sourceCardIds).toEqual([
      IDS.series,
      IDS.second,
      IDS.first,
      IDS.undated,
    ]);
    expect(outcome.coverage).toEqual({
      level: "partial",
      reason: "匹配 3 届，只返回前 1 届。",
    });
  });

  it("summarizes participant counts from all matching formal Editions", async () => {
    const outcome = await execute("summarize_participation", {
      seriesName: "积分赛",
    });

    expect(outcome.data).toEqual({
      editionCount: 3,
      datedEditionCount: 2,
      participantCountSum: 82,
      averageParticipantCountPerEdition: 82 / 3,
      minimumParticipantCount: 10,
      maximumParticipantCount: 42,
      firstHeldOn: "2025-09-01",
      latestHeldOn: "2025-09-08",
      participantCountBasis: "CompetitionEditionCard.participant_count",
    });
    expect(outcome.coverage).toEqual({ level: "complete" });
  });

  it("builds a yearly trend and keeps undated Editions visible", async () => {
    const outcome = await execute("participation_trend", {
      seriesName: "积分赛",
    });

    expect(outcome.data).toEqual({
      points: [{
        year: "2025",
        editionCount: 2,
        participantCountSum: 72,
        averageParticipantCountPerEdition: 36,
      }],
      undatedEditionCount: 1,
      participantCountBasis: "CompetitionEditionCard.participant_count",
    });
    expect(outcome.coverage).toEqual({ level: "complete" });
  });
});
