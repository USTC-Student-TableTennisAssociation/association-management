import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import descriptor from "@/plugins/competition-records/sydaris.plugin.json";
import { competitionRecordsPlugin } from "@/plugins/competition-records/dist/manifest";
import packageJson from "@/plugins/competition-records/package.json";

const pluginRoot = resolve(process.cwd(), "src/plugins/competition-records");

describe("publishable Competition Records Plugin", () => {
  it("publishes compiled server, operation, tools, and presentation entrypoints", () => {
    expect(packageJson.name).toBe("@sydaris/competition-records-plugin");
    expect(packageJson.version).toBe(competitionRecordsPlugin.version);
    expect(packageJson.sydarisPlugin).toBe("./sydaris.plugin.json");
    expect(packageJson.peerDependencies["@sydaris/plugin-sdk"])
      .toBe(">=0.1.0-alpha.9 <0.2.0-0");
    expect(descriptor.engines.sydaris).toBe(">=0.1.0-alpha.9 <0.2.0-0");
    expect(descriptor.server.entry).toBe("./dist/manifest.js");
    expect(descriptor.contributes.presentations[0].entry).toBe(
      "./dist/presentation/competition-records-workspace.js",
    );
    expect("requires" in competitionRecordsPlugin).toBe(false);
    expect(competitionRecordsPlugin.contributes.views?.[0]?.operations).toMatchObject([{
      key: "competition.sync_from_source",
      version: "1.0.0",
    }]);
  });

  it("contains self-contained View, Tool, and UI output", () => {
    const files = [
      "dist/manifest.js",
      "dist/view/schema.js",
      "dist/view/operations.js",
      "dist/view/commands.js",
      "dist/tools/contracts.js",
      "dist/tools/source-provider.js",
      "dist/presentation/competition-records-workspace.js",
      "dist/presentation/competition-records.module.css",
    ];
    for (const file of files) {
      expect(existsSync(resolve(pluginRoot, file)), file).toBe(true);
    }
    const compiledSources = files.filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(resolve(pluginRoot, file), "utf8"))
      .join("\n");
    expect(compiledSources).not.toContain("@/");
    expect(compiledSources).not.toContain("/api/views/competition_records/sync");
  });
});
