import { z } from "zod";

import type { DomainEventDefinition } from "@/contracts";
import { zodContractSchema } from "@/contracts";

export const societyInformationEvents: readonly DomainEventDefinition[] = [
  {
    key: "society.person_ensured",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      cardId: z.string().uuid(),
      objectId: z.string().uuid(),
      created: z.boolean(),
    })),
  },
  {
    key: "society.society_created",
    version: "1",
    payloadSchema: zodContractSchema(z.object({ cardId: z.string().uuid() })),
  },
  {
    key: "society.profile_updated",
    version: "1",
    payloadSchema: zodContractSchema(z.object({ cardId: z.string().uuid() })),
  },
];
