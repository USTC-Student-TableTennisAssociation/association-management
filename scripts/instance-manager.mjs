#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse as parseDotenv } from "dotenv";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const RUNTIME_ROOT = path.join(PROJECT_ROOT, ".sydaris-instances");
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class InstanceManagerError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstanceManagerError";
  }
}

function readEnvironment(filePath, required = true) {
  if (!existsSync(filePath)) {
    if (!required) return {};
    throw new InstanceManagerError(`缺少实例环境文件：${filePath}`);
  }
  return parseDotenv(readFileSync(filePath, "utf8"));
}

const PROFILE_COPY_KEYS = [
  "AI_API_KEY",
  "AI_API_BASE_URL",
  "AI_MODEL",
  "AI_THINKING_MODE",
  "AI_STRUCTURED_OUTPUT_MODE",
  "AI_REQUESTS_PER_MINUTE",
  "AI_TEXT_MAX_IN_FLIGHT",
  "COLD_START_MINERU_PROVIDER",
  "MINERU_MODEL",
  "MINERU_API_KEY",
  "MINERU_API_BASE_URL",
  "MINERU_API_FILE_PARSE_URL",
  "MINERU_API_TIMEOUT_SECONDS",
  "MINERU_API_REQUESTS_PER_MINUTE",
  "MINERU_API_MAX_IN_FLIGHT",
  "COLD_START_EMBEDDING_MODEL",
  "COLD_START_EMBEDDING_MODEL_REVISION",
  "COLD_START_EMBEDDING_DEVICE",
  "COLD_START_MAX_PARALLEL_COMPILATIONS",
  "COLD_START_MAX_PARALLEL_REGIONS",
  "COLD_START_MODEL_MAX_IN_FLIGHT",
];

function dotenvLine(key, value) {
  return `${key}=${JSON.stringify(value ?? "")}`;
}

