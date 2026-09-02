import { describe, expect, it, vi } from "vitest";

import type { AgentSkillSession } from "@/agent-runtime/skill-runtime";
import { createAgentViewToolset } from "@/agent-runtime/view-toolset";
import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { societyInformationPlugin } from "@/plugins/society-information/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

const skillId = "sydaris.test.activity-curator";
const objectId = "00000000-0000-4000-8000-000000000101";

function skillSession(allowedCommand: string): AgentSkillSession {
  return {
    active: () => ({ extension: { id: skillId } }),
    activeSkillIds: () => [skillId],
    canReadView: (viewKey: string) => viewKey === "activity_operations",
    canRunCommand: (viewKey: string, commandKey: string) =>
      viewKey === "activity_operations" && commandKey === allowedCommand,
    authorizingSkillForCommand: (viewKey: string, commandKey: string) =>
      viewKey === "activity_operations" && commandKey === allowedCommand
        ? { extension: { id: skillId } }
        : undefined,
  } as unknown as AgentSkillSession;
}

function fixture(allowedCommand: string) {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(activityOperationsPlugin);
  registry.registerPlugin(societyInformationPlugin);
  const commandBus = {
    dispatch: vi.fn().mockResolvedValue({
      kind: "proposed",
      proposalId: "00000000-0000-4000-8000-000000000301",
      viewKey: "activity_operations",
      stateVersion: "3",
    }),
  };
  const readPort = {
    query: vi.fn().mockResolvedValue({
      viewKey: "activity_operations",
      pluginVersion: "1.0.0",
      schemaVersion: "1",
      stateVersion: "3",
      observedAt: "2026-08-28T00:00:00.000Z",
      cards: [],
    }),
    locateObject: vi.fn().mockResolvedValue({
      searchedViewKeys: ["activity_operations"],
      cards: [{ viewKey: "activity_operations", cardTypeKey: "ActivityCard" }],
    }),
  };
  const toolset = createAgentViewToolset({
    actor: { permissions: ["view.read", "view.write"] },
    registry,
    readPort: readPort as never,
    commandBus: commandBus as never,
    skillSession: skillSession(allowedCommand),
    resolveObjectReference: (reference) => reference === "O1"
      ? { id: objectId, canonicalName: "秋季队内赛" }
      : undefined,
  });
  return { commandBus, readPort, toolset };
}

async function executeCommand(
  toolset: ReturnType<typeof createAgentViewToolset>,
  commandKey: string,
  input: unknown,
) {
  await toolset.readSnapshot("activity_operations");
  const execute = toolset.tools.runViewCommand.execute as unknown as (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  return execute({ viewKey: "activity_operations", commandKey, input });
}

describe("Agent View Toolset Skill enforcement", () => {
  it("discovers Object Cards only in Views declared by the active Skill", async () => {
    const { readPort, toolset } = fixture("activity.create_activity");

    await expect(toolset.locateObjectViews("O1")).resolves.toMatchObject({
      object: { ref: "O1", canonicalName: "秋季队内赛" },
      searchedViewKeys: ["activity_operations"],
      matches: [{
        viewKey: "activity_operations",
        cardCount: 1,
        cardTypes: [{ cardTypeKey: "ActivityCard", count: 1 }],
      }],
    });
    expect(readPort.locateObject).toHaveBeenCalledWith({
      objectId,
      viewKeys: ["activity_operations"],
      actor: { permissions: ["view.read", "view.write"] },
    });
  });

  it("carries the active Skill identity into Command audit", async () => {
    const { commandBus, toolset } = fixture("activity.create_activity");

    await executeCommand(toolset, "activity.create_activity", {
      name: "秋季队内赛",
      status: "PLANNING",
    });

    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      commandKey: "activity.create_activity",
      initiator: "ai",
      skillId,
    }));
  });

  it("returns a recoverable invalid result for an undeclared Command", async () => {
    const { commandBus, toolset } = fixture("activity.update_activity");

    await expect(executeCommand(toolset, "activity.create_activity", {
      name: "秋季队内赛",
      status: "PLANNING",
    })).resolves.toMatchObject({
      kind: "invalid",
      error: expect.stringContaining("不允许调用"),
    });
    expect(commandBus.dispatch).not.toHaveBeenCalled();
  });
});
