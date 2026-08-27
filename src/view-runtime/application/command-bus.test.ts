import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { EchoPluginManifest, ViewModule } from "@/contracts";
import { zodContractSchema } from "@/contracts";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ViewCommandBus } from "@/view-runtime/application/command-bus";

function runtimeFixture(
  policy: "approval_required" | "auto_execute",
  transactionStateVersion = 3,
  proposalConflictPolicy: "exact" | "revalidate_latest" = "exact",
) {
  const proposalActorId = "00000000-0000-4000-8000-000000000001";
  const execute = vi.fn(async () => ({ summary: { accepted: true } }));
  const viewModule: ViewModule = {
    manifest: {
      key: "test_view",
      label: "Test View",
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
      proposalApprovalConflictPolicy: () => proposalConflictPolicy,
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
    pluginVersion: "1.0.0",
    schemaVersion: "1",
    stateVersion: BigInt(3),
    status: "enabled",
    settingsJson: { aiWritePolicy: policy },
  };
  const transaction = {
    installedView: {
      findUnique: vi.fn().mockResolvedValue({
        ...installed,
        stateVersion: BigInt(transactionStateVersion),
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    viewCommandProposal: {
      findFirst: vi.fn().mockResolvedValue({ id: "proposal-1" }),
      update: vi.fn(),
    },
    viewCommandExecution: {
      create: vi.fn().mockResolvedValue({ id: "execution-1" }),
    },
    domainEventOutbox: { create: vi.fn() },
    viewCard: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const database = {
    installedView: {
      findUnique: vi.fn().mockResolvedValue(installed),
    },
    viewCommandProposal: {
      create: vi.fn().mockResolvedValue({ id: "proposal-1" }),
      findUnique: vi.fn().mockResolvedValue({
        id: "proposal-1",
        viewKey: "test_view",
        commandKey: "test.accept",
        commandVersion: "1",
        inputJson: { value: "hello" },
        expectedStateVersion: BigInt(3),
        proposedByActorId: proposalActorId,
        skillId: null,
        status: "pending",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    proposalActorId,
    transaction,
  };
}

describe("ViewCommandBus", () => {
  it("treats the stored Plugin version as diagnostic metadata", async () => {
    const fixture = runtimeFixture("auto_execute");
    fixture.database.installedView.findUnique.mockResolvedValueOnce({
      viewKey: "test_view",
      moduleId: "echo.test",
      pluginVersion: "0.8.0",
      schemaVersion: "1",
      stateVersion: BigInt(3),
      status: "enabled",
      settingsJson: { aiWritePolicy: "auto_execute" },
    });

    await expect(fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "hello" },
      actor: { permissions: ["view.write"] },
      initiator: "ai",
      expectedStateVersion: "3",
    })).resolves.toMatchObject({ kind: "executed", stateVersion: "4" });
  });

  it("rejects a stored Schema that differs from the loaded View contract", async () => {
    const fixture = runtimeFixture("auto_execute");
    fixture.database.installedView.findUnique.mockResolvedValueOnce({
      viewKey: "test_view",
      moduleId: "echo.test",
      pluginVersion: "1.0.0",
      schemaVersion: "0",
      stateVersion: BigInt(3),
      status: "enabled",
      settingsJson: { aiWritePolicy: "auto_execute" },
    });

    await expect(fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "hello" },
      actor: { permissions: ["view.write"] },
      initiator: "ai",
      expectedStateVersion: "3",
    })).rejects.toThrow("Schema");
  });

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

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.database.$transaction).toHaveBeenCalledOnce();
    expect(fixture.database.viewCommandProposal.create).toHaveBeenCalledOnce();
  });

  it("does not persist a Proposal that fails Domain Command preflight", async () => {
    const fixture = runtimeFixture("approval_required");
    fixture.execute.mockRejectedValueOnce(new Error("需要 SocietyCard Card"));

    await expect(fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "hello" },
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
      initiator: "ai",
      expectedStateVersion: "3",
    })).rejects.toThrow("需要 SocietyCard Card");

    expect(fixture.database.viewCommandProposal.create).not.toHaveBeenCalled();
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
    expect(fixture.transaction.viewCommandExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ changeSetJson: [] }),
      select: { id: true },
    });
  });

  it("allows a member to approve their own AI Proposal", async () => {
    const fixture = runtimeFixture("approval_required");

    await expect(fixture.bus.decideProposal({
      proposalId: "proposal-1",
      decision: "approve",
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
    })).resolves.toEqual({
      kind: "executed",
      executionId: "execution-1",
      viewKey: "test_view",
      stateVersion: "4",
      summary: { accepted: true },
    });

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.transaction.viewCommandProposal.update).toHaveBeenCalledWith({
      where: { id: "proposal-1" },
      data: { status: "applied", decidedAt: expect.any(Date), appliedAt: expect.any(Date) },
    });
  });

  it("treats a repeated approval of an applied Proposal as idempotent success", async () => {
    const fixture = runtimeFixture("approval_required");
    fixture.database.viewCommandProposal.findUnique.mockResolvedValueOnce({
      id: "proposal-1",
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      inputJson: { value: "hello" },
      expectedStateVersion: BigInt(3),
      proposedByActorId: fixture.proposalActorId,
      skillId: null,
      status: "applied",
    });

    await expect(fixture.bus.decideProposal({
      proposalId: "proposal-1",
      decision: "approve",
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
    })).resolves.toEqual({
      kind: "already_applied",
      proposalId: "proposal-1",
      viewKey: "test_view",
    });

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.database.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a stale precise Proposal by default", async () => {
    const fixture = runtimeFixture("approval_required", 4);

    await expect(fixture.bus.decideProposal({
      proposalId: "proposal-1",
      decision: "approve",
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
    })).rejects.toThrow("View stateVersion 已变化");

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.database.viewCommandProposal.updateMany).toHaveBeenCalledWith({
      where: { id: "proposal-1", status: "pending" },
      data: {
        status: "failed",
        decidedAt: expect.any(Date),
        failureReason: "View stateVersion 已变化",
      },
    });
  });

  it("revalidates an additive Proposal against the latest View state when opted in", async () => {
    const fixture = runtimeFixture("approval_required", 4, "revalidate_latest");

    await expect(fixture.bus.decideProposal({
      proposalId: "proposal-1",
      decision: "approve",
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
    })).resolves.toEqual({
      kind: "executed",
      executionId: "execution-1",
      viewKey: "test_view",
      stateVersion: "5",
      summary: { accepted: true },
    });

    expect(fixture.execute).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStateVersion: "4" }),
      { value: "hello" },
    );
    expect(fixture.transaction.installedView.updateMany).toHaveBeenCalledWith({
      where: { viewKey: "test_view", stateVersion: BigInt(4) },
      data: { stateVersion: BigInt(5) },
    });
  });

  it("does not allow a member to decide another actor's Proposal", async () => {
    const fixture = runtimeFixture("approval_required");

    await expect(fixture.bus.decideProposal({
      proposalId: "proposal-1",
      decision: "approve",
      actor: {
        actorId: "00000000-0000-4000-8000-000000000002",
        permissions: ["view.write"],
      },
    })).rejects.toThrow("只能处理自己创建的 View Command Proposal");

    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("allows an approver to decide another actor's Proposal", async () => {
    const fixture = runtimeFixture("approval_required");

    await expect(fixture.bus.decideProposal({
      proposalId: "proposal-1",
      decision: "reject",
      actor: {
        actorId: "00000000-0000-4000-8000-000000000002",
        permissions: ["view.approve"],
      },
    })).resolves.toEqual({ kind: "rejected", proposalId: "proposal-1" });

    expect(fixture.database.viewCommandProposal.updateMany).toHaveBeenCalledOnce();
  });
});
