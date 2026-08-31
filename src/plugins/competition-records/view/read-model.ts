import type { ViewCardState } from "@sydaris/plugin-sdk";

export type CompetitionEditionItem = {
  id: string;
  name: string;
  participantCount: number;
  sequenceNumber?: number;
  heldOn?: string;
  sourceSystem: string;
  sourceId?: string;
  seriesId?: string;
};

export type CompetitionSeriesItem = {
  id: string;
  name: string;
  description?: string;
  cadence?: string;
  editions: readonly CompetitionEditionItem[];
  totalParticipants: number;
  averageParticipants: number;
  peakParticipants: number;
  firstHeldOn?: string;
  latestHeldOn?: string;
};

export type CompetitionYearStat = {
  year: string;
  editionCount: number;
  participantCount: number;
};

export type CompetitionRecordsModel = {
  editions: readonly CompetitionEditionItem[];
  series: readonly CompetitionSeriesItem[];
  unassignedEditions: readonly CompetitionEditionItem[];
  yearStats: readonly CompetitionYearStat[];
  totalParticipants: number;
};

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function compareEditions(
  left: CompetitionEditionItem,
  right: CompetitionEditionItem,
): number {
  const byDate = (right.heldOn ?? "").localeCompare(left.heldOn ?? "");
  if (byDate !== 0) return byDate;
  const bySequence = (right.sequenceNumber ?? -1) - (left.sequenceNumber ?? -1);
  if (bySequence !== 0) return bySequence;
  return left.name.localeCompare(right.name, "zh-CN");
}

function dateRange(editions: readonly CompetitionEditionItem[]): {
  firstHeldOn?: string;
  latestHeldOn?: string;
} {
  const dates = editions.flatMap((edition) => edition.heldOn ? [edition.heldOn] : [])
    .sort((left, right) => left.localeCompare(right));
  return { firstHeldOn: dates[0], latestHeldOn: dates.at(-1) };
}

export function buildCompetitionRecordsModel(
  cards: readonly ViewCardState[],
): CompetitionRecordsModel {
  const seriesCards = cards.filter((card) =>
    card.cardTypeKey === "CompetitionSeriesCard"
  );
  const knownSeriesIds = new Set(seriesCards.map((card) => card.id));
  const editions = cards.filter((card) =>
    card.cardTypeKey === "CompetitionEditionCard"
  ).map((card): CompetitionEditionItem => {
    const slotSeriesId = card.slots.series?.[0];
    return {
      id: card.id,
      name: optionalText(card.dimensions.name) ?? "未命名比赛",
      participantCount: Math.max(0, integer(card.dimensions.participant_count) ?? 0),
      sequenceNumber: integer(card.dimensions.sequence_number),
      heldOn: optionalText(card.dimensions.held_on),
      sourceSystem: optionalText(card.dimensions.source_system) ?? "未知来源",
      sourceId: optionalText(card.dimensions.source_id),
      seriesId: slotSeriesId && knownSeriesIds.has(slotSeriesId)
        ? slotSeriesId
        : undefined,
    };
  }).sort(compareEditions);

  const series = seriesCards.map((card): CompetitionSeriesItem => {
    const relatedEditions = editions.filter((edition) => edition.seriesId === card.id);
    const totalParticipants = relatedEditions.reduce(
      (total, edition) => total + edition.participantCount,
      0,
    );
    const range = dateRange(relatedEditions);
    return {
      id: card.id,
      name: optionalText(card.dimensions.name) ?? "未命名赛事系列",
      description: optionalText(card.dimensions.description),
      cadence: optionalText(card.dimensions.cadence),
      editions: relatedEditions,
      totalParticipants,
      averageParticipants: relatedEditions.length
        ? totalParticipants / relatedEditions.length
        : 0,
      peakParticipants: relatedEditions.reduce(
        (peak, edition) => Math.max(peak, edition.participantCount),
        0,
      ),
      ...range,
    };
  }).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  const yearMap = new Map<string, CompetitionYearStat>();
  for (const edition of editions) {
    const year = /^\d{4}/.exec(edition.heldOn ?? "")?.[0];
    if (!year) continue;
    const current = yearMap.get(year) ?? {
      year,
      editionCount: 0,
      participantCount: 0,
    };
    yearMap.set(year, {
      year,
      editionCount: current.editionCount + 1,
      participantCount: current.participantCount + edition.participantCount,
    });
  }

  return {
    editions,
    series,
    unassignedEditions: editions.filter((edition) => !edition.seriesId),
    yearStats: [...yearMap.values()].sort((left, right) =>
      left.year.localeCompare(right.year)
    ),
    totalParticipants: editions.reduce(
      (total, edition) => total + edition.participantCount,
      0,
    ),
  };
}
