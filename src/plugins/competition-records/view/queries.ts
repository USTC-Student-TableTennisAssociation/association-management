import { z } from "zod";

import {
  type ViewQueryDefinition,
  zodContractSchema,
} from "@sydaris/plugin-sdk";
import {
  buildCompetitionRecordsModel,
  type CompetitionEditionItem,
  type CompetitionRecordsModel,
} from "./read-model.js";

const filterShape = {
  seriesName: z.string().trim().min(1).max(300).optional()
    .describe("赛事系列的完整名称；按规范化后的名称精确匹配"),
  nameContains: z.string().trim().min(1).max(300).optional()
    .describe("届次名称中需要包含的文字"),
  sourceSystem: z.string().trim().min(1).max(200).optional()
    .describe("来源系统完整名称"),
  heldOnFrom: z.iso.date().optional().describe("比赛日期起点，含当天"),
  heldOnThrough: z.iso.date().optional().describe("比赛日期终点，含当天"),
};

function validDateRange(input: { heldOnFrom?: string; heldOnThrough?: string }): boolean {
  return !input.heldOnFrom || !input.heldOnThrough ||
    input.heldOnFrom <= input.heldOnThrough;
}

const listEditionsInputSchema = z.object({
  ...filterShape,
  limit: z.number().int().min(1).max(100).default(50),
}).strict().refine(validDateRange, {
  message: "比赛日期范围的起点不能晚于终点",
});

const participationInputSchema = z.object(filterShape).strict().refine(validDateRange, {
  message: "比赛日期范围的起点不能晚于终点",
});

const editionResultSchema = z.object({
  name: z.string(),
  participantCount: z.number().int().min(0),
  sequenceNumber: z.number().int().positive().optional(),
  heldOn: z.iso.date().optional(),
  sourceSystem: z.string(),
  sourceId: z.string().optional(),
  seriesName: z.string().optional(),
}).strict();

const listEditionsOutputSchema = z.object({
  matchedCount: z.number().int().min(0),
  returnedCount: z.number().int().min(0),
  truncated: z.boolean(),
  editions: z.array(editionResultSchema),
}).strict();

const participationSummaryOutputSchema = z.object({
  editionCount: z.number().int().min(0),
  datedEditionCount: z.number().int().min(0),
  participantCountSum: z.number().int().min(0),
  averageParticipantCountPerEdition: z.number().min(0),
  minimumParticipantCount: z.number().int().min(0),
  maximumParticipantCount: z.number().int().min(0),
  firstHeldOn: z.iso.date().optional(),
  latestHeldOn: z.iso.date().optional(),
  participantCountBasis: z.literal("CompetitionEditionCard.participant_count"),
}).strict();

const participationTrendOutputSchema = z.object({
  points: z.array(z.object({
    year: z.string().regex(/^\d{4}$/),
    editionCount: z.number().int().positive(),
    participantCountSum: z.number().int().min(0),
    averageParticipantCountPerEdition: z.number().min(0),
  }).strict()),
  undatedEditionCount: z.number().int().min(0),
  participantCountBasis: z.literal("CompetitionEditionCard.participant_count"),
}).strict();

type CompetitionFilters = z.infer<typeof participationInputSchema>;
type ListEditionsInput = z.infer<typeof listEditionsInputSchema>;
type ListEditionsOutput = z.infer<typeof listEditionsOutputSchema>;
type ParticipationSummaryOutput = z.infer<typeof participationSummaryOutputSchema>;
type ParticipationTrendOutput = z.infer<typeof participationTrendOutputSchema>;

function searchable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function selectEditions(
  model: CompetitionRecordsModel,
  input: CompetitionFilters,
): {
  editions: CompetitionEditionItem[];
  sourceCardIds: string[];
  seriesNameById: ReadonlyMap<string, string>;
} {
  const seriesNameById = new Map(model.series.map((series) => [series.id, series.name]));
  const requestedSeries = input.seriesName ? searchable(input.seriesName) : undefined;
  const matchingSeriesIds = new Set(model.series.flatMap((series) =>
    requestedSeries && searchable(series.name) === requestedSeries ? [series.id] : []
  ));
  const requestedName = input.nameContains ? searchable(input.nameContains) : undefined;
  const requestedSource = input.sourceSystem ? searchable(input.sourceSystem) : undefined;
  const editions = model.editions.filter((edition) => {
    if (requestedSeries && (!edition.seriesId || !matchingSeriesIds.has(edition.seriesId))) {
      return false;
    }
    if (requestedName && !searchable(edition.name).includes(requestedName)) return false;
    if (requestedSource && searchable(edition.sourceSystem) !== requestedSource) return false;
    if (input.heldOnFrom && (!edition.heldOn || edition.heldOn < input.heldOnFrom)) return false;
    if (input.heldOnThrough && (!edition.heldOn || edition.heldOn > input.heldOnThrough)) return false;
    return true;
  });
  const sourceCardIds = [...new Set([
    ...(requestedSeries ? [...matchingSeriesIds] : []),
    ...editions.map((edition) => edition.id),
    ...editions.flatMap((edition) => edition.seriesId ? [edition.seriesId] : []),
  ])];
  return { editions, sourceCardIds, seriesNameById };
}

