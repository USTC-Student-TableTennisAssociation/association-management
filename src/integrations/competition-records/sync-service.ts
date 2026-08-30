import type { ActorContext, ToolCaller } from "@sydaris/plugin-sdk";
import {
  COMPETITION_EDITION_PROJECT_CAPABILITY,
  COMPETITION_EDITION_PROJECTION_PROVIDER_ID,
  COMPETITION_SOURCE_READ_CAPABILITY,
  COMPETITION_TOOL_CAPABILITY_VERSION,
  competitionEditionProjectOutputSchema,
  competitionSourceBatchSchema,
  type CompetitionSourceReadInput,
  USTCTTA_SOURCE_PROVIDER_ID,
} from "@sydaris/competition-records-plugin/sync-contracts";

import type { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";
import type { ViewCommandBus } from "@/view-runtime/application/command-bus";

export async function syncCompetitionEditions(input: {
  source: CompetitionSourceReadInput;
  caller: Extract<ToolCaller, { kind: "view" | "automation" }>;
  actor: ActorContext;
  toolRuntime: ToolRuntime;
  commandBus: ViewCommandBus;
}) {
  const sourceBatch = competitionSourceBatchSchema.parse(
    await input.toolRuntime.execute({
      capabilityKey: COMPETITION_SOURCE_READ_CAPABILITY,
      capabilityVersion: COMPETITION_TOOL_CAPABILITY_VERSION,
      providerId: USTCTTA_SOURCE_PROVIDER_ID,
      context: {
        caller: input.caller,
        permissions: ["tool.competition.source.read"],
      },
      value: input.source,
    }),
  );
  const projection = competitionEditionProjectOutputSchema.parse(
    await input.toolRuntime.execute({
      capabilityKey: COMPETITION_EDITION_PROJECT_CAPABILITY,
      capabilityVersion: COMPETITION_TOOL_CAPABILITY_VERSION,
      providerId: COMPETITION_EDITION_PROJECTION_PROVIDER_ID,
      context: {
        caller: input.caller,
        permissions: ["tool.competition.edition.project"],
      },
      value: { batch: sourceBatch },
    }),
  );
  const write = await input.commandBus.dispatch({
    viewKey: "competition_records",
    commandKey: "competition.sync_editions",
    commandVersion: "2",
    input: projection,
    actor: {
      ...(input.actor.actorId ? { actorId: input.actor.actorId } : {}),
      permissions: ["view.write"],
    },
    initiator: "system",
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
}
