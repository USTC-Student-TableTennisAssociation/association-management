import { getDatabase } from "@/db";
import {
  recalculateLibraryCompilationJob,
} from "@/library/compilation-service";
import {
  catalogCompilationConcurrency,
  coarseCompilationConcurrency,
  DEEP_FILE_CONCURRENCY,
} from "@/library/compilation-concurrency";
import { processLibraryCompilationRun } from "@/library/compilation-processor";
import { processLibraryGlobalResolution } from "@/library/global-object-resolver";

const globalRunner = globalThis as typeof globalThis & {
  libraryJobs?: Map<string, Promise<void>>;
};

function activeJobs(): Map<string, Promise<void>> {
  globalRunner.libraryJobs ??= new Map();
  return globalRunner.libraryJobs;
}

const HEARTBEAT_INTERVAL_MS = 15_000;

function retryDelayMs(retryCount: number): number {
  const configured = Number(process.env.LIBRARY_COMPILATION_RETRY_MAX_DELAY_MS ?? 30_000);
  const maximum = Number.isFinite(configured) ? Math.max(1_000, configured) : 30_000;
  return Math.min(maximum, 1_000 * 2 ** Math.min(5, Math.max(0, retryCount - 1)));
}

async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function pauseRequested(jobId: string): Promise<boolean> {
  const job = await getDatabase().libraryCompilationJob.findUnique({
    where: { id: jobId },
    select: { pauseRequested: true },
  });
  return !job || job.pauseRequested;
}

async function markPaused(jobId: string): Promise<void> {
  await getDatabase().libraryCompilationJob.update({
    where: { id: jobId },
    data: {
      status: "paused",
      activePhase: null,
      activeStage: null,
      heartbeatAt: new Date(),
    },
  });
}

type QueuedRun = {
  id: string;
  profile: "catalog" | "coarse" | "deep";
  sourceBlobId: string | null;
};

async function processRunUntilSettled(
  jobId: string,
  run: QueuedRun,
): Promise<"completed" | "paused"> {
  const database = getDatabase();
  while (true) {
    if (await pauseRequested(jobId)) return "paused";
    try {
      await processLibraryCompilationRun(run.id);
      if (run.sourceBlobId) {
        const completedRun = await database.librarySourceProcessingRun.findUnique({
          where: { id: run.id },
          select: { status: true },
        });
        await database.libraryNode.updateMany({
          where: { blobId: run.sourceBlobId },
          data: {
            processingStatus: completedRun?.status === "failed" ? "failed" : "ready",
          },
        });
      }
      await recalculateLibraryCompilationJob(jobId);
      return "completed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retried = await database.librarySourceProcessingRun.update({
        where: { id: run.id },
        data: {
          status: "queued",
          retryCount: { increment: 1 },
          statusMessage: "处理失败，将从 checkpoint 自动续跑",
          errorMessage: message,
          completedAt: null,
        },
        select: { retryCount: true },
      });
      if (run.sourceBlobId) {
        await database.libraryNode.updateMany({
          where: { blobId: run.sourceBlobId },
          data: { processingStatus: "queued" },
        });
      }
      await recalculateLibraryCompilationJob(jobId);
      if (await pauseRequested(jobId)) return "paused";
      await wait(retryDelayMs(retried.retryCount));
    }
  }
}

async function runFilePhase(
  jobId: string,
  profile: QueuedRun["profile"],
  concurrency: number,
): Promise<boolean> {
  const database = getDatabase();
  const runs = await database.librarySourceProcessingRun.findMany({
    where: { jobId, status: "queued", profile },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, profile: true, sourceBlobId: true },
  });
  if (!runs.length) return true;
  await database.libraryCompilationJob.update({
    where: { id: jobId },
    data: {
      activePhase: profile,
      activeStage: `files:${profile}`,
      heartbeatAt: new Date(),
    },
  });
  let cursor = 0;
  let paused = false;
  const worker = async () => {
    while (!paused) {
      const run = runs[cursor++];
      if (!run) return;
      if (await processRunUntilSettled(jobId, run) === "paused") paused = true;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, runs.length) }, () => worker()),
  );
  if (!paused && !await pauseRequested(jobId)) return true;
  await markPaused(jobId);
  return false;
}

