import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { ViewModule } from "@/contracts";
import { zodContractSchema } from "@/contracts";
import { ViewOperationRunner } from "@/view-runtime/application/view-operation-runner";

function view(): ViewModule {
  const schema = zodContractSchema(z.object({ value: z.string() }));
  return {
    manifest: {
      key: "test_view",
      label: "Test",
      schemaVersion: "1",
      description: "Test View",
      defaultSettings: { aiWritePolicy: "approval_required" },
    },
    schema: { viewKey: "test_view", schemaVersion: "1", cardTypes: [] },
    queries: [],
    operations: [{
      key: "test.refresh",
      version: "1.0.0",
      label: "Refresh",
      description: "Refreshes the test View.",
      requiredPermissions: ["view.write"],
      requiresCapabilities: [{ key: "test.source.read", versions: "^1.0.0" }],
      commands: ["test.replace"],
      inputSchema: schema,
      outputSchema: schema,
      async execute(context, input) {
        const source = await context.executeTool({
          capabilityKey: "test.source.read",
          capabilityVersion: "1.0.0",
          providerId: "test.source",
          input,
        });
        await context.dispatchCommand({ commandKey: "test.replace", input: source });
        return source as { value: string };
      },
    }],
    commands: [{
      key: "test.replace",
      version: "1",
      label: "Replace",
      allowedInitiators: ["system"],
      requiredPermissions: ["view.write"],
      inputSchema: schema,
      execute: async () => ({}),
    }],
    invariants: [],
    events: [],
  };
}

function runner() {
  const viewModule = view();
  const synchronize = vi.fn().mockResolvedValue(undefined);
  const findUnique = vi.fn().mockResolvedValue({ status: "enabled", schemaVersion: "1" });
  const assertRequirementsAvailable = vi.fn();
  const execute = vi.fn().mockResolvedValue({ value: "fresh" });
  const dispatch = vi.fn().mockResolvedValue({
    kind: "executed",
    executionId: "execution-1",
    viewKey: "test_view",
    stateVersion: "2",
  });
  const subject = new ViewOperationRunner(
    { installedView: { findUnique } } as never,
    { getView: () => viewModule } as never,
    { synchronize } as never,
    {
      assertRequirementsAvailable,
      getContract: () => ({ requiredPermissions: ["tool.test.source.read"] }),
      execute,
    } as never,
    { dispatch } as never,
  );
  return { subject, synchronize, assertRequirementsAvailable, execute, dispatch };
}

describe("ViewOperationRunner", () => {
  it("executes only the Operation's declared Capability and same-View Command", async () => {
    const runtime = runner();

    await expect(runtime.subject.execute<{ value: string }>({
      viewKey: "test_view",
      operationKey: "test.refresh",
      operationVersion: "1.0.0",
      input: { value: "request" },
      actor: { actorId: "actor-1", permissions: ["view.write"] },
    })).resolves.toEqual({ value: "fresh" });

    expect(runtime.synchronize).toHaveBeenCalledOnce();
    expect(runtime.assertRequirementsAvailable).toHaveBeenCalledWith([
      { key: "test.source.read", versions: "^1.0.0" },
    ]);
    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: "test.source.read",
      providerId: "test.source",
      context: {
        caller: { kind: "view", viewKey: "test_view" },
        permissions: ["tool.test.source.read"],
      },
    }));
    expect(runtime.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      viewKey: "test_view",
      commandKey: "test.replace",
      actor: { actorId: "actor-1", permissions: ["view.write"] },
      initiator: "system",
    }));
  });

  it("requires the Operation's user permission before invoking tools", async () => {
    const runtime = runner();

    await expect(runtime.subject.execute({
      viewKey: "test_view",
      operationKey: "test.refresh",
      input: { value: "request" },
      actor: { permissions: ["view.read"] },
    })).rejects.toThrow("缺少 View Operation 权限");
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });
});