function initializeProfile(profile, args) {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new InstanceManagerError("实例名称只能包含字母、数字、点、下划线和连字符");
  }
  const base = readEnvironment(path.join(PROJECT_ROOT, ".env"));
  const overlayPath = path.join(PROJECT_ROOT, `.env.${profile}`);
  if (existsSync(overlayPath) && !args.includes("--replace")) {
    throw new InstanceManagerError(`${overlayPath} 已存在；确认覆盖时添加 --replace`);
  }
  let database;
  try {
    database = new URL(base.DATABASE_URL ?? "");
  } catch {
    throw new InstanceManagerError("主 .env 的 DATABASE_URL 不是合法 URL");
  }
  const currentDatabase = database.pathname.replace(/^\//, "");
  const databaseName = optionValue(args, "--database", `${currentDatabase}_${profile}`);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(databaseName)) {
    throw new InstanceManagerError("--database 不是安全的 PostgreSQL 数据库名称");
  }
  database.pathname = `/${databaseName}`;
  const libraryRoot = path.join(RUNTIME_ROOT, profile, "library");
  const coldStartRoot = path.join(RUNTIME_ROOT, profile, "cold-start");
  const values = {
    DATABASE_URL: database.toString(),
    SYDARIS_LIBRARY_STORAGE_ROOT: libraryRoot,
    SYDARIS_COLD_START_OUTPUT_ROOT: coldStartRoot,
    SYDARIS_NEXT_DIST_DIR: `.next-${profile}`,
    ...Object.fromEntries(
      PROFILE_COPY_KEYS
        .filter((key) => base[key] !== undefined)
        .map((key) => [key, base[key]]),
    ),
  };
  writeFileSync(
    overlayPath,
    [
      `# 隔离实例 ${profile}；由 pnpm instance:init 从当时的主 .env 固化。`,
      ...Object.entries(values).map(([key, value]) => dotenvLine(key, value)),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  console.log(`实例环境已创建：${overlayPath}`);
  console.log(`独立数据库名称：${databaseName}（尚未自动创建数据库）`);
  console.log("接下来创建该数据库，再加载基线状态。");
}

function resolveRoot(environment, key, fallback) {
  const configured = environment[key]?.trim();
  const resolved = configured ? path.resolve(PROJECT_ROOT, configured) : fallback;
  return path.normalize(resolved);
}

function databaseIdentity(value) {
  try {
    const parsed = new URL(value);
    return [
      parsed.protocol,
      parsed.hostname,
      parsed.port,
      parsed.pathname,
      parsed.searchParams.get("schema") ?? "",
    ].join("|");
  } catch {
    throw new InstanceManagerError("DATABASE_URL 不是合法 URL");
  }
}

function postgresConnection(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InstanceManagerError("DATABASE_URL 不是合法 URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new InstanceManagerError("隔离实例目前只支持 PostgreSQL DATABASE_URL");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(database)) {
    throw new InstanceManagerError("DATABASE_URL 中的数据库名称不安全");
  }
  return {
    database,
    environment: {
      ...process.env,
      PGHOST: parsed.hostname,
      ...(parsed.port ? { PGPORT: parsed.port } : {}),
      ...(parsed.username ? { PGUSER: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { PGPASSWORD: decodeURIComponent(parsed.password) } : {}),
      PGDATABASE: "postgres",
    },
  };
}

function applicationSchemaInitialized(databaseUrl) {
  const connection = postgresConnection(databaseUrl);
  const checked = spawnSync(
    "psql",
    [
      "--no-password",
      "--tuples-only",
      "--no-align",
      "--command=SELECT to_regclass('public.library_compilation_jobs') IS NOT NULL",
    ],
    {
      cwd: PROJECT_ROOT,
      env: { ...connection.environment, PGDATABASE: connection.database },
      encoding: "utf8",
    },
  );
  if (checked.error) throw checked.error;
  if (checked.status !== 0) {
    throw new InstanceManagerError(checked.stderr.trim() || "无法检查隔离数据库结构");
  }
  return checked.stdout.trim() === "t";
}

function profileEnvironment(profile) {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new InstanceManagerError("实例名称只能包含字母、数字、点、下划线和连字符");
  }
  const base = readEnvironment(path.join(PROJECT_ROOT, ".env"));
  const overlayPath = path.join(PROJECT_ROOT, `.env.${profile}`);
  const overlay = readEnvironment(overlayPath);
  for (const key of [
    "DATABASE_URL",
    "SYDARIS_LIBRARY_STORAGE_ROOT",
    "SYDARIS_COLD_START_OUTPUT_ROOT",
  ]) {
    if (!overlay[key]?.trim()) {
      throw new InstanceManagerError(`${overlayPath} 必须显式配置 ${key}`);
    }
  }
  if (databaseIdentity(base.DATABASE_URL ?? "") === databaseIdentity(overlay.DATABASE_URL)) {
    throw new InstanceManagerError("隔离实例不能与主实例连接同一个数据库/schema");
  }
  const baseLibrary = resolveRoot(
    base,
    "SYDARIS_LIBRARY_STORAGE_ROOT",
    path.join(PROJECT_ROOT, ".sydaris-library"),
  );
  const baseColdStart = resolveRoot(
    base,
    "SYDARIS_COLD_START_OUTPUT_ROOT",
    path.join(PROJECT_ROOT, ".cold-start"),
  );
  const profileLibrary = resolveRoot(overlay, "SYDARIS_LIBRARY_STORAGE_ROOT", "");
  const profileColdStart = resolveRoot(overlay, "SYDARIS_COLD_START_OUTPUT_ROOT", "");
  const nextDistDirectory = overlay.SYDARIS_NEXT_DIST_DIR?.trim() || `.next-${profile}`;
  if (!/^\.next-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nextDistDirectory)) {
    throw new InstanceManagerError("SYDARIS_NEXT_DIST_DIR 必须是项目内的 .next-<name> 目录");
  }
  if (profileLibrary === baseLibrary || profileColdStart === baseColdStart) {
    throw new InstanceManagerError("隔离实例必须使用独立的 Library 与 cold-start 目录");
  }
  if (profileLibrary === profileColdStart) {
    throw new InstanceManagerError("隔离实例的 Library 与 cold-start 目录不能相同");
  }
  return {
    overlayPath,
    environment: {
      ...process.env,
      ...base,
      ...overlay,
      DATABASE_URL: overlay.DATABASE_URL,
      SYDARIS_LIBRARY_STORAGE_ROOT: profileLibrary,
      SYDARIS_COLD_START_OUTPUT_ROOT: profileColdStart,
      SYDARIS_NEXT_DIST_DIR: nextDistDirectory,
    },
  };
}

