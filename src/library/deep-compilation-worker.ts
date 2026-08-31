import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { deepSourceCompilationConcurrency } from "@/library/compilation-concurrency";
import { resolveStorageKey } from "@/library/object-store";

export type DeepCompilationParallelUnit = {
  id: string;
  kind: "source" | "global_object";
  statusMessage: string;
};

export function deepParallelUnitEventFromProgress(line: string): {
  completed: boolean;
  unit: DeepCompilationParallelUnit;
} | undefined {
  const event = line.match(/^\[\+\s*[\d.]+s\]\s+\[(来源语义|全局对象)·([^\]]+)\]\s+(.+)$/u);
  if (!event) return undefined;
  const [, rawKind, id, statusMessage] = event;
  return {
    completed: /^完成：/u.test(statusMessage),
    unit: {
      id,
      kind: rawKind === "来源语义" ? "source" : "global_object",
      statusMessage: statusMessage.slice(0, 240),
    },
  };
}

export type DeepCompilationCheckpoint = {
  ownerRunId: string;
  sourcePath?: string;
  explorationRun?: string;
  sourceCompilation?: string;
  globalResolution?: string;
  globalAssertions?: string;
  parallelUnits?: DeepCompilationParallelUnit[];
};

export function checkpointOwnedByRun(
  runId: string,
  checkpoint: Partial<DeepCompilationCheckpoint>,
): DeepCompilationCheckpoint {
  return checkpoint.ownerRunId === runId
    ? { ...checkpoint, ownerRunId: runId }
    : { ownerRunId: runId };
}

type DeepWorkerInput = {
  runId: string;
  sha256: string;
  storageKey: string;
  checkpoint: Partial<DeepCompilationCheckpoint>;
  onCheckpoint: (checkpoint: DeepCompilationCheckpoint) => Promise<void>;
  onProgress: (input: {
    progressCurrent: number;
    statusMessage: string;
    parallelUnits?: DeepCompilationParallelUnit[];
  }) => Promise<void>;
};

export type DeepCompilationResult = {
  checkpoint: DeepCompilationCheckpoint;
  globalResolutionDirectory: string;
  objectCount: number;
  assertionCount: number;
};

const explorationSchema = z.object({
  source: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
});

const resolutionSchema = z.object({
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  global_objects: z.array(z.unknown()),
});

const globalAssertionsSchema = z.object({
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  total_assertions: z.number().int().nonnegative(),
});

function outputRoot(): string {
  const configured = process.env.SYDARIS_COLD_START_OUTPUT_ROOT?.trim();
  if (configured) return path.normalize(/* turbopackIgnore: true */ configured);
  return path.join(/* turbopackIgnore: true */ process.cwd(), ".cold-start");
}

function webRunRoot(runId: string): string {
  return path.join(outputRoot(), "library-runs", runId);
}

export function webSourcePath(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("无效的深度冷启动来源 SHA-256");
  // MinerU repeats the input stem in its temporary directories and output
  // filenames. Keeping the 64-character digest as the basename can exceed
  // Windows MAX_PATH, so identity stays in the parent and the parser sees a
  // deliberately short basename.
  return path.join(outputRoot(), "web-sources", sha256, "source.pdf");
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(/* turbopackIgnore: true */ filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(/* turbopackIgnore: true */ directory)).isDirectory();
  } catch {
    return false;
  }
}

export function artifactDirectoryFromProgress(line: string, marker: string): string | undefined {
  const markerIndex = line.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const directory = line.slice(markerIndex + marker.length).trim();
  if (!directory) return undefined;
  return directory.startsWith("/")
    ? path.posix.normalize(/* turbopackIgnore: true */ directory)
    : path.normalize(/* turbopackIgnore: true */ directory);
}

