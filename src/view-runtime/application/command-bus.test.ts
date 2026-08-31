import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { PluginManifest, ViewModule } from "@/contracts";
import { zodContractSchema } from "@/contracts";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ViewCommandBus } from "@/view-runtime/application/command-bus";

function runtimeFixture(
  policy: "approval_required" | "auto_execute",
  transactionStateVersion = 3,
  proposalConflictPolicy: "exact" | "revalidate_latest" = "exact",
  allowedInitiators: readonly ("human" | "ai" | "system")[] = ["human", "ai"],
  simulateGraphChange = true,
  reactionPolicy = false,
) {
  const proposalActorId = "00000000-0000-4000-8000-000000000001";
  const businessState = { value: "initial" };
  const execute = vi.fn(async (
    _context: unknown,
    input: { value: string },
  ): Promise<{
    summary: { accepted: boolean };
    events?: Array<{ type: string; version: string; payload: { value: string } }>;
  }> => {
    businessState.value = input.value;
    return { summary: { accepted: true } };
  });
  const testCard = {
    id: "00000000-0000-4000-8000-000000000010",
    viewKey: "test_view",
    cardTypeKey: "TestCard",
    dimensions: [],
    outgoingSlots: [],
    relatedObjects: [],
  };
  let graphReadCount = 0;
  const findViewCards = vi.fn(async () => {
    graphReadCount += 1;
    return simulateGraphChange && graphReadCount % 2 === 0 ? [testCard] : [];
  });
  const viewModule: ViewModule = {
    manifest: {
      key: "test_view",
      label: "Test View",
      schemaVersion: "1",
      description: "Test",
      defaultSettings: { aiWritePolicy: policy },
    },
    schema: {
      viewKey: "test_view",
      schemaVersion: "1",
      cardTypes: [{
        key: "TestCard",
        label: "Test Card",
        description: "Test Card",
        dimensions: [],
        slots: [],
        ...(reactionPolicy
          ? { changePolicy: { attention: "evaluate" as const, knowledge: "reconcile" as const } }
          : {}),
      }],
    },
    queries: [],
    commands: [{
      key: "test.accept",
      version: "1",
      label: "Accept",
      allowedInitiators,
      requiredPermissions: ["view.write"],
      inputSchema: zodContractSchema(z.object({ value: z.string() })),
      proposalApprovalConflictPolicy: () => proposalConflictPolicy,
      execute,
    }],
    invariants: [],
    events: [{
      key: "test.accepted",
      version: "1",
      payloadSchema: zodContractSchema(z.object({ value: z.string() })),
    }],
  };
  const plugin: PluginManifest = {
    id: "sydaris.test",
    version: "1.0.0",
    contributes: { views: [viewModule] },
  };
  const registry = new ExtensionRegistry();
  registry.registerPlugin(plugin);
  const installed = {
    viewKey: "test_view",
    moduleId: "sydaris.test",
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
    viewChangeReaction: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: "reaction-1",
          ...data,
          message: null,
          reason: null,
          attentionErrorMessage: null,
          knowledgeErrorMessage: null,
          attentionStartedAt: null,
          attentionCompletedAt: null,
          knowledgeStartedAt: null,
          knowledgeCompletedAt: null,
          seenAt: null,
          createdAt: new Date("2026-08-30T00:00:00.000Z"),
          updatedAt: new Date("2026-08-30T00:00:00.000Z"),
        })
      ),
    },
    memoryGlobalObject: { findMany: vi.fn().mockResolvedValue([]) },
    viewCard: { findMany: findViewCards },
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
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => {
      const valueBefore = businessState.value;
      try {
        return await callback(transaction);
      } catch (error) {
        businessState.value = valueBefore;
        throw error;
      }
    }),
  };
  const installedViews = { synchronize: vi.fn().mockResolvedValue(undefined) };
  const postCommit = { enqueue: vi.fn().mockResolvedValue(true) };
  return {
    bus: new ViewCommandBus(
      database as never,
      registry,
      installedViews as never,
      postCommit,
    ),
    businessState,
    database,
    execute,
    installedViews,
    postCommit,
    proposalActorId,
    transaction,
  };
}

