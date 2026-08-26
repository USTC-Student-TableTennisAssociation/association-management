import { z } from "zod";

import type { DomainEventDefinition } from "@sydaris/plugin-sdk";
import { zodContractSchema } from "@sydaris/plugin-sdk";

const uuid = z.string().uuid();
const cardAndSociety = z.object({ cardId: uuid, societyCardId: uuid });
const changedCard = cardAndSociety.extend({ changedDimensions: z.array(z.string()) });
const removedCard = cardAndSociety.extend({
  reason: z.enum(["ENTERED_BY_MISTAKE", "WRONG_OBJECT"]),
});
const observedKnowledgeChange = {
  aiAttention: { timing: "after_settle" },
  higherMemory: "reconcile_related_objects",
} as const;

export const societyInformationEvents: readonly DomainEventDefinition[] = [
  {
    key: "society.overview_initialized",
    version: "1",
    payloadSchema: zodContractSchema(z.object({ cardId: uuid, objectId: uuid })),
    ...observedKnowledgeChange,
  },
  {
    key: "society.profile_updated",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      cardId: uuid,
      changedDimensions: z.array(z.string()),
    })),
    ...observedKnowledgeChange,
  },
  {
    key: "society.advisors_changed",
    version: "1",
    payloadSchema: zodContractSchema(z.object({
      cardId: uuid,
      advisorCardIds: z.array(uuid),
      advisorObjectIds: z.array(uuid),
    })),
    ...observedKnowledgeChange,
  },
  {
    key: "society.person_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
    ...observedKnowledgeChange,
  },
  {
    key: "society.team_member_added",
    version: "1",
    payloadSchema: zodContractSchema(cardAndSociety.extend({ objectId: uuid })),
    ...observedKnowledgeChange,
  },
  {
    key: "society.team_member_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
    ...observedKnowledgeChange,
  },
  {
    key: "society.team_member_removed",
    version: "1",
    payloadSchema: zodContractSchema(removedCard),
    ...observedKnowledgeChange,
  },
  {
    key: "society.long_term_activity_added",
    version: "1",
    payloadSchema: zodContractSchema(cardAndSociety.extend({ objectId: uuid })),
    ...observedKnowledgeChange,
  },
  {
    key: "society.long_term_activity_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
    ...observedKnowledgeChange,
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
    ...observedKnowledgeChange,
  },
  {
    key: "society.platform_added",
    version: "1",
    payloadSchema: zodContractSchema(cardAndSociety.extend({ objectId: uuid })),
    ...observedKnowledgeChange,
  },
  {
    key: "society.platform_updated",
    version: "1",
    payloadSchema: zodContractSchema(changedCard),
    ...observedKnowledgeChange,
  },
  {
    key: "society.platform_removed",
    version: "1",
    payloadSchema: zodContractSchema(removedCard),
    ...observedKnowledgeChange,
  },
];