function presentEdition(
  edition: CompetitionEditionItem,
  seriesNameById: ReadonlyMap<string, string>,
): z.infer<typeof editionResultSchema> {
  return {
    name: edition.name,
    participantCount: edition.participantCount,
    ...(edition.sequenceNumber ? { sequenceNumber: edition.sequenceNumber } : {}),
    ...(edition.heldOn ? { heldOn: edition.heldOn } : {}),
    sourceSystem: edition.sourceSystem,
    ...(edition.sourceId ? { sourceId: edition.sourceId } : {}),
    ...(edition.seriesId && seriesNameById.get(edition.seriesId)
      ? { seriesName: seriesNameById.get(edition.seriesId)! }
      : {}),
  };
}

const listEditions: ViewQueryDefinition<ListEditionsInput, ListEditionsOutput> = {
  key: "list_editions",
  version: "1.0.0",
  label: "筛选比赛届次",
  description:
    "按赛事系列、届次名称、来源系统和日期范围读取正式比赛届次；适合查看筛选后的原始业务记录。",
  inputSchema: zodContractSchema(listEditionsInputSchema),
  outputSchema: zodContractSchema(listEditionsOutputSchema),
  execute: (snapshot, input) => {
    const selected = selectEditions(buildCompetitionRecordsModel(snapshot.cards), input);
    const returned = selected.editions.slice(0, input.limit);
    const truncated = returned.length < selected.editions.length;
    return {
      data: {
        matchedCount: selected.editions.length,
        returnedCount: returned.length,
        truncated,
        editions: returned.map((edition) =>
          presentEdition(edition, selected.seriesNameById)
        ),
      },
      sourceCardIds: selected.sourceCardIds,
      coverage: truncated
        ? {
            level: "partial",
            reason: `匹配 ${selected.editions.length} 届，只返回前 ${returned.length} 届。`,
          }
        : { level: "complete" },
    };
  },
};

const summarizeParticipation: ViewQueryDefinition<
  CompetitionFilters,
  ParticipationSummaryOutput
> = {
  key: "summarize_participation",
  version: "1.0.0",
  label: "汇总比赛参与数据",
  description:
    "对筛选后的正式比赛届次计算届次数、跨届参与人次、每届平均参与人数、最小值、最大值和日期范围。",
  inputSchema: zodContractSchema(participationInputSchema),
  outputSchema: zodContractSchema(participationSummaryOutputSchema),
  execute: (snapshot, input) => {
    const selected = selectEditions(buildCompetitionRecordsModel(snapshot.cards), input);
    const counts = selected.editions.map((edition) => edition.participantCount);
    const dates = selected.editions.flatMap((edition) => edition.heldOn ? [edition.heldOn] : [])
      .sort((left, right) => left.localeCompare(right));
    const participantCountSum = counts.reduce((total, count) => total + count, 0);
    return {
      data: {
        editionCount: selected.editions.length,
        datedEditionCount: dates.length,
        participantCountSum,
        averageParticipantCountPerEdition: counts.length
          ? participantCountSum / counts.length
          : 0,
        minimumParticipantCount: counts.length ? Math.min(...counts) : 0,
        maximumParticipantCount: counts.length ? Math.max(...counts) : 0,
        ...(dates[0] ? { firstHeldOn: dates[0] } : {}),
        ...(dates.at(-1) ? { latestHeldOn: dates.at(-1)! } : {}),
        participantCountBasis: "CompetitionEditionCard.participant_count",
      },
      sourceCardIds: selected.sourceCardIds,
      coverage: { level: "complete" },
    };
  },
};

const participationTrend: ViewQueryDefinition<
  CompetitionFilters,
  ParticipationTrendOutput
> = {
  key: "participation_trend",
  version: "1.0.0",
  label: "查看比赛参与趋势",
  description:
    "按比赛日期年份汇总正式届次的届次数、跨届参与人次和每届平均参与人数，并单列缺少日期的届次。",
  inputSchema: zodContractSchema(participationInputSchema),
  outputSchema: zodContractSchema(participationTrendOutputSchema),
  execute: (snapshot, input) => {
    const selected = selectEditions(buildCompetitionRecordsModel(snapshot.cards), input);
    const byYear = new Map<string, { editionCount: number; participantCountSum: number }>();
    let undatedEditionCount = 0;
    for (const edition of selected.editions) {
      const year = /^\d{4}/.exec(edition.heldOn ?? "")?.[0];
      if (!year) {
        undatedEditionCount += 1;
        continue;
      }
      const current = byYear.get(year) ?? { editionCount: 0, participantCountSum: 0 };
      byYear.set(year, {
        editionCount: current.editionCount + 1,
        participantCountSum: current.participantCountSum + edition.participantCount,
      });
    }
    return {
      data: {
        points: [...byYear].sort(([left], [right]) => left.localeCompare(right))
          .map(([year, point]) => ({
            year,
            editionCount: point.editionCount,
            participantCountSum: point.participantCountSum,
            averageParticipantCountPerEdition:
              point.participantCountSum / point.editionCount,
          })),
        undatedEditionCount,
        participantCountBasis: "CompetitionEditionCard.participant_count",
      },
      sourceCardIds: selected.sourceCardIds,
      coverage: { level: "complete" },
    };
  },
};

export const competitionRecordsQueries: readonly ViewQueryDefinition[] = [
  listEditions,
  summarizeParticipation,
  participationTrend,
];
