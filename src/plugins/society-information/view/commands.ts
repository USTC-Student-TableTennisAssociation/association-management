import { z } from "zod";

import type {
  CommandDefinition,
  ViewCardState,
  ViewTransaction,
} from "@/contracts";
import { zodContractSchema } from "@/contracts";

const uuid = z.string().uuid();
const activityFrequencySchema = z.enum(["ANNUAL", "PER_SEMESTER", "IRREGULAR"]);
const catalogStatusSchema = z.enum(["ACTIVE", "PAUSED", "RETIRED"]);
const correctionReasonSchema = z.enum(["ENTERED_BY_MISTAKE", "WRONG_OBJECT"]);

const profileValuesSchema = z.object({
  rating: z.string().trim().max(100).optional(),
  foundedOn: z.string().optional(),
  purpose: z.string().max(5_000).optional(),
  description: z.string().max(5_000).optional(),
});

const profileChangesSchema = z.object({
  rating: z.string().trim().max(100).nullable().optional(),
  foundedOn: z.string().nullable().optional(),
  purpose: z.string().max(5_000).nullable().optional(),
  description: z.string().max(5_000).nullable().optional(),
}).refine((changes) => Object.values(changes).some((value) => value !== undefined), {
  message: "至少需要一个要更新的社团资料字段",
});

const initializeOverviewSchema = z.object({
  societyObjectId: uuid,
  profile: profileValuesSchema.optional(),
});

const updateProfileSchema = z.object({
  societyCardId: uuid,
  changes: profileChangesSchema,
});

const setAdvisorsSchema = z.object({
  societyCardId: uuid,
  advisorObjectIds: z.array(uuid).refine(
    (objectIds) => new Set(objectIds).size === objectIds.length,
    { message: "指导老师 Object 不能重复" },
  ),
});

const teamMemberValuesSchema = z.object({
  department: z.string().trim().min(1).max(200),
  position: z.string().trim().min(1).max(200),
  description: z.string().max(5_000).nullable().optional(),
});

const teamMemberChangesSchema = z.object({
  department: z.string().trim().min(1).max(200).optional(),
  position: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5_000).nullable().optional(),
}).refine((changes) => Object.values(changes).some((value) => value !== undefined), {
  message: "至少需要一个要更新的干事字段",
});

const saveTeamMemberSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    societyCardId: uuid,
    memberObjectId: uuid,
    values: teamMemberValuesSchema,
  }),
  z.object({
    mode: z.literal("update"),
    societyCardId: uuid,
    memberCardId: uuid,
    changes: teamMemberChangesSchema,
  }),
]);

const removeTeamMemberSchema = z.object({
  societyCardId: uuid,
  memberCardId: uuid,
  reason: correctionReasonSchema,
});

const activityValuesSchema = z.object({
  description: z.string().max(5_000).nullable().optional(),
  frequency: activityFrequencySchema.nullable().optional(),
  usualPeriod: z.string().trim().max(500).nullable().optional(),
  status: catalogStatusSchema.optional(),
});

const activityChangesSchema = activityValuesSchema.refine(
  (changes) => Object.values(changes).some((value) => value !== undefined),
  { message: "至少需要一个要更新的长期活动字段" },
);

const saveLongTermActivitySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    societyCardId: uuid,
    activityObjectId: uuid,
    values: activityValuesSchema.optional(),
  }),
  z.object({
    mode: z.literal("update"),
    societyCardId: uuid,
    activityCardId: uuid,
    changes: activityChangesSchema,
  }),
]);

const removeLongTermActivitySchema = z.object({
  societyCardId: uuid,
  activityCardId: uuid,
  reason: correctionReasonSchema,
});

const platformCreateValuesSchema = z.object({
  platformType: z.string().trim().min(1).max(200),
  url: z.string().trim().url().nullable().optional(),
  accessInstructions: z.string().max(5_000).nullable().optional(),
  description: z.string().max(5_000).nullable().optional(),
  status: catalogStatusSchema.default("ACTIVE"),
}).superRefine((values, context) => {
  if (
    values.status === "ACTIVE" &&
    !values.url &&
    !values.accessInstructions?.trim()
  ) {
    context.addIssue({
      code: "custom",
      message: "正常使用的平台至少需要 URL 或访问说明",
    });
  }
});

