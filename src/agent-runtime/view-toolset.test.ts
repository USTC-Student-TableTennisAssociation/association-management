import { describe, expect, it, vi } from "vitest";

import {
  createAgentViewToolset,
  modelFacingCommandInputSchema,
} from "@/agent-runtime/view-toolset";
import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ViewRuntimeError } from "@/view-runtime/domain/errors";

const objectId = "00000000-0000-4000-8000-000000000101";
const cardId = "00000000-0000-4000-8000-000000000201";

function fixture(existingObjects: readonly { id: string; canonicalName: string }[] = []) {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(activityOperationsPlugin);
  const readPort = {
    query: vi.fn().mockResolvedValue({
      viewKey: "activity_operations",
      pluginVersion: "1.0.0",
      schemaVersion: "1",
      stateVersion: "3",
      observedAt: "2026-08-21T00:00:00.000Z",
      cards: [{
        id: cardId,
        viewKey: "activity_operations",
        cardTypeKey: "ActivityCard",
        dimensions: {},
        slots: {},
        relatedObjectIds: [],
      }],
    }),
    locateObject: vi.fn().mockResolvedValue({
      searchedViewKeys: ["activity_operations"],
      cards: [],
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
    resolveObjectReference: (reference) => reference === "O1"
      ? { id: objectId, canonicalName: "Sydaris 人工验收赛" }
      : undefined,
    onProposal: proposals,
  });
  return { commandBus, findExistingObjectsByCanonicalName, proposals, readPort, toolset };
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
    input,
  });
}

