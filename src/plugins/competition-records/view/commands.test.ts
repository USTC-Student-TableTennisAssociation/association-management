import { describe, expect, it, vi } from "vitest";

import type {
  CommandDefinition,
  ViewCardState,
  ViewTransaction,
} from "@/contracts";
import { competitionRecordsCommands } from "@/plugins/competition-records/view/commands";

const IDS = {
  edition: "00000000-0000-4000-8000-000000000101",
  editionTwo: "00000000-0000-4000-8000-000000000102",
  series: "00000000-0000-4000-8000-000000000201",
  seriesObject: "00000000-0000-4000-8000-000000000301",
};

function command(key: string): CommandDefinition<Record<string, unknown>> {
  const found = competitionRecordsCommands.find((candidate) =>
    candidate.key === key
  );
  if (!found) throw new Error(`Command ${key} is missing`);
  return found as CommandDefinition<Record<string, unknown>>;
}

function card(
  input: Partial<ViewCardState> & Pick<ViewCardState, "id" | "cardTypeKey">,
): ViewCardState {
  return {
    id: input.id,
    viewKey: "competition_records",
    cardTypeKey: input.cardTypeKey,
    dimensions: input.dimensions ?? {},
    slots: input.slots ?? {},
    relatedObjectIds: input.relatedObjectIds ?? [],
  };
}

function fixture(cards: readonly ViewCardState[] = []) {
  const byId = new Map(cards.map((item) => [item.id, item]));
  return {
    getCard: vi.fn(async (cardId: string) => byId.get(cardId)),
    queryCards: vi.fn(async (query?: {
      cardTypeKey?: string;
      relatedObjectId?: string;
    }) => cards.filter((item) =>
      (!query?.cardTypeKey || item.cardTypeKey === query.cardTypeKey) &&
      (!query?.relatedObjectId ||
        item.relatedObjectIds.includes(query.relatedObjectId))
    )),
    createCard: vi.fn(async (input: { cardTypeKey: string }) =>
      input.cardTypeKey === "CompetitionSeriesCard" ? IDS.series : IDS.edition
    ),
    setDimension: vi.fn(),
    clearDimension: vi.fn(),
    setSlot: vi.fn(),
  } as unknown as ViewTransaction;
}

async function execute(
  key: string,
  transaction: ViewTransaction,
  input: Record<string, unknown>,
) {
  const definition = command(key);
  const parsed = definition.inputSchema.parse(input);
  return definition.execute({
    viewKey: "competition_records",
    actor: { permissions: ["view.write"] },
    initiator: "ai",
    transaction,
  }, parsed);
}

describe("competition.sync_editions", () => {
  it("creates missing source records and updates changed authoritative fields", async () => {
    const transaction = fixture([
      card({
        id: IDS.edition,
        cardTypeKey: "CompetitionEditionCard",
        dimensions: {
          name: "旧名称",
          participant_count: 12,
          held_on: "2026-06-26",
          source_system: "USTCTTA-site",
          source_id: "match-15",
        },
      }),
    ]);

    const outcome = await execute("competition.sync_editions", transaction, {
      sourceSystem: "USTCTTA-site",
      sourceSchemaVersion: "1",
      mappingVersion: "1",
      retrievedAt: "2026-08-28T00:00:00.000Z",
      editions: [{
        sourceSystem: "USTCTTA-site",
        sourceId: "match-15",
        name: "[26夏季积分赛] 第十五周",
        participantCount: 13,
        sequenceNumber: 15,
        heldOn: "2026-06-26",
      }, {
        sourceSystem: "USTCTTA-site",
        sourceId: "match-14",
        name: "[26夏季积分赛] 第十四周",
        participantCount: 18,
        sequenceNumber: 14,
        heldOn: "2026-06-19",
      }],
    });

    expect(transaction.setDimension).toHaveBeenCalledWith(
      IDS.edition,
      "participant_count",
      13,
    );
    expect(transaction.createCard).toHaveBeenCalledWith(expect.objectContaining({
      cardTypeKey: "CompetitionEditionCard",
      dimensions: expect.objectContaining({
        source_system: "USTCTTA-site",
        source_id: "match-14",
      }),
    }));
    expect(outcome.summary).toMatchObject({
      total: 2,
      created: 1,
      updated: 1,
      unchanged: 0,
    });
  });
});

describe("competition.organize_series", () => {
  it("creates one series and links selected editions through the series Slot", async () => {
    const transaction = fixture([
      card({ id: IDS.edition, cardTypeKey: "CompetitionEditionCard" }),
      card({ id: IDS.editionTwo, cardTypeKey: "CompetitionEditionCard" }),
    ]);

    await execute("competition.organize_series", transaction, {
      mode: "create",
      seriesObjectId: IDS.seriesObject,
      name: "积分赛",
      values: {
        description: "为会员提供稳定的竞技积分记录。",
        cadence: "每学期多次",
      },
      editionCardIds: [IDS.edition, IDS.editionTwo],
    });

    expect(transaction.createCard).toHaveBeenCalledWith({
      cardTypeKey: "CompetitionSeriesCard",
      relatedObjectIds: [IDS.seriesObject],
      dimensions: {
        name: "积分赛",
        description: "为会员提供稳定的竞技积分记录。",
        cadence: "每学期多次",
      },
    });
    expect(transaction.setSlot).toHaveBeenCalledTimes(2);
    expect(transaction.setSlot).toHaveBeenCalledWith(
      IDS.edition,
      "series",
      [IDS.series],
    );
  });

  it("can refine series knowledge without attaching another edition", async () => {
    const transaction = fixture([
      card({ id: IDS.series, cardTypeKey: "CompetitionSeriesCard" }),
    ]);

    await execute("competition.organize_series", transaction, {
      mode: "update",
      seriesCardId: IDS.series,
      changes: { cadence: "每学期多次" },
    });

    expect(transaction.setDimension).toHaveBeenCalledWith(
      IDS.series,
      "cadence",
      "每学期多次",
    );
    expect(transaction.setSlot).not.toHaveBeenCalled();
  });

  it("does not silently move an edition from another series", async () => {
    const otherSeriesId = "00000000-0000-4000-8000-000000000202";
    const transaction = fixture([
      card({
        id: IDS.edition,
        cardTypeKey: "CompetitionEditionCard",
        slots: { series: [otherSeriesId] },
      }),
    ]);

    await expect(execute("competition.organize_series", transaction, {
      mode: "create",
      seriesObjectId: IDS.seriesObject,
      name: "积分赛",
      editionCardIds: [IDS.edition],
    })).rejects.toThrow("不能静默改挂");
  });
});
