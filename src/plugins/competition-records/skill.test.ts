import { describe, expect, it } from "vitest";

import {
  AgentSkillSession,
  createAgentSkillToolset,
  SkillRuntimeError,
} from "@/agent-runtime/skill-runtime";
import { competitionRecordsPlugin } from "@/plugins/competition-records/manifest";
import { societyInformationPlugin } from "@/plugins/society-information/dist/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";

const skillId = "echo.competition-records.curate-series";

function fixture() {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(societyInformationPlugin);
  registry.registerPlugin(competitionRecordsPlugin);
  const session = new AgentSkillSession(registry, new ToolRuntime());
  return {
    session,
    toolset: createAgentSkillToolset({ session }),
  };
}

describe("competition series curator Skill", () => {
  it("activates with parsed semantic input", async () => {
    const { session, toolset } = fixture();
    const execute = toolset.tools.activateSkill.execute as unknown as (
      input: { skillId: string; input: unknown },
    ) => Promise<unknown>;

    await expect(execute({
      skillId,
      input: { seriesHint: "积分赛" },
    })).resolves.toMatchObject({
      activated: true,
      input: { seriesHint: "积分赛", editionHints: [] },
      skill: { id: skillId },
    });

    expect(session.active()?.input).toEqual({
      seriesHint: "积分赛",
      editionHints: [],
    });
    expect(session.instructions()).toContain("competition.organize_series");
    expect(session.instructions()).toContain("只调用 competition.organize_series");
  });

  it("enforces the declared View and Command boundary", () => {
    const { session } = fixture();
    session.activate(skillId, {});

    expect(session.canReadView("competition_records")).toBe(true);
    expect(session.canReadView("society_information")).toBe(true);
    expect(session.canReadView("activity_operations")).toBe(false);
    expect(session.canRunCommand(
      "competition_records",
      "competition.organize_series",
    )).toBe(true);
    expect(session.canRunCommand(
      "competition_records",
      "competition.sync_editions",
    )).toBe(false);
    expect(session.canOpenAction("business_view", "competition_records")).toBe(true);
    expect(session.canOpenAction("business_view", "society_information")).toBe(false);
    expect(session.canOpenAction("object")).toBe(false);
    expect(session.canOpenAction("library")).toBe(false);
  });

  it("allows idempotent activation but rejects switching input mid-turn", () => {
    const { session } = fixture();
    const first = session.activate(skillId, { seriesHint: "积分赛" });
    expect(session.activate(skillId, { seriesHint: "积分赛" })).toBe(first);

    expect(() => session.activate(skillId, { seriesHint: "新生赛" }))
      .toThrow(SkillRuntimeError);
  });
});
