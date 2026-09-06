import "dotenv/config";

import { afterAll, describe, expect, it } from "vitest";

import { getDatabase } from "@/db";
import { viewOperationRunner, viewReadPort } from "@/shell/composition-root";

import {
  COMPETITION_SYNC_OPERATION_KEY,
  type CompetitionSyncSummary,
} from "./operations";

const runLive = process.env.SYDARIS_LIVE_COMPETITION_SYNC_TEST === "1";

describe.runIf(runLive)("competition records sync operation live", () => {
  afterAll(async () => {
    await getDatabase().$disconnect();
  });

  it("moves one complete real source snapshot into Sydaris idempotently", async () => {
    const request = {
      viewKey: "competition_records",
      operationKey: COMPETITION_SYNC_OPERATION_KEY,
      operationVersion: "1.0.0",
      input: { includeQuickMatches: false },
      actor: { permissions: ["view.read", "view.write"] },
    };

    const first = await viewOperationRunner.execute<CompetitionSyncSummary>(request);
    expect(first.source.complete).toBe(true);
    expect(first.source.recordCount).toBeGreaterThan(0);
    expect(first.mapping.editionCount).toBe(first.source.recordCount);
    expect(first.write.kind).toBe("executed");
    if (first.write.kind !== "executed") throw new Error("首次同步没有执行");
    expect(first.write.summary).toMatchObject({ total: first.source.recordCount });
    const firstSummary = first.write.summary as {
      created: number;
      updated: number;
      unchanged: number;
    };
    expect(firstSummary.created + firstSummary.updated + firstSummary.unchanged)
      .toBe(first.source.recordCount);

    const snapshot = await viewReadPort.query({
      viewKey: "competition_records",
      actor: { permissions: ["view.read"] },
    });
    expect(snapshot.cards.filter((card) =>
      card.cardTypeKey === "CompetitionEditionCard"
    )).toHaveLength(first.source.recordCount);

    const second = await viewOperationRunner.execute<CompetitionSyncSummary>(request);
    expect(second.write.kind).toBe("executed");
    if (second.write.kind !== "executed") throw new Error("重复同步没有执行");
    expect(second.write.summary).toMatchObject({
      total: first.source.recordCount,
      created: 0,
      updated: 0,
      unchanged: first.source.recordCount,
    });
  });
});
