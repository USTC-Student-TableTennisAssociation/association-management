import { describe, expect, it, vi } from "vitest";

import { createAgentViewToolset } from "@/agent-runtime/view-toolset";
import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

const objectId = "00000000-0000-4000-8000-000000000101";

function fixture(existingObjects: readonly { id: string; canonicalName: string }[] = []) {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(activityOperationsPlugin);
  const readPort = {
    query: vi.fn().mockResolvedValue({
      viewKey: "activity_operations",
      moduleVersion: "1.0.0",
      schemaVersion: "1",
      stateVersion: "3",
      observedAt: "2026-08-21T00:00:00.000Z",
      cards: [],
      references: [],
    }),
  };
  const commandBus = {
    dispatch: vi.fn().mockResolvedValue({
      kind: "proposed",
      proposalId: "00000000-0000-4000-8000-000000000301",
      viewKey: "activity_operations",
      stateVersion: "3",
    }),
  };
  const proposals = vi.fn();
  const findExistingObjectsByCanonicalName = vi.fn().mockResolvedValue(existingObjects);
  const toolset = createAgentViewToolset({
    actor: { permissions: ["view.read", "view.write"] },
    registry,
    readPort: readPort as never,
    commandBus: commandBus as never,
    findExistingObjectsByCanonicalName,
    onProposal: proposals,
  });
  return { commandBus, findExistingObjectsByCanonicalName, proposals, toolset };
}

async function runCreateActivity(
  toolset: ReturnType<typeof createAgentViewToolset>,
  input: Record<string, unknown>,
) {
  await toolset.readView("activity_operations");
  const execute = toolset.tools.runViewCommand.execute as unknown as (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  return execute({
    viewKey: "activity_operations",
    commandKey: "activity.create_activity",
    commandVersion: "1",
    expectedStateVersion: "3",
    input,
  });
}

describe("Agent View Toolset foreground Object binding", () => {
  it("carries an exactly named foreground Object into the Activity proposal", async () => {
    const { commandBus, proposals, toolset } = fixture();
    toolset.registerPublishedObjects([{ id: objectId, canonicalName: "Echo 人工验收赛" }]);

    await runCreateActivity(toolset, { name: "Echo人工验收赛", status: "PLANNING" });

    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ objectId, name: "Echo人工验收赛" }),
    }));
    expect(proposals).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ objectId }),
    }));
  });

  it("does not guess an Object relation when the foreground name differs", async () => {
    const { commandBus, toolset } = fixture();
    toolset.registerPublishedObjects([{ id: objectId, canonicalName: "会员大赛" }]);

    await runCreateActivity(toolset, { name: "Echo人工验收赛", status: "PLANNING" });

    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: { name: "Echo人工验收赛", status: "PLANNING" },
    }));
  });

  it("binds the unique exactly named Object already in the current Compilation", async () => {
    const { commandBus, findExistingObjectsByCanonicalName, toolset } = fixture([{
      id: objectId,
      canonicalName: "Echo人工验收赛",
    }]);

    await runCreateActivity(toolset, { name: "Echo人工验收赛", status: "PLANNING" });

    expect(findExistingObjectsByCanonicalName).toHaveBeenCalledWith("Echo人工验收赛");
    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ objectId }),
    }));
  });

  it("does not bind an existing Object when the exact name is ambiguous", async () => {
    const { commandBus, toolset } = fixture([
      { id: objectId, canonicalName: "Echo人工验收赛" },
      {
        id: "00000000-0000-4000-8000-000000000102",
        canonicalName: "Echo人工验收赛",
      },
    ]);

    await runCreateActivity(toolset, { name: "Echo人工验收赛", status: "PLANNING" });

    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: { name: "Echo人工验收赛", status: "PLANNING" },
    }));
  });
});