describe("Agent View Toolset foreground Object binding", () => {
  it("reports an exact Object with no linked Cards without inventing a fallback", async () => {
    const { readPort, toolset } = fixture();

    await expect(toolset.locateObjectViews("O1")).resolves.toMatchObject({
      object: { ref: "O1", canonicalName: "Sydaris 人工验收赛" },
      searchedViewKeys: ["activity_operations"],
      matches: [],
      next: expect.stringContaining("没有关联这个 Object 的 Card"),
    });
    expect(readPort.locateObject).toHaveBeenCalledWith({
      objectId,
      viewKeys: ["activity_operations"],
      actor: { permissions: ["view.read", "view.write"] },
    });
  });

  it("rejects an Object reference that was not discovered in this request", async () => {
    const { readPort, toolset } = fixture();

    await expect(toolset.locateObjectViews("O99")).rejects.toThrow(
      "尚未出现在本轮知识或业务上下文中",
    );
    expect(readPort.locateObject).not.toHaveBeenCalled();
  });

  it("presents reference fields as model references instead of database UUIDs", () => {
    expect(modelFacingCommandInputSchema(
      {
        type: "object",
        properties: {
          societyCardId: { type: "string", format: "uuid" },
          advisorObjectIds: {
            type: "array",
            items: { type: "string", format: "uuid" },
          },
          description: { type: "string" },
        },
      },
      [
        { path: ["societyCardId"], kind: "card" },
        { path: ["advisorObjectIds"], kind: "object", cardinality: "many" },
      ],
    )).toEqual({
      type: "object",
      properties: {
        societyCardId: expect.objectContaining({ type: "string", pattern: "^V\\d+$" }),
        advisorObjectIds: expect.objectContaining({
          type: "array",
          items: expect.objectContaining({ type: "string" }),
        }),
        description: { type: "string" },
      },
    });
  });

  it("hides an inferred Object ID and exposes only its natural-language name", () => {
    expect(modelFacingCommandInputSchema(
      {
        type: "object",
        properties: {
          activityName: { type: "string" },
          activityObjectId: { type: "string", format: "uuid" },
        },
        required: ["activityName", "activityObjectId"],
      },
      [{
        path: ["activityObjectId"],
        kind: "object",
        inferFromCanonicalNamePath: ["activityName"],
      }],
    )).toEqual({
      type: "object",
      properties: { activityName: { type: "string" } },
      required: ["activityName"],
    });
  });

  it("carries an exactly named foreground Object into the Activity proposal", async () => {
    const { commandBus, proposals, toolset } = fixture();
    toolset.registerPublishedObjects([{ id: objectId, canonicalName: "Sydaris 人工验收赛" }]);

    await runCreateActivity(toolset, { name: "Sydaris人工验收赛", status: "PLANNING" });

    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ objectId, name: "Sydaris人工验收赛" }),
    }));
    expect(proposals).toHaveBeenCalledWith(expect.objectContaining({
      input: { name: "Sydaris人工验收赛", status: "PLANNING" },
    }));
  });

  it("does not guess an Object relation when the foreground name differs", async () => {
    const { commandBus, toolset } = fixture();
    toolset.registerPublishedObjects([{ id: objectId, canonicalName: "会员大赛" }]);

    await runCreateActivity(toolset, { name: "Sydaris人工验收赛", status: "PLANNING" });

    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: { name: "Sydaris人工验收赛", status: "PLANNING" },
    }));
  });

  it("binds the unique exactly named Object already in the current Compilation", async () => {
    const { commandBus, findExistingObjectsByCanonicalName, toolset } = fixture([{
      id: objectId,
      canonicalName: "Sydaris人工验收赛",
    }]);

    await runCreateActivity(toolset, { name: "Sydaris人工验收赛", status: "PLANNING" });

    expect(findExistingObjectsByCanonicalName).toHaveBeenCalledWith("Sydaris人工验收赛");
    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ objectId }),
    }));
  });

  it("resolves model-facing View/Object references and binds state on the server", async () => {
    const { commandBus, proposals, toolset } = fixture();
    await toolset.readView("activity_operations");
    const execute = toolset.tools.runViewCommand.execute as unknown as (
      request: Record<string, unknown>,
    ) => Promise<unknown>;

    await execute({
      viewKey: "activity_operations",
      commandKey: "activity.create_activity",
      commandVersion: "1",
      input: { name: "Sydaris 人工验收赛", objectId: "O1", status: "PLANNING" },
    });

    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      expectedStateVersion: "3",
      input: expect.objectContaining({ objectId }),
    }));
    expect(proposals).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ objectId: "O1" }),
    }));
  });

  it("resolves a View Card reference without exposing its database ID to the model", async () => {
    const { commandBus, proposals, toolset } = fixture();
    await toolset.readView("activity_operations");
    const execute = toolset.tools.runViewCommand.execute as unknown as (
      request: Record<string, unknown>,
    ) => Promise<unknown>;

    await execute({
      viewKey: "activity_operations",
      commandKey: "activity.update_activity",
      commandVersion: "1",
      input: { activityId: "V2", progress: "已完成报名" },
    });

    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: { activityId: cardId, progress: "已完成报名" },
    }));
    expect(proposals).toHaveBeenCalledWith(expect.objectContaining({
      input: { activityId: "V2", progress: "已完成报名" },
    }));
    expect(toolset.presentCards([{
      id: cardId,
      viewKey: "activity_operations",
      cardTypeKey: "ActivityCard",
      dimensions: { progress: "已完成报名" },
      slots: {},
      relatedObjectIds: [objectId],
    }], new Map([[objectId, "O1"]]))).toEqual([{
      ref: "V2",
      cardTypeKey: "ActivityCard",
      dimensions: { progress: "已完成报名" },
      slots: {},
      relatedObjectRefs: ["O1"],
    }]);
  });

  it("returns a recoverable invalid result for a Card database UUID", async () => {
    const { commandBus, toolset } = fixture();
    await toolset.readView("activity_operations");
    const execute = toolset.tools.runViewCommand.execute as unknown as (
      request: Record<string, unknown>,
    ) => Promise<unknown>;

    await expect(execute({
      viewKey: "activity_operations",
      commandKey: "activity.update_activity",
      commandVersion: "1",
      input: { activityId: cardId, progress: "已完成报名" },
    })).resolves.toMatchObject({
      kind: "invalid",
      error: expect.stringContaining("必须使用本轮 readView 返回的真实 V# Card 引用"),
    });

    expect(commandBus.dispatch).not.toHaveBeenCalled();
  });

  it("returns a recoverable invalid result for an Object database UUID", async () => {
    const { commandBus, toolset } = fixture();

    await expect(runCreateActivity(toolset, {
      name: "Sydaris 人工验收赛",
      objectId,
      status: "PLANNING",
    })).resolves.toMatchObject({
      kind: "invalid",
      error: expect.stringContaining("禁止填写数据库 UUID"),
    });

    expect(commandBus.dispatch).not.toHaveBeenCalled();
  });

  it("does not bind an existing Object when the exact name is ambiguous", async () => {
    const { commandBus, toolset } = fixture([
      { id: objectId, canonicalName: "Sydaris人工验收赛" },
      {
        id: "00000000-0000-4000-8000-000000000102",
        canonicalName: "Sydaris人工验收赛",
      },
    ]);

    await runCreateActivity(toolset, { name: "Sydaris人工验收赛", status: "PLANNING" });

    expect(commandBus.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: { name: "Sydaris人工验收赛", status: "PLANNING" },
    }));
  });

  it("submits a complete command batch as independently visible proposals", async () => {
    const { commandBus, proposals, toolset } = fixture();
    commandBus.dispatch
      .mockResolvedValueOnce({
        kind: "proposed",
        proposalId: "00000000-0000-4000-8000-000000000311",
        viewKey: "activity_operations",
        stateVersion: "3",
      })
      .mockResolvedValueOnce({
        kind: "proposed",
        proposalId: "00000000-0000-4000-8000-000000000312",
        viewKey: "activity_operations",
        stateVersion: "3",
      });
    await toolset.readView("activity_operations");
    const execute = toolset.tools.runViewCommand.execute as unknown as (
      request: Record<string, unknown>,
    ) => Promise<unknown>;

    const result = await execute({
      viewKey: "activity_operations",
      commands: [{
        commandKey: "activity.create_activity",
        commandVersion: "1",
        input: { name: "活动一", status: "PLANNING" },
      }, {
        commandKey: "activity.create_activity",
        commandVersion: "1",
        input: { name: "活动二", status: "PLANNING" },
      }],
    });

    expect(result).toMatchObject({
      kind: "batch",
      attemptedCount: 2,
      proposedCount: 2,
      invalidCount: 0,
      submittedProposals: [
        {
          proposalId: "00000000-0000-4000-8000-000000000311",
          commandKey: "activity.create_activity",
          input: { name: "活动一", status: "PLANNING" },
        },
        {
          proposalId: "00000000-0000-4000-8000-000000000312",
          commandKey: "activity.create_activity",
          input: { name: "活动二", status: "PLANNING" },
        },
      ],
      invalidCommands: [],
    });
    expect(commandBus.dispatch).toHaveBeenCalledTimes(2);
    expect(proposals).toHaveBeenCalledTimes(2);
    expect(proposals).toHaveBeenNthCalledWith(1, expect.objectContaining({
      input: { name: "活动一", status: "PLANNING" },
    }));
    expect(proposals).toHaveBeenNthCalledWith(2, expect.objectContaining({
      input: { name: "活动二", status: "PLANNING" },
    }));
  });

  it("returns a recoverable invalid result and continues the rest of a batch", async () => {
    const { commandBus, proposals, toolset } = fixture();
    commandBus.dispatch
      .mockRejectedValueOnce(new ViewRuntimeError("当前状态不允许这个 Command"))
      .mockResolvedValueOnce({
        kind: "proposed",
        proposalId: "00000000-0000-4000-8000-000000000312",
        viewKey: "activity_operations",
        stateVersion: "3",
      });
    await toolset.readView("activity_operations");
    const execute = toolset.tools.runViewCommand.execute as unknown as (
      request: Record<string, unknown>,
    ) => Promise<unknown>;

    const result = await execute({
      viewKey: "activity_operations",
      commands: [{
        commandKey: "activity.create_activity",
        commandVersion: "1",
        input: { name: "无效活动", status: "PLANNING" },
      }, {
        commandKey: "activity.create_activity",
        commandVersion: "1",
        input: { name: "有效活动", status: "PLANNING" },
      }],
    });

    expect(result).toMatchObject({
      kind: "batch",
      attemptedCount: 2,
      proposedCount: 1,
      invalidCount: 1,
      submittedProposals: [{
        proposalId: "00000000-0000-4000-8000-000000000312",
        commandKey: "activity.create_activity",
        input: { name: "有效活动", status: "PLANNING" },
      }],
      invalidCommands: [
        {
          commandKey: "activity.create_activity",
          input: { name: "无效活动", status: "PLANNING" },
          error: "当前状态不允许这个 Command",
        },
      ],
    });
    expect(commandBus.dispatch).toHaveBeenCalledTimes(2);
    expect(proposals).toHaveBeenCalledTimes(1);
  });

  it("rejects a version-suffixed Command key instead of normalizing it", async () => {
    const { commandBus, proposals, toolset } = fixture();
    await toolset.readView("activity_operations");
    const execute = toolset.tools.runViewCommand.execute as unknown as (
      request: Record<string, unknown>,
    ) => Promise<unknown>;

    await expect(execute({
      viewKey: "activity_operations",
      commandKey: "activity.create_activity@1",
      commandVersion: "wrong-model-version",
      input: { name: "版本自动绑定测试", status: "PLANNING" },
    })).resolves.toMatchObject({
      kind: "invalid",
      commandKey: "activity.create_activity@1",
      error: expect.stringContaining("没有声明 Command activity.create_activity@1"),
    });

    expect(commandBus.dispatch).not.toHaveBeenCalled();
    expect(proposals).not.toHaveBeenCalled();
  });
});
