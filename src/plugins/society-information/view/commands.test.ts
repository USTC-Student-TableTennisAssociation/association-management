import { describe, expect, it } from "vitest";

import type {
  ViewCardState,
  ViewCommandContext,
  ViewTransaction,
} from "@/contracts";
import { societyInformationCommands } from "@/plugins/society-information/view/commands";
import { societyInformationInvariants } from "@/plugins/society-information/view/invariants";

const IDS = {
  societyObject: "00000000-0000-4000-8000-000000000001",
  advisorA: "00000000-0000-4000-8000-000000000002",
  advisorB: "00000000-0000-4000-8000-000000000003",
  activityA: "00000000-0000-4000-8000-000000000004",
  platformA: "00000000-0000-4000-8000-000000000005",
  platformB: "00000000-0000-4000-8000-000000000006",
  memberA: "00000000-0000-4000-8000-000000000007",
} as const;

class MemoryTransaction implements ViewTransaction {
  readonly cards = new Map<string, ViewCardState>();
  private nextId = 100;

  async getCard(cardId: string) {
    return this.cards.get(cardId);
  }

  async queryCards(query: { cardTypeKey?: string; relatedObjectId?: string } = {}) {
    return [...this.cards.values()].filter((card) =>
      (!query.cardTypeKey || card.cardTypeKey === query.cardTypeKey) &&
      (!query.relatedObjectId || card.relatedObjectIds.includes(query.relatedObjectId))
    );
  }

  async createCard(input: {
    cardTypeKey: string;
    dimensions?: Readonly<Record<string, unknown>>;
    relatedObjectIds?: readonly string[];
  }) {
    const id = `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`;
    this.cards.set(id, {
      id,
      viewKey: "society_information",
      cardTypeKey: input.cardTypeKey,
      dimensions: { ...(input.dimensions ?? {}) },
      slots: {},
      relatedObjectIds: [...(input.relatedObjectIds ?? [])],
    });
    return id;
  }

  async deleteCard(cardId: string) {
    this.cards.delete(cardId);
  }

  async setDimension(cardId: string, key: string, value: unknown) {
    const card = this.require(cardId);
    this.cards.set(cardId, { ...card, dimensions: { ...card.dimensions, [key]: value } });
  }

  async clearDimension(cardId: string, key: string) {
    const card = this.require(cardId);
    const dimensions = { ...card.dimensions };
    delete dimensions[key];
    this.cards.set(cardId, { ...card, dimensions });
  }

  async setSlot(cardId: string, key: string, targets: readonly string[]) {
    const card = this.require(cardId);
    this.cards.set(cardId, { ...card, slots: { ...card.slots, [key]: [...targets] } });
  }

  async setRelatedObjects(cardId: string, objectIds: readonly string[]) {
    const card = this.require(cardId);
    this.cards.set(cardId, { ...card, relatedObjectIds: [...objectIds] });
  }

  private require(cardId: string): ViewCardState {
    const card = this.cards.get(cardId);
    if (!card) throw new Error(`Card 不存在：${cardId}`);
    return card;
  }
}

function command(key: string) {
  const definition = societyInformationCommands.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`Command 不存在：${key}`);
  return definition;
}

async function execute(transaction: MemoryTransaction, key: string, input: unknown) {
  const definition = command(key);
  const parsed = definition.inputSchema.parse(input);
  const context: ViewCommandContext = {
    viewKey: "society_information",
    actor: { permissions: ["view.write"] },
    initiator: "human",
    transaction,
  };
  const result = await definition.execute(context, parsed);
  for (const invariant of societyInformationInvariants) await invariant.validate(transaction);
  return result;
}

async function initialize(transaction: MemoryTransaction) {
  const outcome = await execute(transaction, "society.initialize_overview", {
    societyObjectId: IDS.societyObject,
    profile: { rating: "五星级", purpose: "推广校园乒乓球运动" },
  });
  return (outcome.summary as { cardId: string }).cardId;
}

