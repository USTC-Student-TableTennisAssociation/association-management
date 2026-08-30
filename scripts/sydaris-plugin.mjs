#!/usr/bin/env node

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  isHostVersionCompatible,
  parsePluginPackageDescriptor as parseDescriptorContract,
} from "@sydaris/plugin-sdk";

const CONFIG_FILE = "sydaris.plugins.json";
const SERVER_REGISTRY_FILE = "src/generated/installed-plugins.ts";
const PRESENTATION_REGISTRY_FILE = "src/generated/installed-presentations.tsx";
const descriptorName = "sydaris.plugin.json";

export class PluginCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "PluginCliError";
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginCliError(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

function parseInstalledPlugin(value, index) {
  const label = `${CONFIG_FILE}.plugins[${index}]`;
  if (typeof value === "string") {
    return { source: "local", manifest: requireString(value, label) };
  }
  if (!isRecord(value) || (value.source !== "local" && value.source !== "npm")) {
    throw new PluginCliError(`${label} 必须声明 source: local 或 source: npm`);
  }
  const manifest = requireString(value.manifest, `${label}.manifest`);
  if (value.source === "local") return { source: "local", manifest };
  return {
    source: "npm",
    package: requireString(value.package, `${label}.package`),
    manifest,
  };
}

export function parsePluginPackageDescriptor(value, source = descriptorName) {
  try {
    return parseDescriptorContract(value);
  } catch (error) {
    const issue = Array.isArray(error?.issues) ? error.issues[0] : undefined;
    const issuePath = issue?.path?.reduce((result, segment) =>
      typeof segment === "number"
        ? `${result}[${segment}]`
        : `${result}${result ? "." : ""}${String(segment)}`, "");
    const location = issuePath ? `${source}.${issuePath}` : source;
    throw new PluginCliError(`${location} 格式无效：${issue?.message ?? String(error)}`);
  }
}

async function readHostVersion(projectRoot) {
  const packageJson = await readJson(path.join(projectRoot, "package.json"), "package.json");
  return requireString(packageJson.version, "package.json.version");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  for (;;) {
    if (await exists(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new PluginCliError("找不到 Sydaris 项目根目录（缺少 package.json）");
    }
    current = parent;
  }
}

function projectRelative(projectRoot, absolutePath, label) {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PluginCliError(`${label} 必须位于 Sydaris 项目目录内：${absolutePath}`);
  }
  return relative.split(path.sep).join("/");
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new PluginCliError(`${label} 不是合法 JSON：${error.message}`);
    }
    throw error;
  }
}

export async function resolveDescriptor(projectRoot, input) {
  const candidate = path.resolve(projectRoot, input);
  const descriptorPath = path.extname(candidate) === ".json"
    ? candidate
    : path.join(candidate, descriptorName);
  if (!await exists(descriptorPath)) {
    throw new PluginCliError(`找不到插件描述文件：${descriptorPath}`);
  }
  const relativePath = projectRelative(projectRoot, descriptorPath, "插件描述文件");
  const descriptor = parsePluginPackageDescriptor(
    await readJson(descriptorPath, relativePath),
    relativePath,
  );
  const hostVersion = await readHostVersion(projectRoot);
  if (!isHostVersionCompatible(hostVersion, descriptor.engines.sydaris)) {
    throw new PluginCliError(
      `${descriptor.id}@${descriptor.version} 需要 Sydaris ${descriptor.engines.sydaris}，当前为 ${hostVersion}`,
    );
  }
  const descriptorDirectory = path.dirname(descriptorPath);
  const entries = [
    [descriptor.server.entry, "server.entry"],
    ...descriptor.contributes.presentations.map((presentation, index) => [
      presentation.entry,
      `contributes.presentations[${index}].entry`,
    ]),
  ];
  for (const [entry, label] of entries) {
    const entryPath = path.resolve(descriptorDirectory, entry);
    projectRelative(projectRoot, entryPath, label);
    if (!await exists(entryPath)) {
      throw new PluginCliError(`${relativePath} 引用的 ${label} 不存在：${entry}`);
    }
  }
  return { descriptor, descriptorPath, relativePath };
}