const platformChangesSchema = z.object({
  platformType: z.string().trim().min(1).max(200).optional(),
  url: z.string().trim().url().nullable().optional(),
  accessInstructions: z.string().max(5_000).nullable().optional(),
  description: z.string().max(5_000).nullable().optional(),
  status: catalogStatusSchema.optional(),
}).refine((changes) => Object.values(changes).some((value) => value !== undefined), {
  message: "至少需要一个要更新的平台字段",
});

const savePlatformSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    societyCardId: uuid,
    platformObjectId: uuid,
    values: platformCreateValuesSchema,
  }),
  z.object({
    mode: z.literal("update"),
    societyCardId: uuid,
    platformCardId: uuid,
    changes: platformChangesSchema,
  }),
]);

const removePlatformSchema = z.object({
  societyCardId: uuid,
  platformCardId: uuid,
  reason: correctionReasonSchema,
});

function compact(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null),
  );
}

function changedKeys(values: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

function requireType(card: ViewCardState | undefined, type: string): ViewCardState {
  if (!card || card.cardTypeKey !== type) throw new Error(`需要 ${type} Card`);
  return card;
}

async function requireSociety(
  transaction: ViewTransaction,
  societyCardId: string,
): Promise<ViewCardState> {
  return requireType(await transaction.getCard(societyCardId), "SocietyCard");
}

function requireMembership(
  society: ViewCardState,
  slotKey: "team" | "activities" | "platforms",
  card: ViewCardState,
): void {
  if (!(society.slots[slotKey] ?? []).includes(card.id)) {
    throw new Error(`${card.cardTypeKey} 不属于当前 SocietyCard 的 ${slotKey}`);
  }
}

async function applyChanges(
  transaction: ViewTransaction,
  cardId: string,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (value === null) await transaction.clearDimension(cardId, key);
    else await transaction.setDimension(cardId, key, value);
  }
}

function profileDimensions(profile: z.infer<typeof profileValuesSchema> | undefined) {
  return compact({
    rating: profile?.rating,
    founded_on: profile?.foundedOn,
    purpose: profile?.purpose,
    description: profile?.description,
  });
}

function profileChanges(changes: z.infer<typeof profileChangesSchema>) {
  return {
    rating: changes.rating,
    founded_on: changes.foundedOn,
    purpose: changes.purpose,
    description: changes.description,
  };
}

function teamMemberDimensions(values: z.infer<typeof teamMemberValuesSchema>) {
  return compact({
    department: values.department,
    position: values.position,
    description: values.description,
  });
}

function teamMemberChanges(changes: z.infer<typeof teamMemberChangesSchema>) {
  return {
    department: changes.department,
    position: changes.position,
    description: changes.description,
  };
}

function activityDimensions(values: z.infer<typeof activityValuesSchema> | undefined) {
  return compact({
    description: values?.description,
    frequency: values?.frequency,
    usual_period: values?.usualPeriod,
    status: values?.status,
  });
}

function activityChanges(changes: z.infer<typeof activityChangesSchema>) {
  return {
    description: changes.description,
    frequency: changes.frequency,
    usual_period: changes.usualPeriod,
    status: changes.status,
  };
}

function platformDimensions(values: z.infer<typeof platformCreateValuesSchema>) {
  return compact({
    platform_type: values.platformType,
    url: values.url,
    access_instructions: values.accessInstructions,
    description: values.description,
    status: values.status,
  });
}

function platformChanges(changes: z.infer<typeof platformChangesSchema>) {
  return {
    platform_type: changes.platformType,
    url: changes.url,
    access_instructions: changes.accessInstructions,
    description: changes.description,
    status: changes.status,
  };
}

