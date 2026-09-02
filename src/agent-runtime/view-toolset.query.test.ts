import { describe, expect, it, vi } from "vitest";

import type { AgentSkillSession } from "@/agent-runtime/skill-runtime";
import { createAgentViewToolset } from "@/agent-runtime/view-toolset";
import { competitionRecordsPlugin } from "@/plugins/competition-records/manifest";
import { societyInformationPlugin } from "@/plugins/society-information/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

const IDS = {
  series: "00000000-0000-4000-8000-000000000101",
  first: "00000000-0000-4000-8000-000000000201",
  second: "00000000-0000-4000-8000-000000000202",
};

function fixture(skillSession?: AgentSkillSession) {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(societyInformationPlugin);
  registry.registerPlugin(competitionRecordsPlugin);
  const onQueryResult = vi.fn();
  const toolset = createAgentViewToolset({
    actor: { permissions: ["view.read", "view.write"] },
    registry,
    readPort: {
      query: vi.fn().mockResolvedValue({
        viewKey: "competition_records",
        pluginVersion: "0.4.0",
        schemaVersion: "1",
        stateVersion: "9",
        observedAt: "2026-08-31T00:00:00.000Z",
        cards: [{
          id: IDS.series,
          viewKey: "competition_records",
          cardTypeKey: "CompetitionSeriesCard",
          dimensions: { name: "积分赛" },
          slots: {},
          relatedObjectIds: [],
        }, {
          id: IDS.first,
          viewKey: "competition_records",
          cardTypeKey: "CompetitionEditionCard",
          dimensions: {
            name: "第一周积分赛",
            participant_count: 30,
            held_on: "2025-09-01",
            source_system: "USTCTTA-site",
          },
          slots: { series: [IDS.series] },
          relatedObjectIds: [],
        }, {
          id: IDS.second,
          viewKey: "competition_records",
          cardTypeKey: "CompetitionEditionCard",
          dimensions: {
            name: "第二周积分赛",
            participant_count: 42,
            held_on: "2025-09-08",
            source_system: "USTCTTA-site",
          },
          slots: { series: [IDS.series] },
          relatedObjectIds: [],
        }],
      }),
      locateObject: vi.fn(),
    } as never,
    commandBus: { dispatch: vi.fn() } as never,
    skillSession,
    onQueryResult,
  });
  return { onQueryResult, toolset };
}

describe("Agent View Query Toolset", () => {
  it("exposes the selected View's own Query catalog", () => {
    const { toolset } = fixture();

    expect(toolset.describeQueries("competition_records")).toEqual([
      expect.objectContaining({
        queryKey: "list_editions",
        toolName: "query_competition_records_list_editions",
      }),
      expect.objectContaining({
        queryKey: "summarize_participation",
        toolName: "query_competition_records_summarize_participation",
      }),
      expect.objectContaining({
        queryKey: "participation_trend",
        toolName: "query_competition_records_participation_trend",
      }),
    ]);
  });

  it("requires the View to be opened before running one of its Queries", async () => {
    const { toolset } = fixture();
    const execute = toolset.tools.query_competition_records_summarize_participation
      .execute as unknown as (input: unknown) => Promise<unknown>;

    await expect(execute({ seriesName: "积分赛" })).rejects.toThrow(
      "必须先用 readViewState 读取该 View 的具体业务目标",
    );
  });

  it("returns a typed result with Runtime-owned state and evidence references", async () => {
    const { onQueryResult, toolset } = fixture();
    await toolset.readSnapshot("competition_records");
    const execute = toolset.tools.query_competition_records_summarize_participation
      .execute as unknown as (input: unknown) => Promise<unknown>;

    const output = await execute({ seriesName: "积分赛" }) as Record<string, unknown>;
    expect(output).toMatchObject({
      ok: true,
      view: {
        ref: "V1",
        key: "competition_records",
        label: "赛事档案",
        observedAt: "2026-08-31T00:00:00.000Z",
      },
      query: {
        key: "summarize_participation",
      },
      result: {
        editionCount: 2,
        participantCountSum: 72,
        averageParticipantCountPerEdition: 36,
      },
      references: {
        viewRef: "V1",
        sourceCardRefs: ["V2", "V4", "V3"],
        sourceRefsTruncated: false,
      },
    });
    expect(output).not.toHaveProperty("coverage");
    expect(output).not.toHaveProperty("semantics");
    expect(output).not.toHaveProperty("input");
    expect(onQueryResult).toHaveBeenCalledWith({
      viewKey: "competition_records",
      queryKey: "summarize_participation",
      complete: true,
      sourceCardCount: 3,
      semantics: expect.objectContaining({
        observations: [expect.objectContaining({
          scope: "view:competition_records:query:summarize_participation",
          predicate: "query_returned_result",
        })],
      }),
    });
    expect(onQueryResult).toHaveBeenCalledTimes(1);
  });

  it("returns one structured correction before disabling repeatedly invalid Query input", async () => {
    const { onQueryResult, toolset } = fixture();
    await toolset.readSnapshot("competition_records");
    const toolName = "query_competition_records_participation_trend";
    const execute = toolset.tools[toolName].execute as unknown as (
      input: unknown,
    ) => Promise<unknown>;

    await expect(execute({ seriesName: "积分赛", limit: 50 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_VIEW_QUERY_INPUT",
        viewKey: "competition_records",
        queryKey: "participation_trend",
        issues: [{
          path: "$",
          code: "unrecognized_keys",
          message: "未声明字段：limit",
        }],
        allowedFields: [
          "seriesName",
          "nameContains",
          "sourceSystem",
          "heldOnFrom",
          "heldOnThrough",
        ],
        retryable: true,
        correctionAttemptsRemaining: 1,
      },
    });
    expect(toolset.queryToolNames(["competition_records"])).toContain(toolName);
    expect(onQueryResult).not.toHaveBeenCalled();

    await expect(execute({ seriesName: "积分赛", limit: 50 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_VIEW_QUERY_INPUT",
        retryable: false,
        correctionAttemptsRemaining: 0,
      },
    });
    expect(toolset.queryToolNames(["competition_records"])).not.toContain(toolName);
    expect(onQueryResult).not.toHaveBeenCalled();
  });

  it("accepts a valid correction after one rejected Query input", async () => {
    const { onQueryResult, toolset } = fixture();
    await toolset.readSnapshot("competition_records");
    const execute = toolset.tools.query_competition_records_participation_trend
      .execute as unknown as (input: unknown) => Promise<unknown>;

    await execute({ seriesName: "积分赛", limit: 50 });
    await expect(execute({ seriesName: "积分赛" })).resolves.toMatchObject({
      ok: true,
      result: {
        points: [{
          year: "2025",
          editionCount: 2,
          participantCountSum: 72,
          averageParticipantCountPerEdition: 36,
        }],
      },
    });
    expect(onQueryResult).toHaveBeenCalledTimes(1);
  });

  it("does not expose Query tools from a View outside the active Skill", () => {
    const { toolset } = fixture({
      canReadView: (viewKey: string) => viewKey === "society_information",
    } as unknown as AgentSkillSession);

    expect(toolset.queryToolNames(["competition_records"])).toEqual([]);
  });
});