export async function readPluginConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_FILE);
  if (!await exists(configPath)) return { schemaVersion: 1, plugins: [] };
  const value = await readJson(configPath, CONFIG_FILE);
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new PluginCliError(`${CONFIG_FILE} 必须使用 schemaVersion: 1`);
  }
  return {
    schemaVersion: 1,
    plugins: Array.isArray(value.plugins)
      ? value.plugins.map(parseInstalledPlugin)
      : (() => { throw new PluginCliError(`${CONFIG_FILE}.plugins 必须是数组`); })(),
  };
}

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

async function writePluginConfig(projectRoot, config) {
  const content = `${JSON.stringify(config, null, 2)}\n`;
  await writeAtomic(path.join(projectRoot, CONFIG_FILE), content);
}

function withoutModuleExtension(value) {
  return value.replace(/\.(?:[cm]?[jt]sx?)$/u, "");
}

function importSpecifier(projectRoot, entryPath, generatedFile) {
  const sourceRoot = path.join(projectRoot, "src");
  const sourceRelative = path.relative(sourceRoot, entryPath);
  if (!sourceRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(sourceRelative)) {
    return `@/${withoutModuleExtension(sourceRelative.split(path.sep).join("/"))}`;
  }
  let relative = path.relative(path.dirname(generatedFile), entryPath).split(path.sep).join("/");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return withoutModuleExtension(relative);
}

async function installedDescriptors(projectRoot, config) {
  const installed = [];
  for (const installation of config.plugins) {
    installed.push({
      ...await resolveDescriptor(projectRoot, installation.manifest),
      installation,
    });
  }
  const duplicate = (values, label) => {
    const seen = new Set();
    for (const value of values) {
      if (seen.has(value)) throw new PluginCliError(`已安装插件存在重复的 ${label}：${value}`);
      seen.add(value);
    }
  };
  duplicate(installed.map(({ descriptor }) => descriptor.id), "Plugin id");
  duplicate(installed.flatMap(({ descriptor }) => descriptor.contributes.views), "View key");
  duplicate(
    installed.flatMap(({ descriptor }) =>
      descriptor.contributes.presentations.map((presentation) => presentation.loader)
    ),
    "Presentation loader",
  );
  return installed;
}

function generatedServerRegistry(projectRoot, installed) {
  const outputFile = path.join(projectRoot, SERVER_REGISTRY_FILE);
  const imports = installed.map(({ descriptor, descriptorPath }, index) => {
    const entry = path.resolve(path.dirname(descriptorPath), descriptor.server.entry);
    return `import { ${descriptor.server.export} as installedPlugin${index} } from ${JSON.stringify(
      importSpecifier(projectRoot, entry, outputFile),
    )};`;
  });
  const values = installed.map((_, index) => `  installedPlugin${index},`);
  return [
    "/* This file is generated by `pnpm sydaris:plugin generate`. Do not edit manually. */",
    'import type { PluginManifest } from "@/contracts";',
    ...imports,
    "",
    "export const installedPluginManifests: readonly PluginManifest[] = [",
    ...values,
    "];",
    "",
  ].join("\n");
}

function generatedPresentationRegistry(projectRoot, installed) {
  const outputFile = path.join(projectRoot, PRESENTATION_REGISTRY_FILE);
  const presentations = installed.flatMap(({ descriptor, descriptorPath }) =>
    descriptor.contributes.presentations.map((presentation) => ({
      ...presentation,
      descriptorPath,
    }))
  );
  const imports = presentations.map((presentation, index) => {
    const entry = path.resolve(path.dirname(presentation.descriptorPath), presentation.entry);
    return `import { ${presentation.export} as installedPresentation${index} } from ${JSON.stringify(
      importSpecifier(projectRoot, entry, outputFile),
    )};`;
  });
  const values = presentations.map((presentation, index) =>
    `  ${JSON.stringify(presentation.loader)}: installedPresentation${index},`
  );
  return [
    "/* This file is generated by `pnpm sydaris:plugin generate`. Do not edit manually. */",
    '"use client";',
    "",
    'import type { ComponentType } from "react";',
    'import type { PresentationProps } from "@sydaris/plugin-sdk";',
    ...imports,
    "",
    "export const installedPresentationComponents: Readonly<",
    "  Record<string, ComponentType<PresentationProps>>",
    "> = {",
    ...values,
    "};",
    "",
  ].join("\n");
}

