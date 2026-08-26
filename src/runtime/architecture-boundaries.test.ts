import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Echo plugin architecture boundaries", () => {
  it("uses the published SDK as the single source of public Plugin contracts", () => {
    const publicContractWrappers = [
      "src/contracts/schema.ts",
      "src/contracts/view.ts",
      "src/contracts/extension.ts",
      "src/contracts/presentation.ts",
      "src/contracts/skill.ts",
      "src/contracts/tool.ts",
    ];
    for (const file of publicContractWrappers) {
      expect(source(file), file).toContain('from "@sydaris/plugin-sdk"');
    }
    expect(source("src/contracts/view.ts")).not.toContain("interface ViewModule");
    expect(source("src/contracts/extension.ts")).not.toContain("interface EchoPluginManifest");
  });

  it("keeps concrete business identifiers out of Contracts and View Runtime", () => {
    const files = [
      "src/contracts/view.ts",
      "src/runtime/extension-host/extension-registry.ts",
      "src/view-runtime/application/command-bus.ts",
      "src/view-runtime/application/view-read-port.ts",
      "src/view-runtime/persistence/prisma-card-graph.ts",
    ];
    for (const file of files) {
      expect(source(file), file).not.toMatch(/society_information|activity_operations/);
      expect(source(file), file).not.toContain("@/plugins/");
      expect(source(file), file).not.toContain("@/shell/");
    }
  });

  it("loads installed Plugins and Presentations through generated registries", () => {
    const compositionRoot = source("src/shell/composition-root.ts");
    const presentationHost = source(
      "src/view-runtime/presentation-host/work-presentation-host.tsx",
    );
    expect(compositionRoot).not.toContain("@/plugins/");
    expect(compositionRoot).toContain("installedPluginManifests");
    expect(presentationHost).not.toContain("@/plugins/");
    expect(presentationHost).toContain("installedPresentationComponents");
  });

  it("keeps View Modules independent from Prisma and Runtime implementation", () => {
    const pluginSources = [
      "src/plugins/activity-operations/view/schema.ts",
      "src/plugins/activity-operations/view/commands.ts",
      "src/plugins/society-information/view/schema.ts",
      "src/plugins/society-information/view/commands.ts",
    ].map(source).join("\n");
    expect(pluginSources).not.toContain("@/generated/prisma");
    expect(pluginSources).not.toContain("@/db");
    expect(pluginSources).not.toContain("@/view-runtime");
  });

  it("makes the Generic Inspector strictly read-only", () => {
    const inspector = source("src/view-runtime/generic-ui/generic-view-inspector.tsx");
    expect(inspector).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/);
    expect(inspector).not.toMatch(/runViewCommand|setDimension|setSlot|createCard|Raw Graph/i);
  });

  it("contains only the new destructive View persistence model", () => {
    const schema = source("prisma/schema.prisma");
    expect(schema).not.toMatch(/model SemanticCard\b/);
    expect(schema).not.toContain("SemanticContentDimension");
    expect(schema).not.toContain("SemanticSlotBinding");
    expect(schema).not.toContain("publicContractVersion");
    const viewCard = schema.match(/model ViewCard \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(viewCard).not.toMatch(/compilationId|sourceObjectId/);
    const related = schema.match(/model ViewCardRelatedObject \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(related).not.toMatch(/role|relationType|assertionId|provenance/);
  });
});