function instancePaths(profile) {
  const directory = path.join(RUNTIME_ROOT, profile);
  return {
    directory,
    pid: path.join(directory, "server.json"),
    log: path.join(directory, "server.log"),
  };
}

function createDatabase(profile) {
  const { environment } = profileEnvironment(profile);
  const connection = postgresConnection(environment.DATABASE_URL);
  const query = spawnSync(
    "psql",
    [
      "--no-password",
      "--tuples-only",
      "--no-align",
      `--command=SELECT 1 FROM pg_database WHERE datname = '${connection.database}'`,
    ],
    { cwd: PROJECT_ROOT, env: connection.environment, encoding: "utf8" },
  );
  if (query.error) throw query.error;
  if (query.status !== 0) {
    throw new InstanceManagerError(query.stderr.trim() || "无法检查隔离数据库");
  }
  if (query.stdout.trim() === "1") {
    console.log(`隔离数据库已存在：${connection.database}`);
  } else {
    const created = spawnSync(
      "createdb",
      ["--no-password", connection.database],
      { cwd: PROJECT_ROOT, env: connection.environment, encoding: "utf8" },
    );
    if (created.error) throw created.error;
    if (created.status !== 0) {
      throw new InstanceManagerError(created.stderr.trim() || "无法创建隔离数据库");
    }
    console.log(`隔离数据库已创建：${connection.database}`);
  }
  const extension = spawnSync(
    "psql",
    ["--no-password", "--command=CREATE EXTENSION IF NOT EXISTS vector"],
    {
      cwd: PROJECT_ROOT,
      env: { ...connection.environment, PGDATABASE: connection.database },
      encoding: "utf8",
    },
  );
  if (extension.error) throw extension.error;
  if (extension.status !== 0) {
    throw new InstanceManagerError(
      extension.stderr.trim() || "无法安装隔离数据库所需的 vector 扩展",
    );
  }
  console.log("数据库扩展已就绪：vector");
}