function textDimension(card: ViewCardState, key: string): string | undefined {
  const value = card.dimensions[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function ensureUniquePlatformUrl(
  transaction: ViewTransaction,
  url: string | undefined,
  excludingCardId?: string,
): Promise<void> {
  if (!url) return;
  const duplicate = (await transaction.queryCards({ cardTypeKey: "PlatformCard" })).find(
    (card) => card.id !== excludingCardId && textDimension(card, "url") === url,
  );
  if (duplicate) throw new Error(`平台 URL 已存在于 Card ${duplicate.id}`);
}

function assertActivePlatformHasAccess(
  card: ViewCardState,
  changes: ReturnType<typeof platformChanges>,
): void {
  const status = changes.status ?? textDimension(card, "status") ?? "ACTIVE";
  const url = changes.url === null ? undefined : changes.url ?? textDimension(card, "url");
  const access = changes.access_instructions === null
    ? undefined
    : changes.access_instructions ?? textDimension(card, "access_instructions");
  if (status === "ACTIVE" && !url && !access?.trim()) {
    throw new Error("正常使用的平台至少需要 URL 或访问说明");
  }
}

const initializeOverview: CommandDefinition<z.infer<typeof initializeOverviewSchema>> = {
  key: "society.initialize_overview",
  version: "1",
  label: "建立社团概览",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(initializeOverviewSchema),
  async execute(context, input) {
    const existing = await context.transaction.queryCards({ cardTypeKey: "SocietyCard" });
    if (existing.length) throw new Error("社团概览已经初始化");
    const cardId = await context.transaction.createCard({
      cardTypeKey: "SocietyCard",
      dimensions: profileDimensions(input.profile),
      relatedObjectIds: [input.societyObjectId],
    });
    return {
      summary: { cardId, societyObjectId: input.societyObjectId },
      events: [{
        type: "society.overview_initialized",
        version: "1",
        payload: { cardId, objectId: input.societyObjectId },
      }],
    };
  },
};

const updateProfile: CommandDefinition<z.infer<typeof updateProfileSchema>> = {
  key: "society.update_profile",
  version: "1",
  label: "更新社团资料",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(updateProfileSchema),
  async execute(context, input) {
    await requireSociety(context.transaction, input.societyCardId);
    const changes = profileChanges(input.changes);
    await applyChanges(context.transaction, input.societyCardId, changes);
    return {
      summary: { cardId: input.societyCardId, changedDimensions: changedKeys(changes) },
      events: [{
        type: "society.profile_updated",
        version: "1",
        payload: { cardId: input.societyCardId, changedDimensions: changedKeys(changes) },
      }],
    };
  },
};

const setAdvisors: CommandDefinition<z.infer<typeof setAdvisorsSchema>> = {
  key: "society.set_advisors",
  version: "1",
  label: "设置当前指导老师",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(setAdvisorsSchema),
  async execute(context, input) {
    const society = await requireSociety(context.transaction, input.societyCardId);
    const advisorCardIds: string[] = [];
    for (const objectId of input.advisorObjectIds) {
      const existing = (await context.transaction.queryCards({
        cardTypeKey: "PersonCard",
        relatedObjectId: objectId,
      }))[0];
      advisorCardIds.push(existing?.id ?? await context.transaction.createCard({
        cardTypeKey: "PersonCard",
        relatedObjectIds: [objectId],
      }));
    }
    await context.transaction.setSlot(society.id, "advisor", advisorCardIds);
    return {
      summary: { cardId: society.id, advisorCardIds },
      events: [{
        type: "society.advisors_changed",
        version: "1",
        payload: {
          cardId: society.id,
          advisorCardIds,
          advisorObjectIds: input.advisorObjectIds,
        },
      }],
    };
  },
};

const saveTeamMember: CommandDefinition<z.infer<typeof saveTeamMemberSchema>> = {
  key: "society.save_team_member",
  version: "1",
  label: "保存干事成员",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(saveTeamMemberSchema),
  async execute(context, input) {
    const society = await requireSociety(context.transaction, input.societyCardId);
    if (input.mode === "create") {
      const existing = (await context.transaction.queryCards({
        cardTypeKey: "PersonCard",
        relatedObjectId: input.memberObjectId,
      }))[0];
      const cardId = existing?.id ?? await context.transaction.createCard({
        cardTypeKey: "PersonCard",
        dimensions: teamMemberDimensions(input.values),
        relatedObjectIds: [input.memberObjectId],
      });
      if (existing) {
        await applyChanges(context.transaction, existing.id, teamMemberDimensions(input.values));
      }
      if (!(society.slots.team ?? []).includes(cardId)) {
        await context.transaction.setSlot(
          society.id,
          "team",
          [...(society.slots.team ?? []), cardId],
        );
      }
      return {
        summary: { cardId, societyCardId: society.id, created: !existing },
        events: [{
          type: "society.team_member_added",
          version: "1",
          payload: { cardId, societyCardId: society.id, objectId: input.memberObjectId },
        }],
      };
    }

    const member = requireType(
      await context.transaction.getCard(input.memberCardId),
      "PersonCard",
    );
    requireMembership(society, "team", member);
    const changes = teamMemberChanges(input.changes);
    await applyChanges(context.transaction, member.id, changes);
    return {
      summary: { cardId: member.id, societyCardId: society.id, created: false },
      events: [{
        type: "society.team_member_updated",
        version: "1",
        payload: {
          cardId: member.id,
          societyCardId: society.id,
          changedDimensions: changedKeys(changes),
        },
      }],
    };
  },
};

const removeTeamMember: CommandDefinition<z.infer<typeof removeTeamMemberSchema>> = {
  key: "society.remove_team_member",
  version: "1",
  label: "移除错误的干事成员",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(removeTeamMemberSchema),
  async execute(context, input) {
    const society = await requireSociety(context.transaction, input.societyCardId);
    const member = requireType(
      await context.transaction.getCard(input.memberCardId),
      "PersonCard",
    );
    requireMembership(society, "team", member);
    await context.transaction.setSlot(
      society.id,
      "team",
      (society.slots.team ?? []).filter((cardId) => cardId !== member.id),
    );
    return {
      summary: { cardId: member.id, societyCardId: society.id, removed: true },
      events: [{
        type: "society.team_member_removed",
        version: "1",
        payload: { cardId: member.id, societyCardId: society.id, reason: input.reason },
      }],
    };
  },
};

const saveLongTermActivity: CommandDefinition<z.infer<typeof saveLongTermActivitySchema>> = {
  key: "society.save_long_term_activity",
  version: "1",
  label: "保存长期活动",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(saveLongTermActivitySchema),
  async execute(context, input) {
    const society = await requireSociety(context.transaction, input.societyCardId);
    if (input.mode === "create") {
      const duplicate = (await context.transaction.queryCards({
        cardTypeKey: "ActivityCard",
        relatedObjectId: input.activityObjectId,
      }))[0];
      if (duplicate) throw new Error(`长期活动已经存在于 Card ${duplicate.id}`);
      const cardId = await context.transaction.createCard({
        cardTypeKey: "ActivityCard",
        dimensions: activityDimensions(input.values),
        relatedObjectIds: [input.activityObjectId],
      });
      await context.transaction.setSlot(
        society.id,
        "activities",
        [...(society.slots.activities ?? []), cardId],
      );
      return {
        summary: { cardId, societyCardId: society.id, created: true },
        events: [{
          type: "society.long_term_activity_added",
          version: "1",
          payload: { cardId, societyCardId: society.id, objectId: input.activityObjectId },
        }],
      };
    }

    const activity = requireType(
      await context.transaction.getCard(input.activityCardId),
      "ActivityCard",
    );
    requireMembership(society, "activities", activity);
    const changes = activityChanges(input.changes);
    await applyChanges(context.transaction, activity.id, changes);
    return {
      summary: { cardId: activity.id, societyCardId: society.id, created: false },
      events: [{
        type: "society.long_term_activity_updated",
        version: "1",
        payload: {
          cardId: activity.id,
          societyCardId: society.id,
          changedDimensions: changedKeys(changes),
        },
      }],
    };
  },
};

const removeLongTermActivity: CommandDefinition<z.infer<typeof removeLongTermActivitySchema>> = {
  key: "society.remove_long_term_activity",
  version: "1",
  label: "移除错误的长期活动",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(removeLongTermActivitySchema),
  async execute(context, input) {
    const society = await requireSociety(context.transaction, input.societyCardId);
    const activity = requireType(
      await context.transaction.getCard(input.activityCardId),
      "ActivityCard",
    );
    requireMembership(society, "activities", activity);
    await context.transaction.setSlot(
      society.id,
      "activities",
      (society.slots.activities ?? []).filter((cardId) => cardId !== activity.id),
    );
    await context.transaction.deleteCard(activity.id);
    return {
      summary: { cardId: activity.id, societyCardId: society.id, removed: true },
      events: [{
        type: "society.long_term_activity_removed",
        version: "1",
        payload: { cardId: activity.id, societyCardId: society.id, reason: input.reason },
      }],
    };
  },
};

const savePlatform: CommandDefinition<z.infer<typeof savePlatformSchema>> = {
  key: "society.save_platform",
  version: "1",
  label: "保存平台入口",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(savePlatformSchema),
  async execute(context, input) {
    const society = await requireSociety(context.transaction, input.societyCardId);
    if (input.mode === "create") {
      const duplicate = (await context.transaction.queryCards({
        cardTypeKey: "PlatformCard",
        relatedObjectId: input.platformObjectId,
      }))[0];
      if (duplicate) throw new Error(`平台已经存在于 Card ${duplicate.id}`);
      await ensureUniquePlatformUrl(context.transaction, input.values.url ?? undefined);
      const cardId = await context.transaction.createCard({
        cardTypeKey: "PlatformCard",
        dimensions: platformDimensions(input.values),
        relatedObjectIds: [input.platformObjectId],
      });
      await context.transaction.setSlot(
        society.id,
        "platforms",
        [...(society.slots.platforms ?? []), cardId],
      );
      return {
        summary: { cardId, societyCardId: society.id, created: true },
        events: [{
          type: "society.platform_added",
          version: "1",
          payload: { cardId, societyCardId: society.id, objectId: input.platformObjectId },
        }],
      };
    }

    const platform = requireType(
      await context.transaction.getCard(input.platformCardId),
      "PlatformCard",
    );
    requireMembership(society, "platforms", platform);
    const changes = platformChanges(input.changes);
    assertActivePlatformHasAccess(platform, changes);
    const nextUrl = changes.url === null ? undefined : changes.url ?? textDimension(platform, "url");
    await ensureUniquePlatformUrl(context.transaction, nextUrl, platform.id);
    await applyChanges(context.transaction, platform.id, changes);
    return {
      summary: { cardId: platform.id, societyCardId: society.id, created: false },
      events: [{
        type: "society.platform_updated",
        version: "1",
        payload: {
          cardId: platform.id,
          societyCardId: society.id,
          changedDimensions: changedKeys(changes),
        },
      }],
    };
  },
};

const removePlatform: CommandDefinition<z.infer<typeof removePlatformSchema>> = {
  key: "society.remove_platform",
  version: "1",
  label: "移除错误的平台",
  requiredPermissions: ["view.write"],
  inputSchema: zodContractSchema(removePlatformSchema),
  async execute(context, input) {
    const society = await requireSociety(context.transaction, input.societyCardId);
    const platform = requireType(
      await context.transaction.getCard(input.platformCardId),
      "PlatformCard",
    );
    requireMembership(society, "platforms", platform);
    await context.transaction.setSlot(
      society.id,
      "platforms",
      (society.slots.platforms ?? []).filter((cardId) => cardId !== platform.id),
    );
    await context.transaction.deleteCard(platform.id);
    return {
      summary: { cardId: platform.id, societyCardId: society.id, removed: true },
      events: [{
        type: "society.platform_removed",
        version: "1",
        payload: { cardId: platform.id, societyCardId: society.id, reason: input.reason },
      }],
    };
  },
};

export const societyInformationCommands: readonly CommandDefinition[] = [
  initializeOverview,
  updateProfile,
  setAdvisors,
  saveTeamMember,
  removeTeamMember,
  saveLongTermActivity,
  removeLongTermActivity,
  savePlatform,
  removePlatform,
];
