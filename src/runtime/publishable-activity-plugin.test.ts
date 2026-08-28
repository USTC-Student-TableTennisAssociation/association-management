import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import descriptor from "@/plugins/activity-operations/echo.plugin.json";
import { activityOperationsPlugin } from "@/plugins/activity-operations/dist/manifest";
import packageJson from "@/plugins/activity-operations/package.json";

const pluginRoot = resolve(process.cwd(), "src/plugins/activity-operations");

describe("publishable Activity Operations Plugin", () => {
  it("publishes compiled server and presentation entrypoints", () => {
    expect(packageJson.name).toBe("echo-activity-operations-plugin");
    expect(packageJson.version).toBe(activityOperationsPlugin.version);
    expect(packageJson.echoPlugin).toBe("./echo.plugin.json");
    expect(descriptor.server.entry).toBe("./dist/manifest.js");
    expect(descriptor.contributes.presentations[0].entry).toBe(
      "./dist/presentation/activity-operations-workspace.js",
    );
  });

  it("contains self-contained View and UI output", () => {
    const files = [
      "dist/manifest.js",
      "dist/view/schema.js",
      "dist/view/commands.js",
      "dist/view/invariants.js",
      "dist/presentation/activity-operations-workspace.js",
      "dist/presentation/activity-operations.module.css",
    ];
    for (const file of files) {
      expect(existsSync(resolve(pluginRoot, file)), file).toBe(true);
    }
    const compiledSources = files.filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(resolve(pluginRoot, file), "utf8"))
      .join("\n");
    expect(compiledSources).not.toContain("@/");
    expect(compiledSources).not.toContain("@/view-runtime");
  });
});
