import { z } from "zod";

import type { DomainEventDefinition } from "@/contracts";
import { zodContractSchema } from "@/contracts";

const uuid = z.string().uuid();

export const competitionRecordsEvents: readonly DomainEventDefinition[] = [
  {
    key: "competition.edition_created",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      cardId: uuid,
      objectId: uuid.nullable(),
    })),
  },
  {
    key: "competition.edition_updated",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      cardId: uuid,
      changedDimensions: z.array(z.string().min(1)),
    })),
  },
  {
    key: "competition.editions_synced",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      sourceSystem: z.string().min(1),
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