async function runJob(jobId: string): Promise<void> {
  const database = getDatabase();
  const claimed = await database.libraryCompilationJob.updateMany({
    where: { id: jobId, status: "queued", pauseRequested: false },
    data: {
      status: "running",
      startedAt: new Date(),
      heartbeatAt: new Date(),
      errorMessage: null,
    },
  });
  if (!claimed.count) return;
  const heartbeat = setInterval(() => {
    void database.libraryCompilationJob.updateMany({
      where: { id: jobId, status: "running" },
      data: { heartbeatAt: new Date() },
    }).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  try {
    if (!await runFilePhase(jobId, "deep", DEEP_FILE_CONCURRENCY)) return;
    if (!await runFilePhase(jobId, "coarse", coarseCompilationConcurrency())) return;
    if (!await runFilePhase(jobId, "catalog", catalogCompilationConcurrency())) return;
    await recalculateLibraryCompilationJob(jobId);
    await database.libraryCompilationJob.update({
      where: { id: jobId },
      data: {
        activePhase: null,
        activeStage: "global_objects",
        globalStatus: "running",
        globalStatusMessage: "开始跨文件 Global Object 解析",
        globalErrorMessage: null,
        heartbeatAt: new Date(),
      },
    });
    while (true) {
      if (await pauseRequested(jobId)) {
        await markPaused(jobId);
        return;
      }
      try {
        const completed = await processLibraryGlobalResolution(jobId);
        if (!completed) {
          await markPaused(jobId);
          return;
        }
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retried = await database.libraryCompilationJob.update({
          where: { id: jobId },
          data: {
            globalStatus: "running",
            globalRetryCount: { increment: 1 },
            globalStatusMessage: "Global Object 归并或 Shared Brain 发布失败，将从 checkpoint 自动续跑",
            globalErrorMessage: message,
            heartbeatAt: new Date(),
          },
          select: { globalRetryCount: true },
        });
        await wait(retryDelayMs(retried.globalRetryCount));
      }
    }
    await recalculateLibraryCompilationJob(jobId);
    const final = await database.libraryCompilationJob.findUnique({
      where: { id: jobId },
      select: { failedContent: true },
    });
    await database.libraryCompilationJob.update({
      where: { id: jobId },
      data: {
        status: final && final.failedContent > 0 ? "failed" : "completed",
        activePhase: null,
        activeStage: null,
        heartbeatAt: new Date(),
        completedAt: new Date(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.$transaction([
      database.librarySourceProcessingRun.updateMany({
        where: { jobId, status: "running" },
        data: {
          status: "queued",
          statusMessage: "Worker 中断，等待自动恢复",
          errorMessage: message,
          completedAt: null,
        },
      }),
      database.libraryCompilationJob.update({
        where: { id: jobId },
        data: {
          status: "queued",
          activePhase: null,
          activeStage: null,
          heartbeatAt: new Date(),
          completedAt: null,
          errorMessage: `Worker 中断，将自动恢复：${message}`,
        },
      }),
    ]).catch(() => undefined);
    setTimeout(() => startLibraryCompilationInBackground(jobId), retryDelayMs(1));
  } finally {
    clearInterval(heartbeat);
  }
}

export function startLibraryCompilationInBackground(jobId: string): void {
  const jobs = activeJobs();
  if (jobs.has(jobId)) return;
  const promise = new Promise<void>((resolve) => {
    setTimeout(() => void runJob(jobId).finally(resolve), 0);
  }).finally(() => jobs.delete(jobId));
  jobs.set(jobId, promise);
}
