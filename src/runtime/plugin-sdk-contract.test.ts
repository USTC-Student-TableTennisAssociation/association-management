import { describe, expect, it } from "vitest";

import {
  ECHO_PLUGIN_API_VERSION,
  echoPluginPackageDescriptorContract,
  isEchoVersionCompatible,
  parseEchoPluginPackageDescriptor,
} from "@sydaris/plugin-sdk";
import sdkPackage from "../../packages/plugin-sdk/package.json";

const descriptor = {
  schemaVersion: 1,
  id: "echo.example",
  version: "0.1.0-alpha.1",
  engines: { echo: ">=0.1.0-alpha.1 <0.2.0-0" },
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
  it("owns the package descriptor schema used by Echo", () => {
    expect(ECHO_PLUGIN_API_VERSION).toBe("0.1.0-alpha.6");
    expect(sdkPackage).toMatchObject({
      name: "@sydaris/plugin-sdk",
      version: ECHO_PLUGIN_API_VERSION,
      license: "Apache-2.0",
      publishConfig: { access: "public", tag: "next" },
    });
    expect(parseEchoPluginPackageDescriptor(descriptor)).toMatchObject(descriptor);
    expect(echoPluginPackageDescriptorContract.jsonSchema).toMatchObject({ type: "object" });
  });

  it("uses SemVer ranges for Echo compatibility", () => {
    expect(isEchoVersionCompatible("0.1.0", descriptor.engines.echo)).toBe(true);
    expect(isEchoVersionCompatible("0.1.0-alpha.3", descriptor.engines.echo)).toBe(true);
    expect(isEchoVersionCompatible("0.2.0-alpha.1", descriptor.engines.echo)).toBe(false);
    expect(isEchoVersionCompatible("0.2.0", descriptor.engines.echo)).toBe(false);
    expect(() => parseEchoPluginPackageDescriptor({
      ...descriptor,
      engines: { echo: "not-a-range" },
    })).toThrow();
  });
});
