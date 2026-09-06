import { z } from "zod";

import type { ViewOperationDefinition } from "@sydaris/plugin-sdk";
import { zodContractSchema } from "@sydaris/plugin-sdk";

import {
  COMPETITION_EDITION_PROJECT_CAPABILITY,
  COMPETITION_EDITION_PROJECTION_PROVIDER_ID,
  COMPETITION_SOURCE_READ_CAPABILITY,
  COMPETITION_TOOL_CAPABILITY_VERSION,
  competitionEditionProjectOutputSchema,
  competitionSourceBatchSchema,
  competitionSourceReadInputSchema,
  type CompetitionSourceReadInput,
  USTCTTA_SOURCE_PROVIDER_ID,
} from "../tools/contracts.js";

export const COMPETITION_SYNC_OPERATION_KEY = "competition.sync_from_source";

const viewCommandResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("proposed"),
    proposalId: z.string(),
    viewKey: z.string(),
    stateVersion: z.string(),
  }),
  z.object({
    kind: z.literal("executed"),
    executionId: z.string(),
    viewKey: z.string(),
    stateVersion: z.string(),
    summary: z.unknown().optional(),
    reaction: z.unknown().optional(),
  }),
]);

export const competitionSyncSummarySchema = z.object({
  source: z.object({
    sourceSystem: z.string(),
    sourceSnapshotAt: z.string().datetime({ offset: true }),
    complete: z.literal(true),
    pageCount: z.number().int().positive(),
    recordCount: z.number().int().nonnegative(),
  }),
  mapping: z.object({
    version: z.string(),
    editionCount: z.number().int().nonnegative(),
  }),
  write: viewCommandResultSchema,
});

export type CompetitionSyncSummary = z.infer<typeof competitionSyncSummarySchema>;

export const competitionSyncOperation: ViewOperationDefinition<
  CompetitionSourceReadInput,
  CompetitionSyncSummary
> = {
  key: COMPETITION_SYNC_OPERATION_KEY,
  version: "1.0.0",
  label: "同步比赛届次",
  description: "读取完整的权威比赛快照，将其映射并同步到赛事档案 View。",
  requiredPermissions: ["view.write"],
  requiresCapabilities: [
    { key: COMPETITION_SOURCE_READ_CAPABILITY, versions: "^2.0.0" },
    { key: COMPETITION_EDITION_PROJECT_CAPABILITY, versions: "^2.0.0" },
  ],
  commands: ["competition.sync_editions"],
  inputSchema: zodContractSchema(competitionSourceReadInputSchema),
  outputSchema: zodContractSchema(competitionSyncSummarySchema),
  async execute(context, input) {
    const sourceBatch = competitionSourceBatchSchema.parse(
      await context.executeTool({
        capabilityKey: COMPETITION_SOURCE_READ_CAPABILITY,
        capabilityVersion: COMPETITION_TOOL_CAPABILITY_VERSION,
        providerId: USTCTTA_SOURCE_PROVIDER_ID,
        input,
      }),
    );
    const projection = competitionEditionProjectOutputSchema.parse(
      await context.executeTool({
        capabilityKey: COMPETITION_EDITION_PROJECT_CAPABILITY,
        capabilityVersion: COMPETITION_TOOL_CAPABILITY_VERSION,
        providerId: COMPETITION_EDITION_PROJECTION_PROVIDER_ID,
        input: { batch: sourceBatch },
      }),
    );
    const write = await context.dispatchCommand({
      commandKey: "competition.sync_editions",
      commandVersion: "2",
      input: projection,
    });
    return {
      source: {
        sourceSystem: sourceBatch.sourceSystem,
        sourceSnapshotAt: sourceBatch.sourceSnapshotAt,
        complete: sourceBatch.complete,
        pageCount: sourceBatch.pageCount,
        recordCount: sourceBatch.records.length,
      },
      mapping: {
        version: projection.mappingVersion,
        editionCount: projection.editions.length,
      },
      write,
    };
  },
};
