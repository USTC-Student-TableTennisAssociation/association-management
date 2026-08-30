import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

type InstalledPluginSource = {
  id: string;
  root: string;
  files: string[];
};

function typescriptSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (["dist", "node_modules"].includes(entry.name)) return [];
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return typescriptSources(path);
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.test\.|\.d\.ts$/.test(entry.name)) return [];
    return [path];
  });
}

function installedPluginSources(): InstalledPluginSource[] {
  const installation = JSON.parse(source("echo.plugins.json")) as {
    plugins: Array<{ source: string; manifest: string }>;
  };
  return installation.plugins.flatMap((plugin) => {
    if (plugin.source !== "local") return [];
    const manifestPath = resolve(process.cwd(), plugin.manifest);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id: string };
    const root = dirname(manifestPath);
    return [{ id: manifest.id, root, files: typescriptSources(root) }];
  });
}

function displayPath(path: string): string {
  return relative(process.cwd(), path);
}

function pluginBoundaryViolations(): Array<{ pluginId: string; message: string }> {
  return installedPluginSources().flatMap((plugin) =>
    plugin.files.flatMap((file) => {
      const contents = readFileSync(file, "utf8");
      return /from\s+["']@\//.test(contents)
        ? [{
            pluginId: plugin.id,
            message: `${plugin.id}: ${displayPath(file)} imports a host-internal @/ module`,
          }]
        : [];
    })
  );
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

  it("keeps Command post-commit orchestration inside the View Runtime", () => {
    const commandRoute = source(
      "src/app/api/views/[viewKey]/commands/[commandKey]/route.ts",
    );
    const commandBus = source("src/view-runtime/application/command-bus.ts");
    expect(commandRoute).not.toContain("viewChangeCoordinator");
    expect(commandRoute).not.toContain("reaction.enqueue");
    expect(commandBus).toContain("this.postCommit.enqueue");
  });

  it("keeps every installed Plugin behind the public SDK boundary", () => {
    expect(pluginBoundaryViolations().map((violation) => violation.message)).toEqual([]);
  });

  it("keeps Generic Surfaces read-only", () => {
    const genericSurfaces = [
      "src/view-runtime/generic-ui/generic-view-inspector.tsx",
      "src/view-runtime/generic-ui/work-view-workspace.tsx",
    ];
    for (const file of genericSurfaces) {
      const contents = source(file);
      expect(contents, file).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/);
      expect(contents, file).not.toMatch(
        /runViewCommand|setDimension|setSlot|setRelatedObjects|createCard|deleteCard|Raw Graph/i,
      );
    }
  });

  it("keeps specialized Presentations away from Card Graph persistence", () => {
    const presentationFiles = installedPluginSources().flatMap((plugin) =>
      plugin.files.filter((file) => file.includes("/presentation/"))
    );
    expect(presentationFiles.length).toBeGreaterThan(0);
    for (const file of presentationFiles) {
      const contents = readFileSync(file, "utf8");
      expect(contents, displayPath(file)).not.toMatch(
        /@\/db|@\/generated\/prisma|@\/view-runtime\/persistence|PrismaCardGraphTransaction/,
      );
      expect(contents, displayPath(file)).not.toMatch(
        /\.viewCard\.(?:create|update|delete)|\.viewDimensionValue\.|\.viewSlotBinding\./,
      );
      if (/method:\s*["'](?:POST|PUT|PATCH|DELETE)/.test(contents)) {
        expect(contents, displayPath(file)).toMatch(/useEchoCommand|\/commands\//);
      }
    }
  });

  it("contains only the current View persistence model", () => {
    const schema = source("prisma/schema.prisma");
    expect(schema).not.toMatch(/model SemanticCard\b/);
    expect(schema).not.toContain("SemanticContentDimension");
    expect(schema).not.toContain("SemanticSlotBinding");
    expect(schema).not.toContain("publicContractVersion");
    expect(schema).not.toContain("DomainEventOutbox");
    expect(source("src/view-runtime/application/command-bus.ts"))
      .not.toContain("domainEventOutbox");
    const viewCard = schema.match(/model ViewCard \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(viewCard).not.toMatch(/compilationId|sourceObjectId/);
    const related = schema.match(/model ViewCardRelatedObject \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(related).not.toMatch(/role|relationType|assertionId|provenance/);
  });

  it("models cognition as one Shared Brain without compilation snapshot compatibility", () => {
    const schema = source("prisma/schema.prisma");
    expect(schema).not.toMatch(/model MemoryCompilation\b|\bcompilationId\b/);

    const runtimeFiles = [
      ...typescriptSources(resolve(process.cwd(), "src/library")),
      ...typescriptSources(resolve(process.cwd(), "src/memory")),
    ];
    for (const file of runtimeFiles) {
      const contents = readFileSync(file, "utf8");
      expect(contents, displayPath(file)).not.toMatch(
        /\bmemoryCompilation\b|memory-compilation:/,
      );
    }

    expect(existsSync(resolve(process.cwd(), "prisma/import-source-semantics.ts")))
      .toBe(false);
    expect(source("package.json")).not.toContain("memory:import-cold-start");
  });

  it("keeps the cold-start worker on the current Source Semantics pipeline", () => {
    const cli = source("services/cold-start/src/cold_start/cli.py");
    expect(cli).not.toMatch(/map-activity|compile-leaf|FullBasicCompilation|LeafBasicCompiler/);
    expect(existsSync(resolve(
      process.cwd(),
      "services/cold-start/src/cold_start/activity_view/runtime.py",
    ))).toBe(false);
    for (const file of ["leaf.py", "models.py", "operations.py", "tree.py"]) {
      expect(
        existsSync(resolve(process.cwd(), "services/cold-start/src/cold_start/compilation", file)),
        file,
      ).toBe(false);
    }
  });
});