function assertArtifactWithin(directory: string, root: string, label: string): string {
  const resolved = path.resolve(/* turbopackIgnore: true */ directory);
  const allowedRoot = path.resolve(/* turbopackIgnore: true */ root);
  const relative = path.relative(/* turbopackIgnore: true */ allowedRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error(`${label}产物路径越出当前任务允许目录`);
}

function coldStartArgs(command: string, args: string[]): string[] {
  return [
    "run",
    "--project",
    path.join(/* turbopackIgnore: true */ process.cwd(), "services/cold-start"),
    "cold-start",
    command,
    ...args,
  ];
}

async function runColdStartCommand(input: {
  command: string;
  args: string[];
  onLine: (line: string) => void | Promise<void>;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("uv", coldStartArgs(input.command, input.args), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrTail = "";
    let buffered = "";
    let lineFailure: unknown;
    let pendingLines = Promise.resolve();
    const dispatchLine = (line: string) => {
      pendingLines = pendingLines
        .then(() => input.onLine(line))
        .catch((error) => {
          lineFailure = error;
          child.kill();
        });
    };
    const consume = (chunk: Buffer, isError: boolean) => {
      const text = chunk.toString("utf8");
      if (isError) stderrTail = `${stderrTail}${text}`.slice(-8_000);
      buffered += text;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) dispatchLine(line.trim());
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, true));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (buffered.trim()) dispatchLine(buffered.trim());
      void pendingLines.then(() => {
        if (lineFailure) {
          reject(lineFailure);
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(
            `cold-start ${input.command} 失败（code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}）：${stderrTail.trim().slice(-3_000) || "无错误输出"}`,
          ));
        }
      });
    });
  });
}

function progressForwarder(
  progressCurrent: number,
  onProgress: DeepWorkerInput["onProgress"],
  trackParallelUnits = false,
): (line: string) => void {
  let lastWrittenAt = 0;
  let pending = Promise.resolve();
  const activeUnits = new Map<string, DeepCompilationParallelUnit>();
  return (line) => {
    if (trackParallelUnits) {
      const event = deepParallelUnitEventFromProgress(line);
      if (event) {
        const key = `${event.unit.kind}:${event.unit.id}`;
        if (event.completed) {
          activeUnits.delete(key);
        } else {
          activeUnits.set(key, event.unit);
        }
      }
    }
    const now = Date.now();
    if (now - lastWrittenAt < 2_000) return;
    lastWrittenAt = now;
    pending = pending.then(() => onProgress({
      progressCurrent,
      statusMessage: line.slice(0, 1_500),
      ...(trackParallelUnits ? { parallelUnits: [...activeUnits.values()] } : {}),
    })).catch(() => undefined);
  };
}

async function ensureSourceCopy(input: DeepWorkerInput): Promise<string> {
  const target = webSourcePath(input.sha256);
  if (!await isFile(target)) {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(
      /* turbopackIgnore: true */ resolveStorageKey(input.storageKey),
      /* turbopackIgnore: true */ target,
    );
  }
  return target;
}

async function ensureExploration(
  input: DeepWorkerInput,
  checkpoint: DeepCompilationCheckpoint,
): Promise<DeepCompilationCheckpoint> {
  if (checkpoint.explorationRun && await isFile(path.join(checkpoint.explorationRun, "global-exploration.json"))) {
    return checkpoint;
  }
  // Always derive the canonical short path. This replaces checkpoints from
  // older runs that still point at web-sources/<64-character-sha>.pdf.
  const sourcePath = await ensureSourceCopy(input);
  const prepared = { ...checkpoint, sourcePath };
  await input.onCheckpoint(prepared);
  const runRoot = webRunRoot(input.runId);
  await mkdir(runRoot, { recursive: true });
  await input.onProgress({ progressCurrent: 1, statusMessage: "深度冷启动：MinerU 解析与全局区域勘探" });
  let explorationRun: string | undefined;
  const forwardProgress = progressForwarder(1, input.onProgress);
  await runColdStartCommand({
    command: "explore",
    args: ["--source", sourcePath, "--output", runRoot],
    onLine: async (line) => {
      forwardProgress(line);
      const reported = artifactDirectoryFromProgress(line, "已创建运行目录 ");
      if (!reported) return;
      explorationRun = assertArtifactWithin(reported, runRoot, "全局勘探");
      await input.onCheckpoint({ ...prepared, explorationRun });
    },
  });
  if (!explorationRun) throw new Error("深度冷启动 explore 完成但找不到 global-exploration.json");
  const exploration = explorationSchema.parse(JSON.parse(await readFile(
    /* turbopackIgnore: true */ path.join(explorationRun, "global-exploration.json"),
    "utf8",
  )));
  if (exploration.source.sha256 !== input.sha256) {
    throw new Error("深度冷启动 explore 产物 SHA-256 与资料库 Blob 不一致");
  }
  const next = { ...prepared, explorationRun };
  await input.onCheckpoint(next);
  return next;
}