export async function generatePluginRegistries(projectRoot, options = {}) {
  const config = await readPluginConfig(projectRoot);
  const installed = await installedDescriptors(projectRoot, config);
  const outputs = [
    [SERVER_REGISTRY_FILE, generatedServerRegistry(projectRoot, installed)],
    [PRESENTATION_REGISTRY_FILE, generatedPresentationRegistry(projectRoot, installed)],
  ];
  for (const [relativePath, content] of outputs) {
    const file = path.join(projectRoot, relativePath);
    if (options.check) {
      const current = await exists(file) ? await readFile(file, "utf8") : "";
      if (current !== content) {
        throw new PluginCliError(`${relativePath} 不是最新生成结果，请运行 pnpm sydaris:plugin generate`);
      }
    } else {
      await writeAtomic(file, content);
    }
  }
  return installed.map(({ descriptor, relativePath, installation }) => ({
    id: descriptor.id,
    version: descriptor.version,
    manifest: relativePath,
    source: installation.source,
  }));
}

export async function installPlugin(projectRoot, input, options = {}) {
  const candidate = await resolveDescriptor(projectRoot, input);
  const config = await readPluginConfig(projectRoot);
  const installed = await installedDescriptors(projectRoot, config);
  const sameId = installed.find(({ descriptor }) => descriptor.id === candidate.descriptor.id);
  if (sameId) {
    if (sameId.relativePath === candidate.relativePath) {
      await generatePluginRegistries(projectRoot);
      return { ...candidate.descriptor, alreadyInstalled: true };
    }
    throw new PluginCliError(
      `Plugin ${candidate.descriptor.id} 已从 ${sameId.relativePath} 安装；第一版不支持升级或替换`,
    );
  }
  const occupiedViews = new Set(installed.flatMap(({ descriptor }) => descriptor.contributes.views));
  const duplicateView = candidate.descriptor.contributes.views.find((viewKey) => occupiedViews.has(viewKey));
  if (duplicateView) {
    throw new PluginCliError(`View ${duplicateView} 已由其他 Plugin 安装`);
  }
  await writePluginConfig(projectRoot, {
    schemaVersion: 1,
    plugins: [...config.plugins, options.installation ?? {
      source: "local",
      manifest: candidate.relativePath,
    }].sort((left, right) => left.manifest.localeCompare(right.manifest)),
  });
  await generatePluginRegistries(projectRoot);
  return { ...candidate.descriptor, alreadyInstalled: false };
}

function dependencyMap(packageJson) {
  return {
    ...(isRecord(packageJson.dependencies) ? packageJson.dependencies : {}),
    ...(isRecord(packageJson.devDependencies) ? packageJson.devDependencies : {}),
  };
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("@")) {
    const separator = specifier.lastIndexOf("@");
    return separator > specifier.indexOf("/") ? specifier.slice(0, separator) : specifier;
  }
  if (/^[a-z0-9][a-z0-9._-]*(?:@[^/]+)?$/iu.test(specifier)) {
    return specifier.split("@")[0];
  }
  return undefined;
}

export async function runPnpm(projectRoot, args) {
  let commandArgs = args;
  try {
    const modules = await readJson(
      path.join(projectRoot, "node_modules", ".modules.yaml"),
      "node_modules/.modules.yaml",
    );
    if (typeof modules.storeDir === "string" && modules.storeDir.trim()) {
      commandArgs = ["--store-dir", modules.storeDir, ...args];
    }
  } catch {
    // A fresh checkout has no node_modules metadata yet; pnpm can use its normal default.
  }
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", commandArgs, {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new PluginCliError(
        `pnpm ${args.join(" ")} 失败${signal ? `（signal ${signal}）` : `（exit ${code}）`}`,
      ));
    });
  });
}

