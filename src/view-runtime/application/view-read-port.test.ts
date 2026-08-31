import { describe, expect, it, vi } from "vitest";

import type { PluginManifest, ViewModule } from "@/contracts";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { PrismaViewReadPort } from "@/view-runtime/application/view-read-port";

const objectId = "00000000-0000-4000-8000-000000000101";
const cardId = "00000000-0000-4000-8000-000000000201";

function viewModule(
  viewKey = "test_view",
  label = "测试 View",
): ViewModule {
  return {
    manifest: {
      key: viewKey,
      label,
      specializedLabel: "测试工作台",
      schemaVersion: "1",
      description: "验证 Presentation snapshot 边界。",
      retrievalDescription: "读取测试业务状态。",
      aiSemanticInstructions: "只陈述 Card 中存在的事实。",
      defaultSettings: { aiWritePolicy: "approval_required" },
    },
    schema: {
      viewKey,
      schemaVersion: "1",
      cardTypes: [{
        key: "TestCard",
        label: "测试 Card",
        description: "测试",
        dimensions: [],
        slots: [],
      }],
    },
    queries: [],
    commands: [],
    invariants: [],
    events: [],
  };
}

describe("PrismaViewReadPort", () => {
  it("keeps Runtime snapshots authoritative and enriches only Presentation snapshots", async () => {
    const view = viewModule();
    const plugin: PluginManifest = {
      id: "sydaris.test",
      version: "1.2.3",
      contributes: { views: [view] },
    };
    const registry = new ExtensionRegistry();
    registry.registerPlugin(plugin);
    const database = {
      installedView: {
        findUnique: vi.fn().mockResolvedValue({
          viewKey: "test_view",
          schemaVersion: "1",
          stateVersion: BigInt(7),
          status: "enabled",
          cards: [{
            id: cardId,
            viewKey: "test_view",
            cardTypeKey: "TestCard",
            dimensions: [],
            outgoingSlots: [],
            relatedObjects: [{ objectId }],
          }],
        }),
      },
      memoryGlobalObject: {
        findMany: vi.fn().mockResolvedValue([{ id: objectId, canonicalName: "测试对象" }]),
      },
    };
    const port = new PrismaViewReadPort(
      registry,
      { synchronize: vi.fn().mockResolvedValue(undefined) } as never,
      database as never,
    );
    const actor = { permissions: ["view.read"] };

    const runtimeSnapshot = await port.query({ viewKey: "test_view", actor });
    expect(runtimeSnapshot).toMatchObject({
      viewKey: "test_view",
      pluginVersion: "1.2.3",
      schemaVersion: "1",
      stateVersion: "7",
      cards: [{ id: cardId, relatedObjectIds: [objectId] }],
    });
    expect(runtimeSnapshot).not.toHaveProperty("references");
    expect(runtimeSnapshot).not.toHaveProperty("manifest");
    expect(runtimeSnapshot).not.toHaveProperty("objects");

    const presentationSnapshot = await port.inspect({ viewKey: "test_view", actor });
    expect(presentationSnapshot.manifest).toEqual(view.manifest);
    expect(presentationSnapshot.schema).toEqual(view.schema);
    expect(presentationSnapshot.objects).toEqual([
      { id: objectId, canonicalName: "测试对象" },
    ]);
    expect(presentationSnapshot).not.toHaveProperty("references");
  });

  it("discovers Object-linked Cards only across requested registered and enabled Views", async () => {
    const firstView = viewModule();
    const secondView = viewModule("other_view", "另一个 View");
    const registry = new ExtensionRegistry();
    registry.registerPlugin({
      id: "sydaris.test",
      version: "1.2.3",
      contributes: { views: [firstView, secondView] },
    });
    const synchronize = vi.fn().mockResolvedValue(undefined);
    const findEnabledViews = vi.fn().mockResolvedValue([
      { viewKey: "other_view" },
      { viewKey: "test_view" },
    ]);
    const findCards = vi.fn().mockResolvedValue([
      { viewKey: "other_view", cardTypeKey: "TestCard" },
      { viewKey: "test_view", cardTypeKey: "TestCard" },
      { viewKey: "test_view", cardTypeKey: "TestCard" },
    ]);
    const port = new PrismaViewReadPort(
      registry,
      { synchronize } as never,
      {
        installedView: { findMany: findEnabledViews },
        viewCard: { findMany: findCards },
      } as never,
    );

    await expect(port.locateObject({
      objectId,
      viewKeys: ["test_view", "other_view", "unregistered_view", "test_view"],
      actor: { permissions: ["view.read"] },
    })).resolves.toEqual({
      searchedViewKeys: ["other_view", "test_view"],
      cards: [
        { viewKey: "other_view", cardTypeKey: "TestCard" },
        { viewKey: "test_view", cardTypeKey: "TestCard" },
        { viewKey: "test_view", cardTypeKey: "TestCard" },
      ],
    });
    expect(synchronize).toHaveBeenCalledOnce();
    expect(findEnabledViews).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        viewKey: { in: ["test_view", "other_view"] },
        status: "enabled",
      },
    }));
    expect(findCards).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        viewKey: { in: ["other_view", "test_view"] },
        relatedObjects: { some: { objectId } },
      },
    }));
  });
});
