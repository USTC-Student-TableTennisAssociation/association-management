import { z } from "zod";

import type {
  CommandDefinition,
  ViewCardState,
  ViewTransaction,
} from "@/contracts";
import { zodContractSchema } from "@/contracts";
import {
  competitionEditionProjectOutputSchema,
} from "@/plugins/competition-records/tools/contracts";

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(300);

const syncEditionsSchema = competitionEditionProjectOutputSchema.refine(
  (input) => {
    const identities = input.editions.map((edition) =>
      `${edition.sourceSystem}\u0000${edition.sourceId}`
    );
    return new Set(identities).size === identities.length;
  },
  { message: "同一批次不能包含重复的来源记录" },
);

const seriesValuesSchema = z.object({
  description: z.string().max(5_000).optional(),
  cadence: z.string().trim().min(1).max(300).optional(),
});

const seriesChangesSchema = z.object({
  name: name.optional(),
  description: z.string().max(5_000).nullable().optional(),
  cadence: z.string().trim().min(1).max(300).nullable().optional(),
});

const uniqueCardIds = z.array(uuid).min(1).refine(
  (cardIds) => new Set(cardIds).size === cardIds.length,
  { message: "届次 Card 不能重复" },
);

const optionalUniqueCardIds = z.array(uuid).refine(
  (cardIds) => new Set(cardIds).size === cardIds.length,
  { message: "届次 Card 不能重复" },
).default([]);

const organizeSeriesSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    seriesObjectId: uuid,
    name,
    values: seriesValuesSchema.optional(),
    editionCardIds: uniqueCardIds,
  }),
  z.object({
    mode: z.literal("update"),
    seriesCardId: uuid,
    changes: seriesChangesSchema.optional(),
    editionCardIds: optionalUniqueCardIds,
  }),
]).superRefine((input, context) => {
  if (
    input.mode === "update" &&
    !input.changes &&
    input.editionCardIds.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "至少需要更新系列信息或关联届次",
    });
  }
});

function requireType(card: ViewCardState | undefined, type: string): ViewCardState {
  if (!card || card.cardTypeKey !== type) {
    throw new Error(`需要 ${type} Card`);
  }
  return card;
}

function compactDimensions(
  entries: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  );
}

function dimensionChanges(
  entries: Readonly<Record<string, unknown>>,
): Record<string, unknown | null> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  );
}

async function applyDimensionChanges(
  transaction: ViewTransaction,
  cardId: string,
  changes: Readonly<Record<string, unknown | null>>,
) {
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) await transaction.clearDimension(cardId, key);
    else await transaction.setDimension(cardId, key, value);
  }
}

async function requireEditions(
  transaction: ViewTransaction,
  cardIds: readonly string[],
): Promise<ViewCardState[]> {
  const editions: ViewCardState[] = [];
  for (const cardId of cardIds) {
    editions.push(requireType(
      await transaction.getCard(cardId),
      "CompetitionEditionCard",
    ));
  }
  return editions;
}

async function assertEditionsCanJoinSeries(
  editions: readonly ViewCardState[],
  seriesCardId: string,
) {
  const conflicting = editions.find((edition) => {
    const current = edition.slots.series ?? [];
    return current.length > 0 && current[0] !== seriesCardId;
  });
  if (conflicting) {
    throw new Error(
      `届次 Card ${conflicting.id} 已属于其他赛事系列，不能静默改挂`,
    );
  }
}

