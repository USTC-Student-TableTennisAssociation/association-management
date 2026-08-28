import { describe, expect, it } from "vitest";

import { modelFacingCommandInputSchema } from "@/agent-runtime/view-toolset";
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
      "competition.create_edition",
      "competition.update_edition",
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
  });

  it("exposes participantCount while keeping inferred Object identity out of AI input", () => {
    const view = competitionRecordsPlugin.contributes.views?.[0];
    const command = view?.commands.find((candidate) =>
      candidate.key === "competition.create_edition"
    );
    expect(command).toBeDefined();

    const schema = modelFacingCommandInputSchema(
      command!.inputSchema.jsonSchema,
      command!.inputReferences,
    ) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("participantCount");
    expect(schema.properties).not.toHaveProperty("objectId");
    expect(schema.required).toContain("participantCount");
  });
});
