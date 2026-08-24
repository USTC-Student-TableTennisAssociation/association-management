import { z } from "zod";

import type { DomainEventDefinition } from "@/contracts";
import { zodContractSchema } from "@/contracts";

const uuid = z.string().uuid();
const cardAndSociety = z.object({ cardId: uuid, societyCardId: uuid });
const changedCard = cardAndSociety.extend({ changedDimensions: z.array(z.string()) });
const removedCard = cardAndSociety.extend({
  reason: z.enum(["ENTERED_BY_MISTAKE", "WRONG_OBJECT"]),
});

export const societyInformationEvents: readonly DomainEventDefinition[] = [
  {
    key: "society.overview_initialized",
    version: "1",
    payloadSchema: zodContractSchema(z.object({ cardId: uuid, objectId: uuid })),
  },
  {
    key: "society.profile_updated",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      cardId: uuid,
      changedDimensions: z.array(z.string()),
    })),
  },
  {
    key: "society.advisors_changed",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      cardId: uuid,
      advisorCardIds: z.array(uuid),
      advisorObjectIds: z.array(uuid),
    })),
  },
  {
    key: "society.team_member_added",
    version: "1",
    payloadSchema: zodContractSchema(cardAndSociety.extend({ objectId: uuid })),
  },
  {
    key: "society.team_member_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
  },
  {
    key: "society.team_member_removed",
    version: "1",
    payloadSchema: zodContractSchema(removedCard),
  },
  {
    key: "society.long_term_activity_added",
    version: "1",
    payloadSchema: zodContractSchema(cardAndSociety.extend({ objectId: uuid })),
  },
  {
    key: "society.long_term_activity_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
  },
  {
    key: "society.long_term_activity_removed",
    version: "1",
    payloadSchema: zodContractSchema(removedCard),
  },
  {
    key: "society.platform_added",
    version: "1",
    payloadSchema: zodContractSchema(cardAndSociety.extend({ objectId: uuid })),
  },
  {
    key: "society.platform_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
  },
  {
    key: "society.platform_removed",
    version: "1",
    payloadSchema: zodContractSchema(removedCard),
  },
];
