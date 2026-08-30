import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import descriptor from "@/plugins/society-information/sydaris.plugin.json";
import { societyInformationPlugin } from "@/plugins/society-information/dist/manifest";
import packageJson from "@/plugins/society-information/package.json";

const pluginRoot = resolve(process.cwd(), "src/plugins/society-information");

describe("publishable Society Information Plugin", () => {
  it("publishes compiled server and presentation entrypoints", () => {
    expect(packageJson.name).toBe("@sydaris/society-information-plugin");
    expect(packageJson.version).toBe(societyInformationPlugin.version);
    expect(packageJson.sydarisPlugin).toBe("./sydaris.plugin.json");
    expect(descriptor.server.entry).toBe("./dist/manifest.js");
    expect(descriptor.contributes.presentations[0].entry).toBe(
      "./dist/presentation/society-overview-workspace.js",
    );
  });

  it("contains self-contained UI code, styles, and assets", () => {
    const files = [
      "dist/manifest.js",
      "dist/presentation/society-overview-workspace.js",
      "dist/presentation/society-overview.module.css",
      "dist/presentation/assets/hero-evening-hall.png",
      "dist/presentation/assets/ustctta-badge.svg",
      "dist/presentation/assets/ustctta-wordmark.svg",
    ];
    for (const file of files) {
      expect(existsSync(resolve(pluginRoot, file)), file).toBe(true);
    }
    const compiledSources = [
      "dist/manifest.js",
      "dist/view/schema.js",
      "dist/view/commands.js",
      "dist/presentation/society-overview-workspace.js",
    ].map((file) => readFileSync(resolve(pluginRoot, file), "utf8")).join("\n");
    expect(compiledSources).not.toContain("@/");
    expect(compiledSources).not.toContain("../../../public");
  });
});
