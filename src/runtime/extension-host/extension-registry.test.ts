import { z } from "zod";
import { describe, expect, it } from "vitest";

import type { PluginManifest, ViewModule } from "@/contracts";
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
    queries: [],
    commands: [],
    invariants: [],
    events: [],
  };
}

describe("ExtensionRegistry", () => {
  it("registers every extension contributed by one physical plugin", () => {
    const viewModule = view();
    const plugin: PluginManifest = {
      id: "sydaris.test",
      version: "1.0.0",
      contributes: {
        views: [viewModule],
        presentations: [{
          id: "sydaris.test.board",
          version: "1.0.0",
          targetView: viewModule.manifest.key,
          schemaVersion: "1",
          presentations: [{ key: "board", label: "Board", loader: "test/board" }],
        }],
        skills: [{
          id: "sydaris.test.plan",
          version: "1.0.0",
          label: "制定计划",
          description: "根据日历为测试 View 制定计划。",
          inputSchema: zodContractSchema(z.object({ focus: z.string() })),
          instructions: "先读取日历，再执行已声明的 View Command。",
          viewAccess: [{
            viewKey: viewModule.manifest.key,
            schemaVersion: "1",
            mode: "read",
          }],
          requiresCapabilities: [{ key: "calendar.read", versions: "^1.0.0" }],
        }],
        tools: [{ id: "sydaris.test.provider", version: "1.0.0", implementations: [] }],
      },
    };
    const registry = new ExtensionRegistry();
    registry.registerPlugin(plugin);

    expect(registry.listViews()).toEqual([viewModule]);
    expect(registry.listPresentations()).toHaveLength(1);
    expect(registry.listSkills()).toHaveLength(1);
    expect(registry.listToolProviders()).toHaveLength(1);
    expect(registry.getView("test_view")).toBe(viewModule);
  });

  it("rejects duplicate extension identities atomically", () => {
    const registry = new ExtensionRegistry();
    registry.registerPlugin({ id: "sydaris.one", version: "1.0.0", contributes: { views: [view()] } });
    expect(() => registry.registerPlugin({
      id: "sydaris.two",
      version: "1.0.0",
      contributes: { views: [view()] },
    })).toThrow(ExtensionRegistrationError);
    expect(registry.listPlugins().map((plugin) => plugin.id)).toEqual(["sydaris.one"]);
  });

  it("rejects a Skill that requests an unknown View Command", () => {
    const viewModule = view();
    const registry = new ExtensionRegistry();
    expect(() => registry.registerPlugin({
      id: "sydaris.bad-skill",
      version: "1.0.0",
      contributes: {
        views: [viewModule],
        skills: [{
          id: "sydaris.bad-skill.run",
          version: "1.0.0",
          label: "Bad Skill",
          description: "Requests a command outside its target View.",
          inputSchema: zodContractSchema(z.object({})),
          instructions: "Run the missing command.",
          viewAccess: [{
            viewKey: viewModule.manifest.key,
            schemaVersion: "1",
            mode: "write",
            commands: ["test.missing"],
          }],
          requiresCapabilities: [],
        }],
      },
    })).toThrow(ExtensionRegistrationError);
    expect(registry.listPlugins()).toEqual([]);
  });

  it("rejects duplicate View Queries", () => {
    const querySchema = zodContractSchema(z.object({}));
    const viewModule = view();
    viewModule.queries = [{
      key: "summary",
      version: "1.0.0",
      label: "Summary",
      description: "Summarize the View.",
      inputSchema: querySchema,
      outputSchema: querySchema,
      execute: () => ({ data: {}, sourceCardIds: [], coverage: { level: "complete" } }),
    }, {
      key: "summary",
      version: "latest",
      label: "Duplicate",
      description: "Duplicate query.",
      inputSchema: querySchema,
      outputSchema: querySchema,
      execute: () => ({ data: {}, sourceCardIds: [], coverage: { level: "complete" } }),
    }];

    const registry = new ExtensionRegistry();
    expect(() => registry.registerPlugin({
      id: "sydaris.bad-queries",
      version: "1.0.0",
      contributes: { views: [viewModule] },
    })).toThrow("重复的 Query key");
    expect(registry.listPlugins()).toEqual([]);
  });

  it("requires View Query versions to be SemVer", () => {
    const querySchema = zodContractSchema(z.object({}));
    const viewModule = view();
    viewModule.queries = [{
      key: "summary",
      version: "latest",
      label: "Summary",
      description: "Summarize the View.",
      inputSchema: querySchema,
      outputSchema: querySchema,
      execute: () => ({ data: {}, sourceCardIds: [], coverage: { level: "complete" } }),
    }];

    const registry = new ExtensionRegistry();
    expect(() => registry.registerPlugin({
      id: "sydaris.unversioned-query",
      version: "1.0.0",
      contributes: { views: [viewModule] },
    })).toThrow("必须是 SemVer");
    expect(registry.listPlugins()).toEqual([]);
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
      id: "sydaris.invalid",
      version: "1.0.0",
      contributes: { views: [viewModule] },
    })).toThrow(/undeclared|\u672a声明/i);
  });

  it("rejects an invalid View change policy from a published Plugin", () => {
    const viewModule = view();
    viewModule.schema.cardTypes[0].dimensions[0].changePolicy = {
      attention: "sometimes" as never,
    };
    const registry = new ExtensionRegistry();

    expect(() => registry.registerPlugin({
      id: "sydaris.invalid-policy",
      version: "1.0.0",
      contributes: { views: [viewModule] },
    })).toThrow(/changePolicy\.attention/);
  });
});
