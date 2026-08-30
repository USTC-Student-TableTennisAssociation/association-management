import { describe, expect, it, vi } from "vitest";

import type { AgentSkillSession } from "@/agent-runtime/skill-runtime";
import { createAgentViewToolset } from "@/agent-runtime/view-toolset";
import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

const skillId = "sydaris.test.activity-curator";

function skillSession(allowedCommand: string): AgentSkillSession {
  return {
    active: () => ({ extension: { id: skillId } }),
    canReadView: (viewKey: string) => viewKey === "activity_operations",
    canRunCommand: (viewKey: string, commandKey: string) =>
      viewKey === "activity_operations" && commandKey === allowedCommand,
  } as unknown as AgentSkillSession;
}

function fixture(allowedCommand: string) {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(activityOperationsPlugin);
  const commandBus = {
    dispatch: vi.fn().mockResolvedValue({
      kind: "proposed",
      proposalId: "00000000-0000-4000-8000-000000000301",
      viewKey: "activity_operations",
      stateVersion: "3",
    }),
  };
  const toolset = createAgentViewToolset({
    actor: { permissions: ["view.read", "view.write"] },
    registry,
    readPort: {
      query: vi.fn().mockResolvedValue({
        viewKey: "activity_operations",
        pluginVersion: "1.0.0",
        schemaVersion: "1",
        stateVersion: "3",
        observedAt: "2026-08-28T00:00:00.000Z",
        cards: [],
      }),
    } as never,
    commandBus: commandBus as never,
    skillSession: skillSession(allowedCommand),
  });
  return { commandBus, toolset };
}

async function executeCommand(
  toolset: ReturnType<typeof createAgentViewToolset>,
  commandKey: string,
  input: unknown,
) {
  await toolset.readView("activity_operations");
  const execute = toolset.tools.runViewCommand.execute as unknown as (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  return execute({ viewKey: "activity_operations", commandKey, input });
}

describe("Agent View Toolset Skill enforcement", () => {
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