function build(profile) {
  const { environment } = profileEnvironment(profile);
  const child = spawnSync("pnpm", ["run", "build"], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: "inherit",
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function readInstance(profile) {
  const paths = instancePaths(profile);
  if (!existsSync(paths.pid)) return { paths, record: undefined };
  let record;
  try {
    record = JSON.parse(readFileSync(paths.pid, "utf8"));
  } catch {
    throw new InstanceManagerError(`实例记录损坏：${paths.pid}`);
  }
  return { paths, record };
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new InstanceManagerError(`${name} 缺少参数`);
  }
  return value;
}

function start(profile, args) {
  const { environment, overlayPath } = profileEnvironment(profile);
  const port = Number(optionValue(args, "--port", "3001"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new InstanceManagerError("--port 必须是 1-65535 的整数");
  }
  const background = args.includes("--background");
  const keepAwake = args.includes("--caffeinate");
  if (keepAwake && !background) {
    throw new InstanceManagerError("--caffeinate 只能与 --background 一起使用");
  }
  const { paths, record } = readInstance(profile);
  if (record && processAlive(record.pid)) {
    throw new InstanceManagerError(`实例 ${profile} 已在运行（PID ${record.pid}）`);
  }
  const buildDirectory = environment.SYDARIS_NEXT_DIST_DIR;
  if (!existsSync(path.join(PROJECT_ROOT, buildDirectory, "BUILD_ID"))) {
    throw new InstanceManagerError(
      `缺少隔离 production build，请先执行 pnpm instance:build -- ${profile}`,
    );
  }
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  if (existsSync(paths.pid)) unlinkSync(paths.pid);
  const nextBinary = path.join(PROJECT_ROOT, "node_modules", ".bin", "next");
  const commandArgs = ["start", "--port", String(port)];
  if (!background) {
    const child = spawnSync(nextBinary, commandArgs, {
      cwd: PROJECT_ROOT,
      env: environment,
      stdio: "inherit",
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  const logDescriptor = openSync(paths.log, "a", 0o600);
  const child = spawn(nextBinary, commandArgs, {
    cwd: PROJECT_ROOT,
    env: environment,
    detached: true,
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  child.unref();
  closeSync(logDescriptor);
  let caffeinatePid;
  if (keepAwake) {
    const keepAwakeProcess = spawn("caffeinate", ["-ims", "-w", String(child.pid)], {
      cwd: PROJECT_ROOT,
      env: environment,
      detached: true,
      stdio: "ignore",
    });
    keepAwakeProcess.unref();
    caffeinatePid = keepAwakeProcess.pid;
  }
  writeFileSync(paths.pid, JSON.stringify({
    profile,
    pid: child.pid,
    port,
    ...(caffeinatePid ? { caffeinatePid } : {}),
    environmentFile: overlayPath,
    startedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
  console.log(`隔离实例已在后台启动：${profile}（PID ${child.pid}，端口 ${port}）`);
  console.log(`日志：${paths.log}`);
}

function status(profile) {
  profileEnvironment(profile);
  const { paths, record } = readInstance(profile);
  if (!record || !processAlive(record.pid)) {
    console.log(`实例未运行：${profile}`);
    if (record && existsSync(paths.pid)) unlinkSync(paths.pid);
    return;
  }
  console.log(`实例运行中：${profile}（PID ${record.pid}，端口 ${record.port}）`);
  console.log(`日志：${paths.log}`);
}

async function stop(profile) {
  profileEnvironment(profile);
  const { paths, record } = readInstance(profile);
  if (!record || !processAlive(record.pid)) {
    if (existsSync(paths.pid)) unlinkSync(paths.pid);
    console.log(`实例未运行：${profile}`);
    return;
  }
  process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && processAlive(record.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (processAlive(record.pid)) {
    throw new InstanceManagerError(
      `实例 ${profile} 尚未退出（PID ${record.pid}）；未自动强制终止`,
    );
  }
  unlinkSync(paths.pid);
  console.log(`实例已停止：${profile}`);
}

function state(profile, args) {
  const { environment } = profileEnvironment(profile);
  if (!args.length) throw new InstanceManagerError("state 需要 state-manager 参数");
  const stateEnvironment = {
    ...environment,
    ...(
      args[0] === "load" && !applicationSchemaInitialized(environment.DATABASE_URL)
        ? { SYDARIS_STATE_SKIP_ACTIVE_CHECK: "true" }
        : {}
    ),
  };
  const child = spawnSync(
    process.execPath,
    [path.join(PROJECT_ROOT, "scripts", "state-manager.mjs"), ...args],
    { cwd: PROJECT_ROOT, env: stateEnvironment, stdio: "inherit" },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}

function usage() {
  console.log(`用法：
  pnpm instance:start -- <name> --port 3001 [--background] [--caffeinate]
  pnpm instance:init -- <name> [--database <database>] [--replace]
  pnpm instance:db:create -- <name>
  pnpm instance:build -- <name>
  pnpm instance:status -- <name>
  pnpm instance:stop -- <name>
  pnpm instance:state -- <name> load <snapshot> --yes
  pnpm instance:state -- <name> save <snapshot>

实例环境来自 .env.<name>，且必须使用独立 DATABASE_URL、Library 和 cold-start 目录。`);
}

async function main() {
  const [command, profile, ...args] = process.argv.slice(2).filter((item) => item !== "--");
  if (!command || !profile || ["help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }
  if (command === "init") initializeProfile(profile, args);
  else if (command === "db:create") createDatabase(profile);
  else if (command === "build") build(profile);
  else if (command === "start") start(profile, args);
  else if (command === "status") status(profile);
  else if (command === "stop") await stop(profile);
  else if (command === "state") state(profile, args);
  else throw new InstanceManagerError(`未知命令：${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
