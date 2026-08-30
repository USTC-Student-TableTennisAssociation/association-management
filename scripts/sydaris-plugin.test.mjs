import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PluginCliError,
  generatePluginRegistries,
  installPackagePlugin,
  installPlugin,
  parsePluginPackageDescriptor,
  purgeViewData,
  readPluginConfig,
  removePlugin,
} from "./sydaris-plugin.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function fixtureProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sydaris-plugin-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "plugins", "test", "presentation"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    '{"name":"fixture","version":"0.1.0","type":"module"}\n',
  );
  await writeFile(
    path.join(root, "sydaris.plugins.json"),
    '{"schemaVersion":1,"plugins":[]}\n',
  );
  await writeFile(
    path.join(root, "plugins", "test", "server.ts"),
    "export const testPlugin = { id: 'sydaris.test', version: '1.0.0', contributes: {} };\n",
  );
  await writeFile(
    path.join(root, "plugins", "test", "presentation", "workspace.tsx"),
    "export function TestWorkspace() { return null; }\n",
  );
  await writeFile(
    path.join(root, "plugins", "test", "sydaris.plugin.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "sydaris.test",
      version: "1.0.0",
      engines: { sydaris: ">=0.1.0-alpha.1 <0.2.0-0" },
      server: { entry: "./server.ts", export: "testPlugin" },
      contributes: {
        views: ["test_view"],
        presentations: [{
          loader: "sydaris.test/workspace",
          entry: "./presentation/workspace.tsx",
          export: "TestWorkspace",
        }],
        skills: ["sydaris.test.skill"],
        tools: ["sydaris.test.provider"],
      },
    }, null, 2)}\n`,
  );
  return root;
}

describe("Sydaris local plugin CLI", () => {
  it("validates the package descriptor contract", () => {
    expect(() => parsePluginPackageDescriptor({ schemaVersion: 1 })).toThrow(PluginCliError);
    expect(() => parsePluginPackageDescriptor({
      schemaVersion: 1,
      id: "Sydaris Bad",
      version: "latest",
      engines: { sydaris: ">=0.1.0-alpha.1 <0.2.0-0" },
      server: { entry: "./server.ts", export: "testPlugin" },
      contributes: {},
    })).toThrow(/id|标识/u);
  });

  it("rejects a Plugin that is incompatible with the current Sydaris version", async () => {
    const root = await fixtureProject();
    const descriptorPath = path.join(root, "plugins", "test", "sydaris.plugin.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.engines.sydaris = ">=0.2.0 <0.3.0";
    await writeFile(descriptorPath, JSON.stringify(descriptor));

    await expect(installPlugin(root, "plugins/test")).rejects.toThrow(
      /requires Sydaris|\u9700\u8981 Sydaris/u,
    );
  });

  it("installs a local plugin and generates server and client registries", async () => {
    const root = await fixtureProject();
    const result = await installPlugin(root, "plugins/test");
    expect(result).toMatchObject({ id: "sydaris.test", version: "1.0.0", alreadyInstalled: false });
    expect(await readPluginConfig(root)).toEqual({
      schemaVersion: 1,
      plugins: [{
        source: "local",
        manifest: "plugins/test/sydaris.plugin.json",
      }],
    });

    const serverRegistry = await readFile(
      path.join(root, "src/generated/installed-plugins.ts"),
      "utf8",
    );
    const presentationRegistry = await readFile(
      path.join(root, "src/generated/installed-presentations.tsx"),
      "utf8",
    );
    expect(serverRegistry).toContain('from "../../plugins/test/server"');
    expect(serverRegistry).toContain("installedPlugin0");
    expect(presentationRegistry).toContain('"sydaris.test/workspace": installedPresentation0');
    await expect(generatePluginRegistries(root, { check: true })).resolves.toHaveLength(1);
  });

  it("purges plugin data before unregistering it", async () => {
    const root = await fixtureProject();
    await installPlugin(root, "plugins/test");
    const purgeData = vi.fn(async () => ({ statements: 9, deletedRows: 12 }));
    const result = await removePlugin(root, "sydaris.test", { purge: true, purgeData });

    expect(purgeData).toHaveBeenCalledWith(["test_view"]);
    expect(result.purgeResult.deletedRows).toBe(12);
    expect(await readPluginConfig(root)).toEqual({ schemaVersion: 1, plugins: [] });
    const serverRegistry = await readFile(
      path.join(root, "src/generated/installed-plugins.ts"),
      "utf8",
    );
    expect(serverRegistry).not.toContain("testPlugin");
  });

  it("refuses destructive removal without --purge", async () => {
    const root = await fixtureProject();
    await installPlugin(root, "plugins/test");
    await expect(removePlugin(root, "sydaris.test")).rejects.toThrow(/--purge/u);
    expect((await readPluginConfig(root)).plugins).toHaveLength(1);
  });

  it("keeps a Plugin installed when database purge fails", async () => {
    const root = await fixtureProject();
    await installPlugin(root, "plugins/test");
    await expect(removePlugin(root, "sydaris.test", {
      purge: true,
      purgeData: async () => {
        throw new Error("database unavailable");
      },
    })).rejects.toThrow("database unavailable");
    expect((await readPluginConfig(root)).plugins).toEqual([
      {
        source: "local",
        manifest: "plugins/test/sydaris.plugin.json",
      },
    ]);
    await expect(generatePluginRegistries(root, { check: true })).resolves.toHaveLength(1);
  });

  it.each([
    "@sydaris/online-plugin@1.2.3",
    "./sydaris-online-plugin-1.2.3.tgz",
  ])("installs and removes an npm-distributed Plugin from %s", async (specifier) => {
    const root = await fixtureProject();
    const packageDirectory = path.join(root, "node_modules", "@sydaris", "online-plugin");
    await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
    await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({
      name: "@sydaris/online-plugin",
      version: "1.2.3",
      sydarisPlugin: "./sydaris.plugin.json",
    }));
    await writeFile(path.join(packageDirectory, "dist", "server.js"), "export const onlinePlugin = {};\n");
    await writeFile(path.join(packageDirectory, "dist", "presentation.js"), "export function OnlineWorkspace() {}\n");
    await writeFile(path.join(packageDirectory, "sydaris.plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "sydaris.online",
      version: "1.2.3",
      engines: { sydaris: ">=0.1.0-alpha.1 <0.2.0-0" },
      server: { entry: "./dist/server.js", export: "onlinePlugin" },
      contributes: {
        views: ["online_view"],
        presentations: [{
          loader: "sydaris.online/workspace",
          entry: "./dist/presentation.js",
          export: "OnlineWorkspace",
        }],
        skills: [],
        tools: [],
      },
    }));
    const packageManager = vi.fn(async (args) => {
      if (args[0] !== "add") return;
      const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      packageJson.devDependencies = {
        ...(packageJson.devDependencies ?? {}),
        "@sydaris/online-plugin": specifier,
      };
      await writeFile(path.join(root, "package.json"), JSON.stringify(packageJson));
    });

    const installed = await installPackagePlugin(root, specifier, { packageManager });
    expect(packageManager).toHaveBeenCalledWith([
      "add",
      "--workspace-root",
      "--save-dev",
      "--ignore-scripts",
      ...(specifier.endsWith(".tgz") ? ["--offline"] : []),
      specifier,
    ]);
    expect(installed).toMatchObject({
      id: "sydaris.online",
      package: "@sydaris/online-plugin",
      alreadyInstalled: false,
    });
    expect(await readPluginConfig(root)).toEqual({
      schemaVersion: 1,
      plugins: [{
        source: "npm",
        package: "@sydaris/online-plugin",
        manifest: "node_modules/@sydaris/online-plugin/sydaris.plugin.json",
      }],
    });
    const generated = await readFile(path.join(root, "src/generated/installed-plugins.ts"), "utf8");
    expect(generated).toContain('../../node_modules/@sydaris/online-plugin/dist/server');

    await expect(removePlugin(root, "sydaris.online", {
      purge: true,
      purgeData: async () => ({ statements: 8, deletedRows: 0 }),
      removePackage: async () => {
        throw new Error("package manager unavailable");
      },
    })).rejects.toThrow("package manager unavailable");
    expect((await readPluginConfig(root)).plugins).toHaveLength(1);

    const removePackage = vi.fn(async () => undefined);
    await removePlugin(root, "sydaris.online", {
      purge: true,
      purgeData: async () => ({ statements: 9, deletedRows: 0 }),
      removePackage,
    });
    expect(removePackage).toHaveBeenCalledWith("@sydaris/online-plugin");
    expect((await readPluginConfig(root)).plugins).toEqual([]);
  });
});

describe("plugin View data purge", () => {
  it("deletes all View-owned rows in one transaction", async () => {
    const query = vi.fn(async () => ({ rowCount: 1 }));
    const result = await purgeViewData({ query }, ["test_view"]);
    expect(result).toEqual({ statements: 8, deletedRows: 8 });
    expect(query.mock.calls[0]).toEqual(["BEGIN"]);
    expect(query.mock.calls.at(-1)).toEqual(["COMMIT"]);
    expect(query.mock.calls.slice(1, -1).every((call) =>
      call[1]?.[0]?.[0] === "test_view"
    )).toBe(true);
  });

  it("rolls back when any deletion fails", async () => {
    let call = 0;
    const query = vi.fn(async (statement) => {
      call += 1;
      if (call === 3) throw new Error("delete failed");
      return { rowCount: statement === "ROLLBACK" ? 0 : 1 };
    });
    await expect(purgeViewData({ query }, ["test_view"])).rejects.toThrow("delete failed");
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});