async function ensureSourceCompilation(
  input: DeepWorkerInput,
  checkpoint: DeepCompilationCheckpoint,
): Promise<DeepCompilationCheckpoint> {
  if (!checkpoint.explorationRun) throw new Error("深度冷启动缺少 exploration run");
  let directory = checkpoint.sourceCompilation;
  if (directory && await isFile(path.join(directory, "source-semantics-full.json"))) {
    const next = { ...checkpoint, sourceCompilation: directory };
    await input.onCheckpoint(next);
    return next;
  }
  const resumable = Boolean(directory && await isDirectory(directory));
  let globalDirectory = checkpoint.globalResolution;
  const globalResumable = Boolean(
    globalDirectory &&
    await isDirectory(globalDirectory) &&
    await isFile(path.join(globalDirectory, "working.json"))
  );
  let current = { ...checkpoint };
  const sourceConcurrency = deepSourceCompilationConcurrency();
  await input.onProgress({
    progressCurrent: 2,
    statusMessage: `深度冷启动：${sourceConcurrency} 路来源编译，首个顺序来源完成后同步开始 Global Object`,
  });
  const forwardProgress = progressForwarder(2, input.onProgress, true);
  await runColdStartCommand({
    command: "compile-sources",
    args: [
      "--run",
      checkpoint.explorationRun,
      "--max-parallel-sources",
      String(sourceConcurrency),
      "--resolve-progressively",
      ...(resumable && directory ? ["--resume", directory] : []),
      ...(globalResumable && globalDirectory ? ["--global-resume", globalDirectory] : []),
    ],
    onLine: async (line) => {
      forwardProgress(line);
      const sourceReported = artifactDirectoryFromProgress(
        line,
        "已创建全部来源语义编译目录 ",
      );
      if (sourceReported) {
        directory = assertArtifactWithin(
          sourceReported,
          checkpoint.explorationRun!,
          "来源语义编译",
        );
        current = { ...current, sourceCompilation: directory };
        await input.onCheckpoint(current);
      }
      const globalReported = artifactDirectoryFromProgress(
        line,
        "已创建 Global Resolution 目录 ",
      );
      if (globalReported) {
        if (!directory) throw new Error("Global Resolution 产物早于来源语义目录上报");
        globalDirectory = assertArtifactWithin(
          globalReported,
          directory,
          "Global Resolution",
        );
        current = { ...current, globalResolution: globalDirectory };
        await input.onCheckpoint(current);
      }
    },
  });
  if (!directory || !await isFile(path.join(directory, "source-semantics-full.json"))) {
    throw new Error("来源语义编译结束但缺少 source-semantics-full.json");
  }
  const next = {
    ...current,
    sourceCompilation: directory,
    ...(globalDirectory ? { globalResolution: globalDirectory } : {}),
  };
  await input.onCheckpoint(next);
  return next;
}

