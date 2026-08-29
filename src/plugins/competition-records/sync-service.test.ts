import { describe, expect, it, vi } from "vitest";

import { syncCompetitionEditions } from "@/plugins/competition-records/sync-service";
import type { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";
import type { ViewCommandBus } from "@/view-runtime/application/command-bus";

describe("competition records sync service", () => {
  it("preserves a complete source snapshot through mapping and the v2 system command", async () => {
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
    const execute = vi.fn()
      .mockResolvedValueOnce(sourceBatch)
      .mockResolvedValueOnce(projection);
    const dispatch = vi.fn().mockResolvedValue({
      kind: "executed",
      summary: { total: 0, created: 0, updated: 0, unchanged: 0 },
    });

    const result = await syncCompetitionEditions({
      source: { includeQuickMatches: false },
      caller: { kind: "automation", jobKey: "competition-schedule" },
      actor: { permissions: ["view.write"] },
      toolRuntime: { execute } as unknown as ToolRuntime,
      commandBus: { dispatch } as unknown as ViewCommandBus,
    });

    expect(execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
      capabilityKey: "competition.source.read",
      capabilityVersion: "2.0.0",
      context: expect.objectContaining({
        caller: { kind: "automation", jobKey: "competition-schedule" },
      }),
    }));
    expect(execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      capabilityKey: "competition.edition.project",
      value: { batch: sourceBatch },
    }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      commandKey: "competition.sync_editions",
      commandVersion: "2",
      input: projection,
      initiator: "system",
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
