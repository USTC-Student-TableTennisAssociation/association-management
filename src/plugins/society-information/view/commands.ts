import { z } from "zod";

import type { CommandDefinition } from "@/contracts";
import { zodContractSchema } from "@/contracts";

const ensurePersonSchema = z.object({
  objectId: z.string().uuid(),
  description: z.string().max(5_000).optional(),
});
const createSocietySchema = z.object({
  objectId: z.string().uuid(),
  rating: z.string().max(100).optional(),
  foundedOn: z.string().optional(),
  purpose: z.string().max(5_000).optional(),
  description: z.string().max(5_000).optional(),
});
const updateProfileSchema = z.object({
  cardId: z.string().uuid(),
  rating: z.string().max(100).optional(),
  foundedOn: z.string().optional(),
  purpose: z.string().max(5_000).optional(),
  description: z.string().max(5_000).optional(),
}).refine((input) => Object.keys(input).some((key) => key !== "cardId"), {
  message: "至少需要一个要更新的字段",
});

function compact(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

const ensurePerson: CommandDefinition<z.infer<typeof ensurePersonSchema>> = {
  key: "society.ensure_person",
  version: "1",
  label: "建立人物业务卡",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(ensurePersonSchema),
  async execute(context, input) {
    const existing = (await context.transaction.queryCards({
      cardTypeKey: "PersonCard",
      relatedObjectId: input.objectId,
    }))[0];
    const cardId = existing?.id ?? await context.transaction.createCard({
      cardTypeKey: "PersonCard",
      dimensions: compact({ description: input.description }),
      relatedObjectIds: [input.objectId],
    });
    return {
      summary: { cardId, objectId: input.objectId, created: !existing },
      events: [{
        type: "society.person_ensured",
        version: "1",
        payload: { cardId, objectId: input.objectId, created: !existing },
      }],
    };
  },
};

const createSociety: CommandDefinition<z.infer<typeof createSocietySchema>> = {
  key: "society.create_society",
  version: "1",
  label: "创建社团卡",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(createSocietySchema),
  async execute(context, input) {
    const cardId = await context.transaction.createCard({
      cardTypeKey: "SocietyCard",
      dimensions: compact({
        rating: input.rating,
        founded_on: input.foundedOn,
        purpose: input.purpose,
        description: input.description,
      }),
      relatedObjectIds: [input.objectId],
    });
    return {
      summary: { cardId },
      events: [{ type: "society.society_created", version: "1", payload: { cardId } }],
    };
  },
};

const updateProfile: CommandDefinition<z.infer<typeof updateProfileSchema>> = {
  key: "society.update_profile",
  version: "1",
  label: "更新社团档案",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(updateProfileSchema),
  async execute(context, input) {
    const card = await context.transaction.getCard(input.cardId);
    if (!card || card.cardTypeKey !== "SocietyCard") {
      throw new Error("需要 SocietyCard");
    }
    for (const [key, value] of Object.entries(compact({
      rating: input.rating,
      founded_on: input.foundedOn,
      purpose: input.purpose,
      description: input.description,
    }))) {
      await context.transaction.setDimension(card.id, key, value);
    }
    return {
      summary: { cardId: card.id },
      events: [{ type: "society.profile_updated", version: "1", payload: { cardId: card.id } }],
    };
  },
};

export const societyInformationCommands: readonly CommandDefinition[] = [
  ensurePerson,
  createSociety,
  updateProfile,
];
