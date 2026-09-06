#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseTag = "next";
const repositoryUrl = "git+https://github.com/USTC-Student-TableTennisAssociation/association-management.git";

const releasePackages = [
  {
    name: "@sydaris/plugin-sdk",
    directory: "packages/plugin-sdk",
  },
  {
    name: "@sydaris/society-information-plugin",
    directory: "src/plugins/society-information",
    descriptor: "sydaris.plugin.json",
  },
  {
    name: "@sydaris/activity-operations-plugin",
    directory: "src/plugins/activity-operations",
    descriptor: "sydaris.plugin.json",
  },
  {
    name: "@sydaris/competition-records-plugin",
    directory: "src/plugins/competition-records",
    descriptor: "sydaris.plugin.json",
  },
];

function packageDirectory(releasePackage) {
  return path.join(projectRoot, releasePackage.directory);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function requireFile(file, label) {
  try {
    await access(file);
  } catch {
    throw new Error(`${label} 不存在：${path.relative(projectRoot, file)}`);
  }
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `${command} 被信号 ${signal} 终止`
          : `${command} 退出，状态码 ${code}`,
      ));
    });
  });
}

async function capture(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: process.env,
      encoding: "utf8",
    });
  } catch (error) {
    if (options.allowNotFound && /(?:E404|is not in this registry|Not Found)/u.test(
      `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    )) {
      return undefined;
    }
    throw error;
  }
}

async function validatePackage(releasePackage) {
  const directory = packageDirectory(releasePackage);
  const packageJson = await readJson(path.join(directory, "package.json"));

  if (packageJson.name !== releasePackage.name) {
    throw new Error(`${releasePackage.directory}/package.json 的 name 不正确`);
  }
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error(`${releasePackage.name} 缺少 version`);
  }
  if (packageJson.private === true) {
    throw new Error(`${releasePackage.name} 被标记为 private`);
  }
  if (packageJson.license !== "Apache-2.0") {
    throw new Error(`${releasePackage.name} 必须声明 Apache-2.0 license`);
  }
  if (packageJson.publishConfig?.access !== "public" || packageJson.publishConfig?.tag !== releaseTag) {
    throw new Error(`${releasePackage.name} 必须以 public/${releaseTag} 发布`);
  }
  if (packageJson.repository?.url !== repositoryUrl) {
    throw new Error(`${releasePackage.name} 缺少正确的 repository.url`);
  }

  await requireFile(path.join(directory, "LICENSE"), `${releasePackage.name} LICENSE`);
  await requireFile(path.join(directory, "README.md"), `${releasePackage.name} README`);

  if (releasePackage.descriptor) {
    const descriptor = await readJson(path.join(directory, releasePackage.descriptor));
    if (descriptor.version !== packageJson.version) {
      throw new Error(
        `${releasePackage.name} 的 package.json 与 sydaris.plugin.json 版本不一致`,
      );
    }
  }

  return { ...releasePackage, version: packageJson.version };
}

async function ensureAuthenticated() {
  const result = await capture("npm", ["whoami"]);
  const username = result.stdout.trim();
  if (!username) throw new Error("npm whoami 没有返回用户名");
  process.stdout.write(`npm 当前用户：${username}\n`);
}

async function ensureCleanWorktree() {
  const result = await capture("git", ["status", "--porcelain"]);
  if (result.stdout.trim()) {
    throw new Error("工作区不是干净状态；请先提交本次发布快照，再执行正式发布");
  }
}

async function ensureVersionsAreAvailable(packages) {
  for (const releasePackage of packages) {
    const specifier = `${releasePackage.name}@${releasePackage.version}`;
    const result = await capture(
      "npm",
      ["view", specifier, "version", "--json"],
      { allowNotFound: true },
    );
    if (result) throw new Error(`${specifier} 已经存在于 npm，不能重复发布`);
    process.stdout.write(`npm 版本可用：${specifier}\n`);
  }
}

async function preflight() {
  const packages = [];
  for (const releasePackage of releasePackages) {
    packages.push(await validatePackage(releasePackage));
  }

  await run("pnpm", ["test"]);
  for (const releasePackage of packages) {
    await run(
      "npm",
      ["pack", "--dry-run", "--ignore-scripts"],
      { cwd: packageDirectory(releasePackage) },
    );
  }
  await ensureVersionsAreAvailable(packages);
  return packages;
}

async function main() {
  const mode = process.argv[2] ?? "check";
  if (mode !== "check" && mode !== "publish") {
    throw new Error("用法：node scripts/release-plugins.mjs <check|publish>");
  }

  if (mode === "publish") {
    await ensureAuthenticated();
    await ensureCleanWorktree();
  }

  const packages = await preflight();
  if (mode === "check") {
    process.stdout.write("四个 next 发布包已通过预检；没有执行发布。\n");
    return;
  }

  await ensureCleanWorktree();
  for (const releasePackage of packages) {
    process.stdout.write(`正在发布 ${releasePackage.name}@${releasePackage.version}...\n`);
    await run(
      "pnpm",
      ["publish", "--access", "public", "--tag", releaseTag],
      { cwd: packageDirectory(releasePackage) },
    );
  }
  process.stdout.write("四个包已全部发布到 next。\n");
}

main().catch((error) => {
  process.stderr.write(`发布流程失败：${error.message}\n`);
  process.exitCode = 1;
});