describe("society-information commands", () => {
  it("exposes the agreed command surface", () => {
    expect(societyInformationCommands.map((item) => item.key)).toEqual([
      "society.initialize_overview",
      "society.update_profile",
      "society.set_advisors",
      "society.save_team_member",
      "society.remove_team_member",
      "society.save_long_term_activity",
      "society.remove_long_term_activity",
      "society.save_platform",
      "society.remove_platform",
    ]);
  });

  it("initializes exactly one overview and supports partial profile updates", async () => {
    const transaction = new MemoryTransaction();
    const societyCardId = await initialize(transaction);
    const society = transaction.cards.get(societyCardId)!;
    expect(society.dimensions).toMatchObject({
      rating: "五星级",
      purpose: "推广校园乒乓球运动",
    });
    expect(society.relatedObjectIds).toEqual([IDS.societyObject]);

    await execute(transaction, "society.update_profile", {
      societyCardId,
      changes: { rating: "四星级", purpose: null },
    });
    expect(transaction.cards.get(societyCardId)?.dimensions).toEqual({ rating: "四星级" });

    await expect(initialize(transaction)).rejects.toThrow("社团概览已经初始化");
  });

  it("sets current advisors without deleting retained Person Cards", async () => {
    const transaction = new MemoryTransaction();
    const societyCardId = await initialize(transaction);
    await execute(transaction, "society.set_advisors", {
      societyCardId,
      advisorObjectIds: [IDS.advisorA, IDS.advisorB],
    });
    const firstPersonCards = await transaction.queryCards({ cardTypeKey: "PersonCard" });
    expect(firstPersonCards).toHaveLength(2);

    await execute(transaction, "society.set_advisors", {
      societyCardId,
      advisorObjectIds: [IDS.advisorB],
    });
    expect(await transaction.queryCards({ cardTypeKey: "PersonCard" })).toHaveLength(2);
    expect(transaction.cards.get(societyCardId)?.slots.advisor).toEqual([
      firstPersonCards.find((card) => card.relatedObjectIds.includes(IDS.advisorB))?.id,
    ]);
  });

  it("creates, updates and removes team members with department and position", async () => {
    const transaction = new MemoryTransaction();
    const societyCardId = await initialize(transaction);
    const created = await execute(transaction, "society.save_team_member", {
      mode: "create",
      societyCardId,
      memberObjectId: IDS.memberA,
      values: { department: "赛事部", position: "干事" },
    });
    const memberCardId = (created.summary as { cardId: string }).cardId;
    expect(transaction.cards.get(societyCardId)?.slots.team).toEqual([memberCardId]);
    expect(transaction.cards.get(memberCardId)?.dimensions).toMatchObject({
      department: "赛事部",
      position: "干事",
    });

    await execute(transaction, "society.save_team_member", {
      mode: "update",
      societyCardId,
      memberCardId,
      changes: { position: "部长" },
    });
    expect(transaction.cards.get(memberCardId)?.dimensions.position).toBe("部长");

    await execute(transaction, "society.remove_team_member", {
      societyCardId,
      memberCardId,
      reason: "WRONG_OBJECT",
    });
    expect(transaction.cards.get(societyCardId)?.slots.team).toEqual([]);
  });

  it("creates, updates, deduplicates and removes long-term activities", async () => {
    const transaction = new MemoryTransaction();
    const societyCardId = await initialize(transaction);
    const created = await execute(transaction, "society.save_long_term_activity", {
      mode: "create",
      societyCardId,
      activityObjectId: IDS.activityA,
      values: { frequency: "ANNUAL", usualPeriod: "秋季" },
    });
    const activityCardId = (created.summary as { cardId: string }).cardId;
    expect(transaction.cards.get(societyCardId)?.slots.activities).toEqual([activityCardId]);

    await execute(transaction, "society.save_long_term_activity", {
      mode: "update",
      societyCardId,
      activityCardId,
      changes: { usualPeriod: "十一月", status: "PAUSED" },
    });
    expect(transaction.cards.get(activityCardId)?.dimensions).toMatchObject({
      frequency: "ANNUAL",
      usual_period: "十一月",
      status: "PAUSED",
    });

    await expect(execute(transaction, "society.save_long_term_activity", {
      mode: "create",
      societyCardId,
      activityObjectId: IDS.activityA,
    })).rejects.toThrow("长期活动已经存在");

    await execute(transaction, "society.remove_long_term_activity", {
      societyCardId,
      activityCardId,
      reason: "ENTERED_BY_MISTAKE",
    });
    expect(transaction.cards.has(activityCardId)).toBe(false);
    expect(transaction.cards.get(societyCardId)?.slots.activities).toEqual([]);
  });

  it("requires access for active platforms and rejects duplicate URLs", async () => {
    const transaction = new MemoryTransaction();
    const societyCardId = await initialize(transaction);
    await expect(execute(transaction, "society.save_platform", {
      mode: "create",
      societyCardId,
      platformObjectId: IDS.platformA,
      values: { platformType: "网站" },
    })).rejects.toThrow("至少需要 URL 或访问说明");

    const created = await execute(transaction, "society.save_platform", {
      mode: "create",
      societyCardId,
      platformObjectId: IDS.platformA,
      values: { platformType: "网站", url: "https://example.com" },
    });
    const platformCardId = (created.summary as { cardId: string }).cardId;

    await expect(execute(transaction, "society.save_platform", {
      mode: "create",
      societyCardId,
      platformObjectId: IDS.platformB,
      values: { platformType: "备用网站", url: "https://example.com" },
    })).rejects.toThrow("平台 URL 已存在");

    await execute(transaction, "society.save_platform", {
      mode: "update",
      societyCardId,
      platformCardId,
      changes: { url: null, accessInstructions: "在校内门户中访问" },
    });
    expect(transaction.cards.get(platformCardId)?.dimensions).toMatchObject({
      platform_type: "网站",
      access_instructions: "在校内门户中访问",
    });
    expect(transaction.cards.get(platformCardId)?.dimensions.url).toBeUndefined();

    await execute(transaction, "society.remove_platform", {
      societyCardId,
      platformCardId,
      reason: "WRONG_OBJECT",
    });
    expect(transaction.cards.has(platformCardId)).toBe(false);
  });
});