describe("ViewCommandBus", () => {
  it("applies one Command's business semantics for human, AI, approved AI, and system paths", async () => {
    const executeDirectly = async (initiator: "human" | "ai" | "system") => {
      const fixture = runtimeFixture(
        "auto_execute",
        3,
        "exact",
        ["human", "ai", "system"],
      );
      await fixture.bus.dispatch({
        viewKey: "test_view",
        commandKey: "test.accept",
        commandVersion: "1",
        input: { value: "committed" },
        actor: { permissions: ["view.write"] },
        initiator,
        expectedStateVersion: "3",
      });
      return fixture.businessState.value;
    };

    const approved = runtimeFixture(
      "approval_required",
      3,
      "exact",
      ["human", "ai", "system"],
    );
    approved.database.viewCommandProposal.findUnique.mockResolvedValueOnce({
      id: "proposal-1",
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      inputJson: { value: "committed" },
      expectedStateVersion: BigInt(3),
      proposedByActorId: approved.proposalActorId,
      skillId: null,
      status: "pending",
    });
    await approved.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "committed" },
      actor: { actorId: approved.proposalActorId, permissions: ["view.write"] },
      initiator: "ai",
      expectedStateVersion: "3",
    });
    expect(approved.businessState.value).toBe("initial");
    await approved.bus.decideProposal({
      proposalId: "proposal-1",
      decision: "approve",
      actor: { actorId: approved.proposalActorId, permissions: ["view.write"] },
    });

    await expect(Promise.all([
      executeDirectly("human"),
      executeDirectly("ai"),
      executeDirectly("system"),
    ])).resolves.toEqual(["committed", "committed", "committed"]);
    expect(approved.businessState.value).toBe("committed");
  });

  it("keeps a Proposal non-mutating until approval commits the Command", async () => {
    const fixture = runtimeFixture("approval_required");

    await fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "committed" },
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
      initiator: "ai",
      expectedStateVersion: "3",
    });

    expect(fixture.businessState.value).toBe("initial");
    expect(fixture.database.viewCommandProposal.create).toHaveBeenCalledOnce();
    expect(fixture.transaction.viewCommandExecution.create).not.toHaveBeenCalled();

    fixture.database.viewCommandProposal.findUnique.mockResolvedValueOnce({
      id: "proposal-1",
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      inputJson: { value: "committed" },
      expectedStateVersion: BigInt(3),
      proposedByActorId: fixture.proposalActorId,
      skillId: null,
      status: "pending",
    });
    await fixture.bus.decideProposal({
      proposalId: "proposal-1",
      decision: "approve",
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
    });

    expect(fixture.businessState.value).toBe("committed");
    expect(fixture.transaction.viewCommandExecution.create).toHaveBeenCalledOnce();
    expect(fixture.transaction.viewCommandProposal.update).toHaveBeenCalledWith({
      where: { id: "proposal-1" },
      data: {
        status: "applied",
        executionId: "execution-1",
        decidedAt: expect.any(Date),
        appliedAt: expect.any(Date),
      },
    });
  });

  it("schedules Human post-commit work inside the Runtime after the transaction commits", async () => {
    const fixture = runtimeFixture(
      "auto_execute",
      3,
      "exact",
      ["human", "ai", "system"],
      true,
      true,
    );

    await expect(fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "committed" },
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
      initiator: "human",
      expectedStateVersion: "3",
    })).resolves.toMatchObject({
      kind: "executed",
      reaction: { id: "reaction-1" },
    });

    expect(fixture.transaction.viewChangeReaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attentionPolicy: "evaluate",
        attentionStatus: "queued",
        knowledgePolicy: "reconcile",
        knowledgeStatus: "queued",
      }),
    });
    expect(fixture.postCommit.enqueue).toHaveBeenCalledWith({ reactionId: "reaction-1" });
    expect(fixture.postCommit.enqueue.mock.invocationCallOrder[0])
      .toBeGreaterThan(fixture.database.$transaction.mock.invocationCallOrder[0]);
  });

  it.each(["ai", "system"] as const)(
    "routes %s execution through knowledge-only post-commit policy",
    async (initiator) => {
      const fixture = runtimeFixture(
        "auto_execute",
        3,
        "exact",
        ["human", "ai", "system"],
        true,
        true,
      );

      await fixture.bus.dispatch({
        viewKey: "test_view",
        commandKey: "test.accept",
        commandVersion: "1",
        input: { value: "committed" },
        actor: { permissions: ["view.write"] },
        initiator,
        expectedStateVersion: "3",
      });

      expect(fixture.transaction.viewChangeReaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          attentionPolicy: "never",
          attentionStatus: "not_required",
          knowledgePolicy: "reconcile",
          knowledgeStatus: "queued",
        }),
      });
      expect(fixture.postCommit.enqueue).toHaveBeenCalledWith({ reactionId: "reaction-1" });
    },
  );

  it("rejects an AI caller for a system-only Command", async () => {
    const fixture = runtimeFixture("auto_execute", 3, "exact", ["system"]);
    await expect(fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "hello" },
      actor: { permissions: ["view.write"] },
      initiator: "ai",
      expectedStateVersion: "3",
    })).rejects.toThrow(/不允许 ai 调用/);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("treats the stored Plugin version as diagnostic metadata", async () => {
    const fixture = runtimeFixture("auto_execute");
    fixture.database.installedView.findUnique.mockResolvedValueOnce({
      viewKey: "test_view",
      moduleId: "sydaris.test",
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
      moduleId: "sydaris.test",
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

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.database.$transaction).not.toHaveBeenCalled();
    expect(fixture.database.viewCommandProposal.create).toHaveBeenCalledOnce();
  });

  it("runs Domain validation only when a Proposal is approved", async () => {
    const fixture = runtimeFixture("approval_required");

    await expect(fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "hello" },
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
      initiator: "ai",
      expectedStateVersion: "3",
    })).resolves.toMatchObject({ kind: "proposed" });

    expect(fixture.database.viewCommandProposal.create).toHaveBeenCalledOnce();
    expect(fixture.execute).not.toHaveBeenCalled();

    fixture.execute.mockRejectedValueOnce(new Error("需要 SocietyCard Card"));
    await expect(fixture.bus.decideProposal({
      proposalId: "proposal-1",
      decision: "approve",
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
    })).rejects.toThrow("需要 SocietyCard Card");

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.database.viewCommandProposal.updateMany).toHaveBeenCalledWith({
      where: { id: "proposal-1", status: "pending" },
      data: {
        status: "failed",
        decidedAt: expect.any(Date),
        failureReason: "需要 SocietyCard Card",
      },
    });
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
      data: expect.objectContaining({
        changeSetJson: [expect.objectContaining({ kind: "card_created" })],
        eventsJson: [],
      }),
      select: { id: true },
    });
  });

  it("stores validated Domain Events on their Command Execution", async () => {
    const fixture = runtimeFixture("auto_execute");
    fixture.execute.mockResolvedValueOnce({
      summary: { accepted: true },
      events: [{ type: "test.accepted", version: "1", payload: { value: "hello" } }],
    });

    await fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "hello" },
      actor: { permissions: ["view.write"] },
      initiator: "ai",
      expectedStateVersion: "3",
    });

    expect(fixture.transaction.viewCommandExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventsJson: [{
          type: "test.accepted",
          version: "1",
          payload: { value: "hello" },
        }],
      }),
      select: { id: true },
    });
  });

  it("records a no-op Command without advancing the View stateVersion", async () => {
    const fixture = runtimeFixture(
      "auto_execute",
      3,
      "exact",
      ["human", "ai", "system"],
      false,
    );

    await expect(fixture.bus.dispatch({
      viewKey: "test_view",
      commandKey: "test.accept",
      commandVersion: "1",
      input: { value: "unchanged" },
      actor: { permissions: ["view.write"] },
      initiator: "system",
      expectedStateVersion: "3",
    })).resolves.toMatchObject({
      kind: "executed",
      stateVersion: "3",
    });

    expect(fixture.transaction.installedView.updateMany).toHaveBeenCalledWith({
      where: { viewKey: "test_view", stateVersion: BigInt(3) },
      data: { stateVersion: BigInt(3) },
    });
    expect(fixture.transaction.viewCommandExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stateVersionBefore: BigInt(3),
        stateVersionAfter: BigInt(3),
        changeSetJson: [],
      }),
      select: { id: true },
    });
  });

  it("allows a member to approve their own AI Proposal", async () => {
    const fixture = runtimeFixture(
      "approval_required",
      3,
      "exact",
      ["human", "ai"],
      true,
      true,
    );

    await expect(fixture.bus.decideProposal({
      proposalId: "proposal-1",
      decision: "approve",
      actor: { actorId: fixture.proposalActorId, permissions: ["view.write"] },
    })).resolves.toMatchObject({
      kind: "executed",
      executionId: "execution-1",
      viewKey: "test_view",
      stateVersion: "4",
      summary: { accepted: true },
      reaction: {
        id: "reaction-1",
        attention: { policy: "never", status: "not_required" },
        knowledge: { policy: "reconcile", status: "queued" },
      },
    });

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.transaction.viewCommandProposal.update).toHaveBeenCalledWith({
      where: { id: "proposal-1" },
      data: {
        status: "applied",
        executionId: "execution-1",
        decidedAt: expect.any(Date),
        appliedAt: expect.any(Date),
      },
    });
    expect(fixture.postCommit.enqueue).toHaveBeenCalledWith({ reactionId: "reaction-1" });
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