async function ensureGlobalResolution(
  input: DeepWorkerInput,
  checkpoint: DeepCompilationCheckpoint,
): Promise<DeepCompilationCheckpoint> {
  if (!checkpoint.sourceCompilation) throw new Error("深度冷启动缺少来源语义 Compilation");
  let directory = checkpoint.globalResolution;
  const artifact = directory ? path.join(directory, "global-resolution.json") : undefined;
  if (directory && artifact && await isFile(artifact)) {
    const assertions = path.join(directory, "global-assertions.json");
    const next = {
      ...checkpoint,
      globalResolution: directory,
      ...(await isFile(assertions) ? { globalAssertions: assertions } : {}),
    };
    await input.onCheckpoint(next);
    return next;
  }
  const resumable = Boolean(
    directory &&
    await isDirectory(directory) &&
    await isFile(path.join(directory, "working.json"))
  );
  await input.onProgress({ progressCurrent: 3, statusMessage: "深度冷启动：逐来源执行 Global Object Resolution" });
  const forwardProgress = progressForwarder(3, input.onProgress);
  await runColdStartCommand({
    command: "resolve-objects",
    args: [
      "--compilation",
      checkpoint.sourceCompilation,
      ...(resumable && directory ? ["--resume", directory] : []),
    ],
    onLine: async (line) => {
      forwardProgress(line);
      const reported = artifactDirectoryFromProgress(line, "已创建 Global Resolution 目录 ");
      if (!reported) return;
      directory = assertArtifactWithin(reported, checkpoint.sourceCompilation!, "Global Resolution");
      await input.onCheckpoint({ ...checkpoint, globalResolution: directory });
    },
  });
  if (!directory || !await isFile(path.join(directory, "global-resolution.json"))) {
    throw new Error("Global Object Resolution 结束但缺少 global-resolution.json");
  }
  const assertions = path.join(directory, "global-assertions.json");
  if (!await isFile(assertions)) {
    throw new Error("Global Object Resolution 结束但缺少 global-assertions.json");
  }
  const next = {
    ...checkpoint,
    globalResolution: directory,
    globalAssertions: assertions,
  };
  await input.onCheckpoint(next);
  return next;
}

export async function runDeepColdStart(input: DeepWorkerInput): Promise<DeepCompilationResult> {
  let checkpoint = checkpointOwnedByRun(input.runId, input.checkpoint);
  if (checkpoint.explorationRun) {
    checkpoint.explorationRun = assertArtifactWithin(
      checkpoint.explorationRun,
      webRunRoot(input.runId),
      "全局勘探 checkpoint",
    );
  }
  if (checkpoint.sourceCompilation && checkpoint.explorationRun) {
    checkpoint.sourceCompilation = assertArtifactWithin(
      checkpoint.sourceCompilation,
      checkpoint.explorationRun,
      "来源语义编译 checkpoint",
    );
  }
  if (checkpoint.globalResolution && checkpoint.sourceCompilation) {
    checkpoint.globalResolution = assertArtifactWithin(
      checkpoint.globalResolution,
      checkpoint.sourceCompilation,
      "Global Resolution checkpoint",
    );
  }
  checkpoint = await ensureExploration(input, checkpoint);
  checkpoint = await ensureSourceCompilation(input, checkpoint);
  checkpoint = await ensureGlobalResolution(input, checkpoint);
  if (!checkpoint.globalResolution || !checkpoint.globalAssertions) {
    throw new Error("深度冷启动产物不完整");
  }
  const [resolution, assertions] = await Promise.all([
    readFile(
      /* turbopackIgnore: true */ path.join(checkpoint.globalResolution, "global-resolution.json"),
      "utf8",
    )
      .then((raw) => resolutionSchema.parse(JSON.parse(raw))),
    readFile(/* turbopackIgnore: true */ checkpoint.globalAssertions, "utf8")
      .then((raw) => globalAssertionsSchema.parse(JSON.parse(raw))),
  ]);
  if (resolution.source_sha256 !== input.sha256 || assertions.source_sha256 !== input.sha256) {
    throw new Error("深度冷启动产物 SHA-256 与资料库 Blob 不一致");
  }
  await input.onProgress({ progressCurrent: 4, statusMessage: "深度冷启动产物已校验，正在保存文件草稿" });
  return {
    checkpoint,
    globalResolutionDirectory: checkpoint.globalResolution,
    objectCount: resolution.global_objects.length,
    assertionCount: assertions.total_assertions,
  };
}
