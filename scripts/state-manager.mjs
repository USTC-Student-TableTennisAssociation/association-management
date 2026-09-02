#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse as parseDotenv } from "dotenv";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const FORMAT_VERSION = 1;
const STATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

class StateManagerError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "StateManagerError";
  }
}

function loadEnvironment(projectRoot) {
  const environmentPath = path.join(projectRoot, ".env");
  if (!existsSync(environmentPath)) {
    throw new StateManagerError(`缺少 ${environmentPath}`);
  }
  const parsed = parseDotenv(readFileSync(environmentPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function absoluteConfiguredPath(projectRoot, environmentKey, fallback) {
  const configured = process.env[environmentKey]?.trim();
  if (!configured) return path.join(projectRoot, fallback);
  if (!path.isAbsolute(configured)) {
    throw new StateManagerError(`${environmentKey} 必须是绝对路径`);
  }
  return path.normalize(configured);
}

function pathContains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateStorageSeparation(projectRoot, stateRoot, liveRoots) {
  const unsafeRoots = new Set([
    path.parse(stateRoot).root,
    path.resolve(homedir()),
  ]);
  for (const [label, managedRoot] of [
    ["状态仓库", stateRoot],
    ["资料库", liveRoots[0]],
    ["解析产物", liveRoots[1]],
  ]) {
    if (unsafeRoots.has(path.resolve(managedRoot))) {
      throw new StateManagerError(`${label}不能使用文件系统根目录或用户主目录：${managedRoot}`);
    }
  }
  if (pathContains(stateRoot, projectRoot)) {
    throw new StateManagerError(`状态仓库不能包含项目目录：${stateRoot}`);
  }
  if (
    pathContains(liveRoots[0], liveRoots[1]) ||
    pathContains(liveRoots[1], liveRoots[0])
  ) {
    throw new StateManagerError(
      `资料库与解析产物目录不能互相包含：${liveRoots[0]} / ${liveRoots[1]}`,
    );
  }
  for (const liveRoot of liveRoots) {
    if (pathContains(liveRoot, stateRoot) || pathContains(stateRoot, liveRoot)) {
      throw new StateManagerError(
        `状态仓库与运行目录不能互相包含：${stateRoot} / ${liveRoot}`,
      );
    }
  }
}

function validateStateName(stateName) {
  if (!STATE_NAME_PATTERN.test(stateName) || stateName === "." || stateName === "..") {
    throw new StateManagerError(
      "状态名称只能包含字母、数字、点、下划线和连字符，且长度不能超过 80。",
    );
  }
}

function formatTimestampForName(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

function sortNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function scanTree(root) {
  if (!existsSync(root)) return { present: false, entries: [], totalBytes: 0 };
  if (!lstatSync(root).isDirectory()) {
    throw new StateManagerError(`状态目录不是文件夹：${root}`);
  }

  const entries = [];
  let totalBytes = 0;

  async function walk(directory, relativeDirectory) {
    const names = readdirSync(directory).sort(sortNames);
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = relativeDirectory
        ? path.posix.join(relativeDirectory, name)
        : name;
      const info = lstatSync(absolute);
      const mode = info.mode & 0o777;
      if (info.isDirectory()) {
        entries.push({ path: relative, type: "directory", mode });
        await walk(absolute, relative);
      } else if (info.isFile()) {
        const sha256 = await sha256File(absolute);
        entries.push({ path: relative, type: "file", mode, size: info.size, sha256 });
        totalBytes += info.size;
      } else if (info.isSymbolicLink()) {
        entries.push({ path: relative, type: "symlink", target: readlinkSync(absolute) });
      } else {
        throw new StateManagerError(`不支持保存特殊文件：${absolute}`);
      }
    }
  }

  await walk(root, "");
  return { present: true, entries, totalBytes };
}

function copyTree(source, destination) {
  if (!existsSync(source)) return false;
  if (!lstatSync(source).isDirectory()) {
    throw new StateManagerError(`运行目录不是文件夹：${source}`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const clone = spawnSync("/bin/cp", ["-a", "-c", source, destination], {
    encoding: "utf8",
  });
  if (clone.status === 0) return true;

  rmSync(destination, { recursive: true, force: true });
  const fallback = spawnSync("/bin/cp", ["-a", source, destination], {
    encoding: "utf8",
  });
  if (fallback.status !== 0) {
    throw new StateManagerError(
      `无法复制状态目录 ${source}：${fallback.stderr || clone.stderr || "未知错误"}`,
    );
  }
  return true;
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: options.encoding ?? "utf8",
      env: process.env,
      stdio: options.stdio ?? "pipe",
    });
  } catch (error) {
    if (options.stdio !== "inherit") {
      const stderr = error?.stderr?.toString().trim();
      const stdout = error?.stdout?.toString().trim();
      const detail = stderr || stdout;
      if (detail) throw new StateManagerError(detail, { cause: error });
    }
    throw error;
  }
}

function databaseScript(projectRoot, name) {
  const script = path.join(projectRoot, "scripts", name);
  if (!existsSync(script)) throw new StateManagerError(`缺少数据库脚本：${script}`);
  return script;
}

function snapshotDatabase(projectRoot, destination) {
  run("zsh", [databaseScript(projectRoot, "database-snapshot.zsh"), destination], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

function restoreDatabase(projectRoot, source) {
  run("zsh", [databaseScript(projectRoot, "database-restore.zsh"), source, "--yes"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

function databaseQuery(projectRoot, sql) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new StateManagerError(".env 中未配置 DATABASE_URL");
  return run("psql", [
    databaseUrl.split("?", 1)[0],
    "--tuples-only",
    "--no-align",
    "--command",
    sql,
  ], { cwd: projectRoot }).trim();
}

function assertNoActiveCompilation(projectRoot, action, allowActive = false) {
  if (process.env.SYDARIS_STATE_SKIP_ACTIVE_CHECK === "true") return;
  const count = Number(databaseQuery(
    projectRoot,
    "SELECT count(*) FROM library_compilation_jobs WHERE status IN ('queued', 'running')",
  ));
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new StateManagerError("无法判断资料解析任务是否处于运行状态。");
  }
  if (count === 0) return;
  if (allowActive && action === "保存") {
    console.warn(`警告：当前有 ${count} 个 queued/running 解析任务；只保存已持久化状态。`);
    return;
  }
  throw new StateManagerError(
    `当前有 ${count} 个 queued/running 解析任务。请先暂停任务，再${action}状态。`,
  );
}

function gitMetadata(projectRoot) {
  try {
    const commit = run("git", ["rev-parse", "HEAD"], { cwd: projectRoot }).trim();
    const dirty = run("git", ["status", "--porcelain"], { cwd: projectRoot }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

function sameEntry(expected, actual) {
  if (expected.path !== actual.path || expected.type !== actual.type) return false;
  if (expected.type === "file") {
    return expected.mode === actual.mode &&
      expected.size === actual.size &&
      expected.sha256 === actual.sha256;
  }
  if (expected.type === "directory") return expected.mode === actual.mode;
  return expected.target === actual.target;
}

function assertTreeMatches(label, expected, actual) {
  if (expected.present !== actual.present) {
    throw new StateManagerError(`${label} 的存在状态与 manifest 不一致。`);
  }
  if (expected.entries.length !== actual.entries.length) {
    throw new StateManagerError(
      `${label} 文件数不一致：预期 ${expected.entries.length}，实际 ${actual.entries.length}。`,
    );
  }
  for (let index = 0; index < expected.entries.length; index += 1) {
    if (!sameEntry(expected.entries[index], actual.entries[index])) {
      throw new StateManagerError(
        `${label} 文件校验失败：${expected.entries[index]?.path ?? "未知文件"}`,
      );
    }
  }
}

function readManifest(stateDirectory) {
  const manifestPath = path.join(stateDirectory, "manifest.json");
  if (!existsSync(manifestPath)) throw new StateManagerError(`状态缺少 manifest：${stateDirectory}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new StateManagerError(`无法读取状态 manifest：${manifestPath}`, { cause: error });
  }
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new StateManagerError(
      `不支持的状态格式版本：${manifest.formatVersion ?? "未知"}`,
    );
  }
  return manifest;
}

async function verifyStateDirectory(stateDirectory, expectedName, { quiet = false } = {}) {
  const manifest = readManifest(stateDirectory);
  if (manifest.stateName !== expectedName) {
    throw new StateManagerError(
      `状态名称不一致：目录为 ${expectedName}，manifest 为 ${manifest.stateName}`,
    );
  }
  const databasePath = path.join(stateDirectory, "database.dump");
  if (!existsSync(databasePath)) throw new StateManagerError("状态缺少 database.dump");
  const databaseSha256 = await sha256File(databasePath);
  if (databaseSha256 !== manifest.database.sha256) {
    throw new StateManagerError("database.dump 的 SHA-256 校验失败。");
  }

  const library = await scanTree(path.join(stateDirectory, "files", "library"));
  const coldStart = await scanTree(path.join(stateDirectory, "files", "cold-start"));
  assertTreeMatches("资料库", manifest.files.library, library);
  assertTreeMatches("解析产物", manifest.files.coldStart, coldStart);
  if (!quiet) {
    console.log(`状态校验通过：${expectedName}`);
  }
  return manifest;
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
}

function commitStagingDirectory(staging, target, replace) {
  if (!existsSync(target)) {
    renameSync(staging, target);
    return;
  }
  if (!replace) throw new StateManagerError(`状态已经存在：${path.basename(target)}`);
  const previous = `${target}.replaced-${process.pid}-${randomBytes(3).toString("hex")}`;
  renameSync(target, previous);
  try {
    renameSync(staging, target);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(target) && existsSync(previous)) renameSync(previous, target);
    throw error;
  }
}

async function saveState(context, stateName, options = {}) {
  validateStateName(stateName);
  if (!options.skipActiveCheck) {
    assertNoActiveCompilation(context.projectRoot, "保存", options.allowActive === true);
  }
  const target = path.join(context.stateRoot, stateName);
  if (existsSync(target) && !options.replace) {
    throw new StateManagerError(`状态已经存在：${stateName}；如需替换请添加 --replace。`);
  }

  const staging = path.join(
    context.stateRoot,
    `.${stateName}.saving-${process.pid}-${randomBytes(3).toString("hex")}`,
  );
  mkdirSync(path.join(staging, "files"), { recursive: true, mode: 0o700 });
  try {
    console.log(`正在保存数据库：${stateName}`);
    snapshotDatabase(context.projectRoot, path.join(staging, "database.dump"));

    console.log("正在克隆资料库文件状态…");
    copyTree(context.libraryRoot, path.join(staging, "files", "library"));
    console.log("正在克隆解析产物状态…");
    copyTree(context.coldStartRoot, path.join(staging, "files", "cold-start"));

    console.log("正在生成文件校验清单…");
    const [library, coldStart, databaseSha256] = await Promise.all([
      scanTree(path.join(staging, "files", "library")),
      scanTree(path.join(staging, "files", "cold-start")),
      sha256File(path.join(staging, "database.dump")),
    ]);
    const databaseIdentity = process.env.SYDARIS_STATE_SKIP_ACTIVE_CHECK === "true"
      ? { name: null, serverVersion: null }
      : (() => {
          const [name, serverVersion] = databaseQuery(
            context.projectRoot,
            "SELECT current_database() || E'\\t' || current_setting('server_version_num')",
          ).split("\t");
          return { name: name || null, serverVersion: serverVersion || null };
        })();
    const manifest = {
      formatVersion: FORMAT_VERSION,
      stateName,
      createdAt: new Date().toISOString(),
      database: {
        file: "database.dump",
        sha256: databaseSha256,
        ...databaseIdentity,
      },
      files: {
        library: { source: context.libraryRoot, ...library },
        coldStart: { source: context.coldStartRoot, ...coldStart },
      },
      git: gitMetadata(context.projectRoot),
    };
    writeJsonAtomic(path.join(staging, "manifest.json"), manifest);
    await verifyStateDirectory(staging, stateName, { quiet: true });
    commitStagingDirectory(staging, target, options.replace === true);
    console.log(
      `状态已保存：${stateName}（资料库 ${humanBytes(library.totalBytes)}，` +
      `解析产物 ${humanBytes(coldStart.totalBytes)}）`,
    );
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function prepareLiveSwap(label, liveRoot, snapshotRoot, present, token) {
  const parent = path.dirname(liveRoot);
  mkdirSync(parent, { recursive: true });
  const base = path.basename(liveRoot);
  const temporaryBase = base.startsWith(".") ? base : `.${base}`;
  const stage = path.join(parent, `${temporaryBase}.sydaris-stage-${token}`);
  const backup = path.join(parent, `${temporaryBase}.sydaris-backup-${token}`);
  const failed = path.join(parent, `${temporaryBase}.sydaris-failed-${token}`);
  for (const candidate of [stage, backup, failed]) {
    if (existsSync(candidate)) {
      throw new StateManagerError(`临时恢复路径已存在：${candidate}`);
    }
  }
  if (present) copyTree(snapshotRoot, stage);
  return { label, liveRoot, stage, backup, failed, present, movedLive: false, installed: false };
}

function installLiveSwap(swap) {
  if (existsSync(swap.liveRoot)) {
    renameSync(swap.liveRoot, swap.backup);
    swap.movedLive = true;
  }
  if (swap.present) {
    renameSync(swap.stage, swap.liveRoot);
    swap.installed = true;
  }
}

function rollbackLiveSwap(swap) {
  if (swap.installed && existsSync(swap.liveRoot)) {
    renameSync(swap.liveRoot, swap.failed);
  }
  if (swap.movedLive && existsSync(swap.backup)) {
    renameSync(swap.backup, swap.liveRoot);
  }
  for (const disposable of [swap.stage, swap.failed]) {
    rmSync(disposable, { recursive: true, force: true });
  }
}

function cleanupLiveSwap(swap) {
  for (const disposable of [swap.stage, swap.backup, swap.failed]) {
    rmSync(disposable, { recursive: true, force: true });
  }
}

async function loadState(context, stateName, options = {}) {
  validateStateName(stateName);
  if (!options.confirmed) {
    throw new StateManagerError(
      "加载状态会覆盖当前数据库和文件状态。确认后添加 --yes。",
    );
  }
  assertNoActiveCompilation(context.projectRoot, "加载");
  const stateDirectory = path.join(context.stateRoot, stateName);
  const manifest = await verifyStateDirectory(stateDirectory, stateName);

  const safetyName = `autosave-${formatTimestampForName()}-${randomBytes(2).toString("hex")}`;
  console.log(`正在自动保存当前状态：${safetyName}`);
  await saveState(context, safetyName, { skipActiveCheck: true });
  const safetyDirectory = path.join(context.stateRoot, safetyName);

  const token = `${process.pid}-${randomBytes(3).toString("hex")}`;
  const swaps = [];
  let databaseRestored = false;
  try {
    console.log("正在准备文件状态…");
    swaps.push(prepareLiveSwap(
      "资料库",
      context.libraryRoot,
      path.join(stateDirectory, "files", "library"),
      manifest.files.library.present,
      token,
    ));
    swaps.push(prepareLiveSwap(
      "解析产物",
      context.coldStartRoot,
      path.join(stateDirectory, "files", "cold-start"),
      manifest.files.coldStart.present,
      token,
    ));

    console.log(`正在恢复数据库：${stateName}`);
    restoreDatabase(context.projectRoot, path.join(stateDirectory, "database.dump"));
    databaseRestored = true;

    for (const swap of swaps) installLiveSwap(swap);
    const [liveLibrary, liveColdStart] = await Promise.all([
      scanTree(context.libraryRoot),
      scanTree(context.coldStartRoot),
    ]);
    assertTreeMatches("运行中的资料库", manifest.files.library, liveLibrary);
    assertTreeMatches("运行中的解析产物", manifest.files.coldStart, liveColdStart);
    for (const swap of swaps) cleanupLiveSwap(swap);
    console.log(`状态已加载：${stateName}`);
    console.log(`切换前状态保存在：${safetyName}`);
  } catch (error) {
    console.error("状态加载失败，正在回滚…");
    const rollbackFailures = [];
    for (const swap of swaps.slice().reverse()) {
      try {
        rollbackLiveSwap(swap);
      } catch (rollbackError) {
        rollbackFailures.push(`${swap.label}：${rollbackError.message}`);
      }
    }
    if (databaseRestored) {
      try {
        restoreDatabase(context.projectRoot, path.join(safetyDirectory, "database.dump"));
      } catch (rollbackError) {
        rollbackFailures.push(`数据库：${rollbackError.message}`);
      }
    }
    if (rollbackFailures.length) {
      throw new StateManagerError(
        `${error.message}\n自动回滚未完全成功：${rollbackFailures.join("；")}。` +
        `安全快照仍保留在 ${safetyDirectory}`,
        { cause: error },
      );
    }
    throw new StateManagerError(`${error.message}\n已自动恢复到切换前状态。`, { cause: error });
  }
}

function listStates(context) {
  const states = readdirSync(context.stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap((entry) => {
      try {
        const manifest = readManifest(path.join(context.stateRoot, entry.name));
        return [{ name: entry.name, manifest }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
  if (!states.length) {
    console.log("尚未保存任何 Sydaris 状态。");
    return;
  }
  for (const { name, manifest } of states) {
    const total = manifest.files.library.totalBytes + manifest.files.coldStart.totalBytes;
    const commit = manifest.git?.commit ? manifest.git.commit.slice(0, 8) : "unknown";
    const dirty = manifest.git?.dirty ? "+dirty" : "";
    console.log(`${name}\t${manifest.createdAt}\t${humanBytes(total)}\t${commit}${dirty}`);
  }
}

function acquireLock(stateRoot) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateRoot, ".state-manager.lock");
  function tryOpen() {
    const descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${process.pid}\n`);
    closeSync(descriptor);
  }
  try {
    tryOpen();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const previousPid = Number(readFileSync(lockPath, "utf8").trim());
    let alive = Number.isSafeInteger(previousPid) && previousPid > 0;
    if (alive) {
      try {
        process.kill(previousPid, 0);
      } catch (processError) {
        if (processError?.code === "ESRCH") alive = false;
      }
    }
    if (alive) throw new StateManagerError(`另一个状态操作正在运行（PID ${previousPid}）。`);
    unlinkSync(lockPath);
    tryOpen();
  }
  return () => {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
        unlinkSync(lockPath);
      }
    } catch {
      // Process exit cleanup is best effort; stale locks are reclaimed on the next run.
    }
  };
}

function createContext() {
  const projectRoot = path.resolve(
    process.env.SYDARIS_STATE_PROJECT_ROOT?.trim() || DEFAULT_PROJECT_ROOT,
  );
  loadEnvironment(projectRoot);
  const libraryRoot = absoluteConfiguredPath(
    projectRoot,
    "SYDARIS_LIBRARY_STORAGE_ROOT",
    ".sydaris-library",
  );
  const coldStartRoot = absoluteConfiguredPath(
    projectRoot,
    "SYDARIS_COLD_START_OUTPUT_ROOT",
    ".cold-start",
  );
  const stateRoot = absoluteConfiguredPath(
    projectRoot,
    "SYDARIS_STATE_STORAGE_ROOT",
    ".sydaris-states",
  );
  validateStorageSeparation(projectRoot, stateRoot, [libraryRoot, coldStartRoot]);
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  return { projectRoot, libraryRoot, coldStartRoot, stateRoot };
}

function usage() {
  console.log(`用法：
  pnpm state:save -- <name> [--replace] [--allow-active]
  pnpm state:load -- <name> --yes
  pnpm state:list
  pnpm state:verify -- <name>

状态包含 PostgreSQL、.sydaris-library 与 .cold-start；不会切换 Git。`);
}

async function main() {
  const [command, stateName, ...flags] = process.argv.slice(2).filter((argument) => argument !== "--");
  if (!command || ["help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }
  const context = createContext();
  const releaseLock = acquireLock(context.stateRoot);
  try {
    if (command === "save") {
      if (!stateName) throw new StateManagerError("请提供状态名称。");
      await saveState(context, stateName, {
        replace: flags.includes("--replace"),
        allowActive: flags.includes("--allow-active"),
      });
    } else if (command === "load") {
      if (!stateName) throw new StateManagerError("请提供状态名称。");
      await loadState(context, stateName, { confirmed: flags.includes("--yes") });
    } else if (command === "list") {
      listStates(context);
    } else if (command === "verify") {
      if (!stateName) throw new StateManagerError("请提供状态名称。");
      await verifyStateDirectory(path.join(context.stateRoot, stateName), stateName);
    } else {
      throw new StateManagerError(`未知命令：${command}`);
    }
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
