import { describe, expect, it } from "vitest";

import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { competitionRecordsPlugin } from "@sydaris/competition-records-plugin/server";

describe("competition records Plugin", () => {
  it("registers the view, AI commands, and executable series-curation skill", () => {
    const registry = new ExtensionRegistry();
    registry.registerPlugin(competitionRecordsPlugin);

    const view = registry.getView("competition_records");
    expect(view?.commands.map((command) => command.key)).toEqual([
      "competition.sync_editions",
      "competition.organize_series",
    ]);
    expect(registry.listSkills().map((skill) => skill.id)).toEqual([
      "sydaris.competition-records.curate-series",
    ]);
    expect(registry.listToolCapabilityContracts().map((contract) => contract.key)).toEqual([
      "competition.source.read",
      "competition.edition.project",
    ]);
    expect(registry.listToolCapabilityContracts().map((contract) => contract.version))
      .toEqual(["2.0.0", "2.0.0"]);
    expect(registry.listToolProviders().map((provider) => provider.id)).toEqual([
      "ustctta.competition-source",
      "sydaris.competition-edition-projection",
    ]);
    expect(registry.listToolProviders().map((provider) => provider.version))
      .toEqual(["2.0.0", "2.0.0"]);
    expect(registry.listToolCapabilityContracts().every((contract) =>
      !contract.allowedCallers.includes("agent")
    )).toBe(true);
    expect(view?.commands.find((command) =>
      command.key === "competition.sync_editions"
    )).toMatchObject({ version: "2", allowedInitiators: ["system"] });
    expect(view?.operations).toMatchObject([{
      key: "competition.sync_from_source",
      version: "1.0.0",
      commands: ["competition.sync_editions"],
    }]);
    expect(view?.commands.filter((command) =>
      command.allowedInitiators.includes("ai")
    ).map((command) => command.key)).toEqual(["competition.organize_series"]);
  });
});
