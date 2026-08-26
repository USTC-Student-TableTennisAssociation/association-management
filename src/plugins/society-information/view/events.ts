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
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.profile_updated",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      cardId: uuid,
      changedDimensions: z.array(z.string()),
    })),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.advisors_changed",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      cardId: uuid,
      advisorCardIds: z.array(uuid),
      advisorObjectIds: z.array(uuid),
    })),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.person_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.team_member_added",
    version: "1",
    payloadSchema: zodContractSchema(cardAndSociety.extend({ objectId: uuid })),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.team_member_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.team_member_removed",
    version: "1",
    payloadSchema: zodContractSchema(removedCard),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.long_term_activity_added",
    version: "1",
    payloadSchema: zodContractSchema(cardAndSociety.extend({ objectId: uuid })),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.long_term_activity_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.long_term_activities_reordered",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      cardId: uuid,
      activityCardIds: z.array(uuid),
    })),
    aiAttention: { timing: "next_turn" },
  },
  {
    key: "society.long_term_activity_removed",
    version: "1",
    payloadSchema: zodContractSchema(removedCard),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.platform_added",
    version: "1",
    payloadSchema: zodContractSchema(cardAndSociety.extend({ objectId: uuid })),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.platform_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
    aiAttention: { timing: "after_settle" },
  },
  {
    key: "society.platform_removed",
    version: "1",
    payloadSchema: zodContractSchema(removedCard),
    aiAttention: { timing: "after_settle" },
  },
];
