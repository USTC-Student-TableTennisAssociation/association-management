import { z } from "zod";

import {
  type ToolCapabilityContract,
  zodContractSchema,
} from "@sydaris/plugin-sdk";

export const USTCTTA_SOURCE_SYSTEM = "USTCTTA-site";
export const COMPETITION_SOURCE_READ_CAPABILITY = "competition.source.read";
export const COMPETITION_EDITION_PROJECT_CAPABILITY = "competition.edition.project";
export const COMPETITION_TOOL_CAPABILITY_VERSION = "2.0.0";
export const USTCTTA_SOURCE_PROVIDER_ID = "ustctta.competition-source";
export const COMPETITION_EDITION_PROJECTION_PROVIDER_ID =
  "sydaris.competition-edition-projection";

export const competitionSourceReadInputSchema = z.object({
  sourceIds: z.array(z.string().trim().min(1).max(300)).optional(),
  heldOnFrom: z.iso.date().optional(),
  heldOnThrough: z.iso.date().optional(),
  includeQuickMatches: z.boolean().default(false),
}).strict().refine(
  (input) => !input.heldOnFrom || !input.heldOnThrough ||
    input.heldOnFrom <= input.heldOnThrough,
  { message: "比赛日期范围的起始日期不能晚于结束日期" },
);

export const sourceCompetitionRecordSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  dateTime: z.string().datetime({ offset: true }),
  heldOn: z.iso.date(),
  location: z.string().nullable(),
  isQuickMatch: z.boolean(),
  matchType: z.enum(["single", "double", "team"]),
  status: z.enum(["registration", "ongoing", "finished"]),
  format: z.enum(["group_only", "group_then_knockout"]),
  maxParticipants: z.number().int().min(0),
  registrationDeadline: z.string().datetime({ offset: true }),
  participantCount: z.number().int().min(0),
  participantCountBasis: z.enum([
    "active_individual_registrations",
    "registered_doubles_team_members",
    "approved_team_members",
  ]),
  competitorUnitCount: z.number().int().min(0),
  resultCount: z.number().int().min(0),
  sourceCreatedAt: z.string().datetime({ offset: true }),
  sourceUpdatedAt: z.string().datetime({ offset: true }),
});

export const competitionSourceBatchSchema = z.object({
  sourceSystem: z.literal(USTCTTA_SOURCE_SYSTEM),
  sourceSchemaVersion: z.literal("1"),
  sourceSnapshotAt: z.string().datetime({ offset: true }),
  complete: z.literal(true),
  pageCount: z.number().int().positive(),
  records: z.array(sourceCompetitionRecordSchema),
});

export const competitionEditionProjectionSchema = z.object({
  sourceSystem: z.literal(USTCTTA_SOURCE_SYSTEM),
  sourceId: z.string().min(1),
  name: z.string().trim().min(1).max(300),
  participantCount: z.number().int().min(0),
  sequenceNumber: z.number().int().positive().optional(),
  heldOn: z.iso.date(),
});

export const competitionEditionProjectInputSchema = z.object({
  batch: competitionSourceBatchSchema,
});

export const competitionEditionProjectOutputSchema = z.object({
  sourceSystem: z.literal(USTCTTA_SOURCE_SYSTEM),
  sourceSchemaVersion: z.literal("1"),
  mappingVersion: z.literal("1"),
  sourceSnapshotAt: z.string().datetime({ offset: true }),
  editions: z.array(competitionEditionProjectionSchema),
});

export type CompetitionSourceReadInput = z.infer<typeof competitionSourceReadInputSchema>;
export type SourceCompetitionRecord = z.infer<typeof sourceCompetitionRecordSchema>;
export type CompetitionSourceBatch = z.infer<typeof competitionSourceBatchSchema>;
export type CompetitionEditionProjection = z.infer<typeof competitionEditionProjectionSchema>;
export type CompetitionEditionProjectInput = z.infer<
  typeof competitionEditionProjectInputSchema
>;
export type CompetitionEditionProjectOutput = z.infer<
  typeof competitionEditionProjectOutputSchema
>;

export const competitionToolCapabilityContracts: readonly ToolCapabilityContract[] = [
  {
    key: COMPETITION_SOURCE_READ_CAPABILITY,
    version: COMPETITION_TOOL_CAPABILITY_VERSION,
    description: "读取 USTCTTA-site 的比赛源数据及确定性参赛统计。",
    semanticContract: [
      "只读取比赛级数据，不返回选手姓名、邮箱、学号或其他个人信息。",
      "参赛人数由 Provider 根据单打、双打和团体赛的源系统报名口径确定性计算。",
      "返回值覆盖请求范围在 sourceSnapshotAt 对应数据库快照中的全部比赛；内部批大小不得截断结果。",
      "不创建或修改 Echo Card。",
    ].join("\n"),
    inputSchema: zodContractSchema(competitionSourceReadInputSchema),
    outputSchema: zodContractSchema(competitionSourceBatchSchema),
    sideEffect: "none",
    allowedCallers: ["view", "automation"],
    requiredPermissions: ["tool.competition.source.read"],
  },
  {
    key: COMPETITION_EDITION_PROJECT_CAPABILITY,
    version: COMPETITION_TOOL_CAPABILITY_VERSION,
    description: "将比赛源数据确定性映射为 CompetitionEditionCard 写入投影。",
    semanticContract: [
      "映射是无副作用纯转换，不访问 AI，不直接写数据库。",
      "只接受 Source Tool 已确认完整的批次，并保留其 sourceSnapshotAt。",
      "保留 sourceSystem/sourceId 作为幂等身份，使用源数据的参赛人数和比赛日期。",
    ].join("\n"),
    inputSchema: zodContractSchema(competitionEditionProjectInputSchema),
    outputSchema: zodContractSchema(competitionEditionProjectOutputSchema),
    sideEffect: "none",
    allowedCallers: ["view", "automation"],
    requiredPermissions: ["tool.competition.edition.project"],
  },
];
