import { describe, expect, it, vi } from "vitest";

import type { ViewOperationContext } from "@sydaris/plugin-sdk";

import { competitionSyncOperation } from "./operations";

describe("Competition Records View Operations", () => {
  it("preserves a complete source snapshot through mapping and the system command", async () => {
    const sourceBatch = {
      sourceSystem: "USTCTTA-site" as const,
      sourceSchemaVersion: "1" as const,
      sourceSnapshotAt: "2026-08-29T12:00:00.000Z",
      complete: true as const,
      pageCount: 3,
      records: [],
    };
    const projection = {
      sourceSystem: "USTCTTA-site" as const,
      sourceSchemaVersion: "1" as const,
      mappingVersion: "1" as const,
      sourceSnapshotAt: sourceBatch.sourceSnapshotAt,
      editions: [],
    };
    const executeTool = vi.fn()
      .mockResolvedValueOnce(sourceBatch)
      .mockResolvedValueOnce(projection);
    const dispatchCommand = vi.fn().mockResolvedValue({
      kind: "executed",
      executionId: "execution-1",
      viewKey: "competition_records",
      stateVersion: "2",
      summary: { total: 0, created: 0, updated: 0, unchanged: 0 },
    });
    const context: ViewOperationContext = {
      viewKey: "competition_records",
      actor: { permissions: ["view.write"] },
      executeTool,
      dispatchCommand,
    };

    const result = await competitionSyncOperation.execute(
      context,
      competitionSyncOperation.inputSchema.parse({ includeQuickMatches: false }),
    );

    expect(executeTool).toHaveBeenNthCalledWith(1, expect.objectContaining({
      capabilityKey: "competition.source.read",
      capabilityVersion: "2.0.0",
      providerId: "ustctta.competition-source",
    }));
    expect(executeTool).toHaveBeenNthCalledWith(2, expect.objectContaining({
      capabilityKey: "competition.edition.project",
      input: { batch: sourceBatch },
    }));
    expect(dispatchCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandKey: "competition.sync_editions",
      commandVersion: "2",
      input: projection,
    }));
    expect(result.source).toEqual({
      sourceSystem: "USTCTTA-site",
      sourceSnapshotAt: "2026-08-29T12:00:00.000Z",
      complete: true,
      pageCount: 3,
      recordCount: 0,
    });
  });
});
