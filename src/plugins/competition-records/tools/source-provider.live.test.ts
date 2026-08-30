import { describe, expect, it } from "vitest";

import { readUstcttaCompetitionData } from "@/plugins/competition-records/tools/source-provider";

const runLive = process.env.SYDARIS_LIVE_USTCTTA_COMPETITION_SOURCE_TEST === "1";

describe.runIf(runLive)("USTCTTA competition source live", () => {
  it("reads the complete formal-competition scope from one database snapshot", async () => {
    const result = await readUstcttaCompetitionData({
      includeQuickMatches: false,
    }, { pageSize: 7 });

    expect(result.complete).toBe(true);
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.pageCount).toBe(Math.ceil(result.records.length / 7));
    expect(result.records.every((record) => !record.isQuickMatch)).toBe(true);
    expect(new Set(result.records.map((record) => record.sourceId)).size)
      .toBe(result.records.length);
    expect(new Date(result.sourceSnapshotAt).toISOString())
      .toBe(result.sourceSnapshotAt);
    console.info("[competition.source.live]", JSON.stringify({
      sourceSnapshotAt: result.sourceSnapshotAt,
      pageCount: result.pageCount,
      recordCount: result.records.length,
    }));
  });
});
