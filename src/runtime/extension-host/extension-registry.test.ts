import { z } from "zod";
import { describe, expect, it } from "vitest";

import type { EchoPluginManifest, ViewModule } from "@/contracts";
import { zodContractSchema } from "@/contracts";
import {
  ExtensionRegistrationError,
  ExtensionRegistry,
} from "@/runtime/extension-host/extension-registry";

function view(key = "test_view"): ViewModule {
  return {
    manifest: {
      key,
      label: "Test",
      schemaVersion: "1",
      description: "Test View",
      defaultSettings: { aiWritePolicy: "approval_required" },
    },
    schema: {
      viewKey: key,
      schemaVersion: "1",
      cardTypes: [{
        key: "RootCard",
        label: "Root",
        description: "Root",
        dimensions: [{ key: "name", label: "Name", type: "text" }],
        slots: [],
      }],
    },
    commands: [],
    invariants: [],
    events: [],
    projections: [],
  };
}

describe("ExtensionRegistry", () => {
  it("registers independently activatable extensions from one physical plugin", () => {
    const viewModule = view();
    const plugin: EchoPluginManifest = {
      id: "echo.test",
      version: "1.0.0",
      contributes: {
        views: [viewModule],
        presentations: [{
          id: "echo.test.board",
          version: "1.0.0",
          targetView: viewModule.manifest.key,
          schemaVersion: "1",
          presentations: [{ key: "board", label: "Board", loader: "test/board" }],
        }],
        skills: [{
          id: "echo.test.plan",
          version: "1.0.0",
          targetView: { viewKey: viewModule.manifest.key, schemaVersion: "1" },
          requiresCapabilities: [{ key: "calendar.read", versions: "^1.0.0" }],
          inputSchema: zodContractSchema(z.object({ focus: z.string() })),
        }],
        tools: [{ id: "echo.test.provider", version: "1.0.0", implementations: [] }],
      },
    };
    const registry = new ExtensionRegistry();
    registry.registerPlugin(plugin);

    expect(registry.listViews()).toEqual([viewModule]);
    expect(registry.listPresentations()).toHaveLength(1);
    expect(registry.listSkills()).toHaveLength(1);
    expect(registry.listToolProviders()).toHaveLength(1);

    registry.setEnabled("presentation", "echo.test.board", false);
    expect(registry.listPresentations()).toEqual([]);
    expect(registry.listPresentations({ includeDisabled: true })).toHaveLength(1);
    expect(registry.getView("test_view")).toBe(viewModule);
  });

  it("rejects duplicate extension identities atomically", () => {
    const registry = new ExtensionRegistry();
    registry.registerPlugin({ id: "echo.one", version: "1.0.0", contributes: { views: [view()] } });
    expect(() => registry.registerPlugin({
      id: "echo.two",
      version: "1.0.0",
      contributes: { views: [view()] },
    })).toThrow(ExtensionRegistrationError);
    expect(registry.listPlugins().map((plugin) => plugin.id)).toEqual(["echo.one"]);
  });

  it("rejects a Slot target that is not declared inside the same View", () => {
    const viewModule = view();
    viewModule.schema.cardTypes[0].slots = [{
      key: "external",
      label: "External",
      cardinality: "one",
      allowedTargetCardTypes: ["OtherViewCard"],
    }];
    const registry = new ExtensionRegistry();
    expect(() => registry.registerPlugin({
      id: "echo.invalid",
      version: "1.0.0",
      contributes: { views: [viewModule] },
    })).toThrow(/undeclared|\u672a声明/i);
  });
});
