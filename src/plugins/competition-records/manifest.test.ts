import { describe, expect, it } from "vitest";

import { competitionRecordsPlugin } from "@/plugins/competition-records/manifest";
import { societyInformationPlugin } from "@/plugins/society-information/dist/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

describe("competition records Plugin", () => {
  it("registers the view, AI commands, and executable series-curation skill", () => {
    const registry = new ExtensionRegistry();
    registry.registerPlugin(societyInformationPlugin);
    registry.registerPlugin(competitionRecordsPlugin);

    const view = registry.getView("competition_records");
    expect(view?.commands.map((command) => command.key)).toEqual([
      "competition.sync_editions",
      "competition.organize_series",
    ]);
    expect(registry.listSkills().map((skill) => skill.id)).toEqual([
      "echo.competition-records.curate-series",
    ]);
    expect(registry.listToolCapabilityContracts().map((contract) => contract.key)).toEqual([
      "competition.source.read",
      "competition.edition.project",
    ]);
    expect(registry.listToolProviders().map((provider) => provider.id)).toEqual([
      "ustctta.competition-source",
      "echo.competition-edition-projection",
    ]);
    expect(registry.listToolCapabilityContracts().every((contract) =>
      !contract.allowedCallers.includes("agent")
    )).toBe(true);
    expect(view?.commands.find((command) =>
      command.key === "competition.sync_editions"
    )?.allowedInitiators).toEqual(["system"]);
    expect(view?.commands.filter((command) =>
      command.allowedInitiators.includes("ai")
    ).map((command) => command.key)).toEqual(["competition.organize_series"]);
  });
});
