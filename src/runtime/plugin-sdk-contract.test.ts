import { describe, expect, it } from "vitest";

import {
  PLUGIN_API_VERSION,
  pluginPackageDescriptorContract,
  isHostVersionCompatible,
  parsePluginPackageDescriptor,
} from "@sydaris/plugin-sdk";
import sdkPackage from "../../packages/plugin-sdk/package.json";

const descriptor = {
  schemaVersion: 1,
  id: "sydaris.example",
  version: "0.1.0-alpha.1",
  engines: { sydaris: ">=0.1.0-alpha.1 <0.2.0-0" },
  server: { entry: "./dist/server.js", export: "examplePlugin" },
  contributes: {
    views: ["example_view"],
    presentations: [],
    skills: [],
    toolCapabilities: [],
    tools: [],
  },
} as const;

describe("published Plugin SDK contract", () => {
  it("owns the package descriptor schema used by Sydaris", () => {
    expect(PLUGIN_API_VERSION).toBe("0.1.0-alpha.8");
    expect(sdkPackage).toMatchObject({
      name: "@sydaris/plugin-sdk",
      version: PLUGIN_API_VERSION,
      license: "Apache-2.0",
      publishConfig: { access: "public", tag: "next" },
    });
    expect(parsePluginPackageDescriptor(descriptor)).toMatchObject(descriptor);
    expect(pluginPackageDescriptorContract.jsonSchema).toMatchObject({ type: "object" });
  });

  it("uses SemVer ranges for Sydaris compatibility", () => {
    expect(isHostVersionCompatible("0.1.0", descriptor.engines.sydaris)).toBe(true);
    expect(isHostVersionCompatible("0.1.0-alpha.3", descriptor.engines.sydaris)).toBe(true);
    expect(isHostVersionCompatible("0.2.0-alpha.1", descriptor.engines.sydaris)).toBe(false);
    expect(isHostVersionCompatible("0.2.0", descriptor.engines.sydaris)).toBe(false);
    expect(() => parsePluginPackageDescriptor({
      ...descriptor,
      engines: { sydaris: "not-a-range" },
    })).toThrow();
  });
});
