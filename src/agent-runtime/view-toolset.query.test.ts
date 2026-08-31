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
      "必须先用 openBusinessContext 选择并读取该 View",
    );
  });

  it("returns a typed result with Runtime-owned state and evidence references", async () => {
    const { onQueryResult, toolset } = fixture();
    await toolset.readView("competition_records");
    const execute = toolset.tools.query_competition_records_summarize_participation
      .execute as unknown as (input: unknown) => Promise<unknown>;

    await expect(execute({ seriesName: "积分赛" })).resolves.toMatchObject({
      view: {
        ref: "V1",
        viewKey: "competition_records",
        schemaVersion: "1",
        stateVersion: "9",
        observedAt: "2026-08-31T00:00:00.000Z",
      },
      query: {
        key: "summarize_participation",
        version: "1.0.0",
      },
      result: {
        editionCount: 2,
        participantCountSum: 72,
        averageParticipantCountPerEdition: 36,
      },
      coverage: {
        level: "complete",
        sourceCardCount: 3,
      },
      references: {
        viewRef: "V1",
        sourceCardRefs: ["V2", "V4", "V3"],
        sourceRefsTruncated: false,
      },
    });
    expect(onQueryResult).toHaveBeenCalledWith({
      viewKey: "competition_records",
      complete: true,
      sourceCardCount: 3,
    });
  });

  it("does not expose Query tools from a View outside the active Skill", () => {
    const { toolset } = fixture({
      canReadView: (viewKey: string) => viewKey === "society_information",
    } as unknown as AgentSkillSession);

    expect(toolset.queryToolNames(["competition_records"])).toEqual([]);
  });
});