async function installedPackageDescriptor(projectRoot, packageName) {
  const packageDirectory = path.join(projectRoot, "node_modules", ...packageName.split("/"));
  const packageJsonPath = path.join(packageDirectory, "package.json");
  if (!await exists(packageJsonPath)) {
    throw new PluginCliError(`pnpm 已完成，但找不到 ${packageName}/package.json`);
  }
  const packageJson = await readJson(packageJsonPath, `${packageName}/package.json`);
  const declaredName = requireString(packageJson.name, `${packageName}/package.json.name`);
  if (declaredName !== packageName) {
    throw new PluginCliError(`安装包名称不一致：期望 ${packageName}，实际 ${declaredName}`);
  }
  const descriptor = typeof packageJson.sydarisPlugin === "string"
    ? packageJson.sydarisPlugin
    : `./${descriptorName}`;
  const descriptorPath = path.resolve(packageDirectory, descriptor);
  return resolveDescriptor(projectRoot, descriptorPath);
}

export async function installPackagePlugin(projectRoot, specifier, options = {}) {
  const packageManager = options.packageManager ?? ((args) => runPnpm(projectRoot, args));
  const beforePackageJson = await readJson(path.join(projectRoot, "package.json"), "package.json");
  const beforeDependencies = dependencyMap(beforePackageJson);
  const hintedPackageName = packageNameFromSpecifier(specifier);
  const config = await readPluginConfig(projectRoot);
  const existingPackage = hintedPackageName
    ? config.plugins.find((plugin) => plugin.source === "npm" && plugin.package === hintedPackageName)
    : undefined;
  if (existingPackage) {
    const result = await installPlugin(projectRoot, existingPackage.manifest, {
      installation: existingPackage,
    });
    return { ...result, package: hintedPackageName };
  }

  const packageManagerArgs = ["add", "--workspace-root", "--save-dev", "--ignore-scripts"];
  if (!specifier.includes("://") && specifier.toLowerCase().endsWith(".tgz")) {
    packageManagerArgs.push("--offline");
  }
  await packageManager([...packageManagerArgs, specifier]);
  let packageName = hintedPackageName;
  try {
    const afterPackageJson = await readJson(path.join(projectRoot, "package.json"), "package.json");
    const afterDependencies = dependencyMap(afterPackageJson);
    if (!packageName) {
      const changed = Object.keys(afterDependencies).filter((name) =>
        beforeDependencies[name] !== afterDependencies[name]
      );
      if (changed.length !== 1) {
        throw new PluginCliError(
          `无法从 ${specifier} 唯一确定安装包名称；依赖变化：${changed.join("、") || "无"}`,
        );
      }
      [packageName] = changed;
    }
    const installed = await installedPackageDescriptor(projectRoot, packageName);
    const result = await installPlugin(projectRoot, installed.descriptorPath, {
      installation: {
        source: "npm",
        package: packageName,
        manifest: installed.relativePath,
      },
    });
    return { ...result, package: packageName };
  } catch (error) {
    if (packageName && beforeDependencies[packageName] === undefined) {
      await packageManager(["--config.offline=true", "remove", "--workspace-root", packageName])
        .catch(() => undefined);
    }
    throw error;
  }
}

