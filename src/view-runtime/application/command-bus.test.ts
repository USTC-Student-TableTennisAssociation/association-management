import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { EchoPluginManifest, ViewModule } from "@/contracts";
import { zodContractSchema } from "@/contracts";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ViewCommandBus } from "@/view-runtime/application/command-bus";

function runtimeFixture(policy: "approval_required" | "auto_execute") {
  const execute = vi.fn(async () => ({ summary: { accepted: true } }));
  const viewModule: ViewModule = {
    manifest: {
      key: "test_view",
      label: "Test View",
      version: "1.0.0",
      schemaVersion: "1",
      description: "Test",
      defaultSettings: { aiWritePolicy: policy },
    },
    schema: { viewKey: "test_view", schemaVersion: "1", cardTypes: [] },
    commands: [{
      key: "test.accept",
      version: "1",
      label: "Accept",
      requiredPermissions: ["view.write"],
      inputSchema: zodContractSchema(z.object({ value: z.string() })),
      execute,
    }],
    invariants: [],
    events: [],
    projections: [],
  };
  const plugin: EchoPluginManifest = {
    id: "echo.test",
    version: "1.0.0",
    contributes: { views: [viewModule] },
  };
  const registry = new ExtensionRegistry();
  registry.registerPlugin(plugin);
  const installed = {
    viewKey: "test_view",
    moduleId: "echo.test",
    moduleVersion: "1.0.0",
    schemaVersion: "1",
    stateVersion: BigInt(3),
    status: "enabled",
    settingsJson: { aiWritePolicy: policy },
  };
  const transaction = {
    installedView: {
      findUnique: vi.fn().mockResolvedValue(installed),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    viewCommandProposal: { findFirst: vi.fn() },
    viewCommandExecution: {
      create: vi.fn().mockResolvedValue({ id: "execution-1" }),
    },
    domainEventOutbox: { create: vi.fn() },
  };
  const database = {
    installedView: {
      findUnique: vi.fn().mockResolvedValue(installed),
    },
    viewCommandProposal: {
      create: vi.fn().mockResolvedValue({ id: "proposal-1" }),
    },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction)),
  };
  const installedViews = { synchronize: vi.fn().mockResolvedValue(undefined) };
  return {
    bus: new ViewCommandBus(database as never, registry, installedViews as never),
    database,
    execute,
    installedViews,
    transaction,
  };
}

describe("ViewCommandBus", () => {
  it("turns an AI command into a Proposal when the View requires approval", async () => {
    const fixture = runtimeFixture("approval_required");

    await expect(fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "hello" },
      actor: { actorId: "00000000-0000-4000-8000-000000000001", permissions: ["view.write"] },
      initiator: "ai",
      expectedStateVersion: "3",
    })).resolves.toEqual({
      kind: "proposed",
      proposalId: "proposal-1",
      viewKey: "test_view",
      stateVersion: "3",
    });

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.database.$transaction).not.toHaveBeenCalled();
    expect(fixture.database.viewCommandProposal.create).toHaveBeenCalledOnce();
  });

  it("executes the same Domain Command atomically when the View allows AI writes", async () => {
    const fixture = runtimeFixture("auto_execute");

    await expect(fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "hello" },
      actor: { permissions: ["view.write"] },
      initiator: "ai",
      expectedStateVersion: "3",
    })).resolves.toEqual({
      kind: "executed",
      executionId: "execution-1",
      viewKey: "test_view",
      stateVersion: "4",
      summary: { accepted: true },
    });

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.transaction.installedView.updateMany).toHaveBeenCalledWith({
      where: { viewKey: "test_view", stateVersion: BigInt(3) },
      data: { stateVersion: BigInt(4) },
    });
    expect(fixture.transaction.viewCommandExecution.create).toHaveBeenCalledOnce();
  });
});
