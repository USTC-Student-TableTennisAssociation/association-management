import { z } from "zod";

import {
  type DomainEventDefinition,
  zodContractSchema,
} from "@sydaris/plugin-sdk";

const uuid = z.string().uuid();

export const competitionRecordsEvents: readonly DomainEventDefinition[] = [
  {
    key: "competition.editions_synced",
    version: "2",
    payloadSchema: zodContractSchema(z.object({
      sourceSystem: z.string().min(1),
      sourceSnapshotAt: z.string().datetime({ offset: true }),
      mappingVersion: z.string().min(1),
      total: z.number().int().min(0),
      created: z.number().int().min(0),
      updated: z.number().int().min(0),
      unchanged: z.number().int().min(0),
    })),
  },
  {
    key: "competition.series_organized",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      seriesCardId: uuid,
      editionCardIds: z.array(uuid),
      created: z.boolean(),
    })),
  },
];