export async function purgeViewData(client, viewKeys) {
  if (!viewKeys.length) return { statements: 0, deletedRows: 0 };
  const statements = [
    `DELETE FROM "view_slot_bindings"
      WHERE "source_card_id" IN (SELECT "id" FROM "view_cards" WHERE "view_key" = ANY($1::text[]))
         OR "target_card_id" IN (SELECT "id" FROM "view_cards" WHERE "view_key" = ANY($1::text[]))`,
    `DELETE FROM "view_dimension_values"
      WHERE "card_id" IN (SELECT "id" FROM "view_cards" WHERE "view_key" = ANY($1::text[]))`,
    `DELETE FROM "view_card_related_objects"
      WHERE "card_id" IN (SELECT "id" FROM "view_cards" WHERE "view_key" = ANY($1::text[]))`,
    `DELETE FROM "view_cards" WHERE "view_key" = ANY($1::text[])`,
    `DELETE FROM "view_command_proposals" WHERE "view_key" = ANY($1::text[])`,
    `DELETE FROM "view_command_executions" WHERE "view_key" = ANY($1::text[])`,
    `DELETE FROM "view_higher_memories" WHERE "view_key" = ANY($1::text[])`,
    `DELETE FROM "installed_views" WHERE "view_key" = ANY($1::text[])`,
  ];
  let deletedRows = 0;
  await client.query("BEGIN");
  try {
    for (const statement of statements) {
      const result = await client.query(statement, [viewKeys]);
      deletedRows += result.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return { statements: statements.length, deletedRows };
}

export async function purgeInstalledPluginData(viewKeys, options = {}) {
  if (!viewKeys.length) return { statements: 0, deletedRows: 0 };
  await import("dotenv/config");
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new PluginCliError("--purge 需要配置 DATABASE_URL 才能清理 View 数据");
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    return await purgeViewData(client, viewKeys);
  } finally {
    client.release();
    await pool.end();
  }
}

export async function removePlugin(projectRoot, pluginId, options = {}) {
  if (!options.purge) {
    throw new PluginCliError("删除 Plugin 必须显式传入 --purge；该操作会永久删除插件的全部 View 数据");
  }
  const config = await readPluginConfig(projectRoot);
  const installed = await installedDescriptors(projectRoot, config);
  const target = installed.find(({ descriptor }) => descriptor.id === pluginId);
  if (!target) throw new PluginCliError(`Plugin 未安装：${pluginId}`);
  const purge = options.purgeData ?? purgeInstalledPluginData;
  const purgeResult = await purge(target.descriptor.contributes.views);
  if (target.installation.source === "npm") {
    const removePackage = options.removePackage ?? ((packageName) =>
      runPnpm(projectRoot, ["--config.offline=true", "remove", "--workspace-root", packageName])
    );
    await removePackage(target.installation.package);
  }
  await writePluginConfig(projectRoot, {
    schemaVersion: 1,
    plugins: config.plugins.filter((plugin) => plugin.manifest !== target.relativePath),
  });
  await generatePluginRegistries(projectRoot);
  return {
    id: target.descriptor.id,
    views: target.descriptor.contributes.views,
    purgeResult,
    package: target.installation.source === "npm" ? target.installation.package : undefined,
  };
}

function usage() {
  return [
    "Sydaris 本地插件管理",
    "",
    "用法：",
    "  pnpm sydaris:plugin list",
    "  pnpm sydaris:plugin install <本地插件目录、tgz 或 npm-package@version>",
    "  pnpm sydaris:plugin remove <plugin-id> --purge",
    "  pnpm sydaris:plugin generate [--check]",
  ].join("\n");
}

async function main(argv) {
  const [command, ...args] = argv;
  const projectRoot = await findProjectRoot();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "generate") {
    const plugins = await generatePluginRegistries(projectRoot, { check: args.includes("--check") });
    console.log(`Plugin Registry 已${args.includes("--check") ? "校验" : "生成"}：${plugins.length} 个 Plugin`);
    return;
  }
  if (command === "list") {
    const plugins = await generatePluginRegistries(projectRoot, { check: true });
    if (!plugins.length) {
      console.log("未安装 Plugin");
      return;
    }
    plugins.forEach((plugin) => console.log(`${plugin.id}@${plugin.version}\t${plugin.manifest}`));
    return;
  }
  if (command === "install") {
    if (args.length !== 1) throw new PluginCliError("install 需要一个本地插件目录、tgz 或 npm package");
    const input = args[0];
    const localPath = path.resolve(projectRoot, input);
    const isDescriptorSource = !input.endsWith(".tgz") && await exists(localPath);
    const result = isDescriptorSource
      ? await installPlugin(projectRoot, input)
      : await installPackagePlugin(projectRoot, input);
    console.log(
      result.alreadyInstalled
        ? `Plugin 已安装并已重新生成 Registry：${result.id}@${result.version}`
        : `Plugin 安装完成：${result.id}@${result.version}；重新启动 Sydaris 后生效`,
    );
    return;
  }
  if (command === "remove" || command === "uninstall") {
    const pluginId = args.find((value) => !value.startsWith("-"));
    if (!pluginId) throw new PluginCliError("remove 需要 plugin-id");
    const result = await removePlugin(projectRoot, pluginId, { purge: args.includes("--purge") });
    console.log(
      `Plugin 已删除：${result.id}；清理 ${result.views.length} 个 View，删除 ${result.purgeResult.deletedRows} 行数据`,
    );
    return;
  }
  throw new PluginCliError(`未知命令：${command}\n\n${usage()}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