const syncEditions: CommandDefinition<z.infer<typeof syncEditionsSchema>> = {
  key: "competition.sync_editions",
  version: "1",
  label: "同步比赛届次",
  allowedInitiators: ["system"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(syncEditionsSchema),
  proposalApprovalConflictPolicy: () => "revalidate_latest",
  async execute(context, input) {
    const existing = await context.transaction.queryCards({
      cardTypeKey: "CompetitionEditionCard",
    });
    const bySourceIdentity = new Map<string, ViewCardState>();
    for (const edition of existing) {
      const sourceSystem = edition.dimensions.source_system;
      const sourceId = edition.dimensions.source_id;
      if (typeof sourceSystem !== "string" || typeof sourceId !== "string") continue;
      const identity = `${sourceSystem}\u0000${sourceId}`;
      if (bySourceIdentity.has(identity)) {
        throw new Error(`来源 ${sourceSystem}/${sourceId} 已对应多张届次 Card`);
      }
      bySourceIdentity.set(identity, edition);
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const projection of input.editions) {
      const identity = `${projection.sourceSystem}\u0000${projection.sourceId}`;
      const edition = bySourceIdentity.get(identity);
      if (!edition) {
        const cardId = await context.transaction.createCard({
          cardTypeKey: "CompetitionEditionCard",
          dimensions: compactDimensions({
            name: projection.name,
            participant_count: projection.participantCount,
            sequence_number: projection.sequenceNumber,
            held_on: projection.heldOn,
            source_system: projection.sourceSystem,
            source_id: projection.sourceId,
          }),
        });
        bySourceIdentity.set(identity, {
          id: cardId,
          viewKey: context.viewKey,
          cardTypeKey: "CompetitionEditionCard",
          dimensions: {},
          slots: {},
          relatedObjectIds: [],
        });
        created += 1;
        continue;
      }

      const authoritative = compactDimensions({
        name: projection.name,
        participant_count: projection.participantCount,
        sequence_number: projection.sequenceNumber,
        held_on: projection.heldOn,
        source_system: projection.sourceSystem,
        source_id: projection.sourceId,
      });
      const changes = Object.fromEntries(Object.entries(authoritative).filter(
        ([key, value]) => edition.dimensions[key] !== value,
      ));
      if (Object.keys(changes).length === 0) {
        unchanged += 1;
        continue;
      }
      await applyDimensionChanges(context.transaction, edition.id, changes);
      updated += 1;
    }

    return {
      summary: {
        sourceSystem: input.sourceSystem,
        sourceSchemaVersion: input.sourceSchemaVersion,
        mappingVersion: input.mappingVersion,
        retrievedAt: input.retrievedAt,
        total: input.editions.length,
        created,
        updated,
        unchanged,
      },
      events: [{
        type: "competition.editions_synced",
        version: "1",
        payload: {
          sourceSystem: input.sourceSystem,
          mappingVersion: input.mappingVersion,
          total: input.editions.length,
          created,
          updated,
          unchanged,
        },
      }],
    };
  },
};

const organizeSeries: CommandDefinition<z.infer<typeof organizeSeriesSchema>> = {
  key: "competition.organize_series",
  version: "1",
  label: "整理赛事系列",
  allowedInitiators: ["human", "ai"],
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(organizeSeriesSchema),
  inputReferences: [
    {
      path: ["seriesObjectId"],
      kind: "object",
      inferFromCanonicalNamePath: ["name"],
    },
    { path: ["seriesCardId"], kind: "card" },
    { path: ["editionCardIds"], kind: "card", cardinality: "many" },
  ],
  proposalApprovalConflictPolicy: (input) =>
    input.mode === "create" ? "revalidate_latest" : "exact",
  async execute(context, input) {
    const editions = await requireEditions(
      context.transaction,
      input.editionCardIds,
    );
    let seriesCardId: string;
    let created: boolean;

    if (input.mode === "create") {
      const duplicate = (await context.transaction.queryCards({
        cardTypeKey: "CompetitionSeriesCard",
        relatedObjectId: input.seriesObjectId,
      }))[0];
      if (duplicate) {
        throw new Error(`赛事系列已经存在于 Card ${duplicate.id}`);
      }
      seriesCardId = await context.transaction.createCard({
        cardTypeKey: "CompetitionSeriesCard",
        relatedObjectIds: [input.seriesObjectId],
        dimensions: compactDimensions({
          name: input.name,
          description: input.values?.description,
          cadence: input.values?.cadence,
        }),
      });
      created = true;
    } else {
      const series = requireType(
        await context.transaction.getCard(input.seriesCardId),
        "CompetitionSeriesCard",
      );
      const changes = dimensionChanges({
        name: input.changes?.name,
        description: input.changes?.description,
        cadence: input.changes?.cadence,
      });
      await applyDimensionChanges(context.transaction, series.id, changes);
      seriesCardId = series.id;
      created = false;
    }

    await assertEditionsCanJoinSeries(editions, seriesCardId);
    for (const edition of editions) {
      await context.transaction.setSlot(edition.id, "series", [seriesCardId]);
    }
    return {
      summary: {
        seriesCardId,
        editionCardIds: editions.map((edition) => edition.id),
        created,
      },
      events: [{
        type: "competition.series_organized",
        version: "1",
        payload: {
          seriesCardId,
          editionCardIds: editions.map((edition) => edition.id),
          created,
        },
      }],
    };
  },
};

export const competitionRecordsCommands: readonly CommandDefinition[] = [
  syncEditions,
  organizeSeries,
];
