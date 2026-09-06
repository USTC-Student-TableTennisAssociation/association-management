import { getDatabase } from "@/db";
import {
  inspectMemoryAssertionCorpus,
  memoryAssertionCorpusRevision,
  rebuildMemoryAssertionIndex,
  type MemoryAssertionCorpus,
} from "@/memory/assertion-indexer";

const JOB_ID = "shared";
const ENSURE_THROTTLE_MS = 15_000;

const globalIndexRuntime = globalThis as typeof globalThis & {
  memoryAssertionIndexPromise?: Promise<void>;
  memoryAssertionIndexTimer?: ReturnType<typeof setTimeout>;
  memoryAssertionIndexPendingDelayMs?: number;
  memoryAssertionIndexEnsurePromise?: Promise<void>;
  memoryAssertionIndexLastEnsureAt?: number;
};

export type MemoryAssertionIndexJobView = {
  status: "queued" | "running" | "ready";
  targetRevision: string;
  indexedRevision: string | null;
  targetAssertionCount: number;
  completedAssertionCount: number;
  attemptCount: number;
  errorMessage: string | null;
  nextAttemptAt: Date | null;
};

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() || fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function retryDelayMs(attemptCount: number): number {
  const initial = positiveIntegerEnvironment("MEMORY_INDEX_RETRY_INITIAL_DELAY_MS", 5_000);
  const maximum = positiveIntegerEnvironment("MEMORY_INDEX_RETRY_MAX_DELAY_MS", 300_000);
  return Math.min(maximum, initial * 2 ** Math.min(8, Math.max(0, attemptCount - 1)));
}

function staleAfterMs(): number {
  return positiveIntegerEnvironment("MEMORY_INDEX_STALE_AFTER_MS", 120_000);
}

async function materializedIndexMatches(corpus: MemoryAssertionCorpus): Promise<boolean> {
  const database = getDatabase();
  const [index, embeddings] = await Promise.all([
    database.memoryAssertionEmbeddingIndex.findUnique({ where: { id: JOB_ID } }),
    database.memoryAssertionEmbedding.findMany({
      orderBy: { assertionId: "asc" },
      select: { assertionId: true, contentHash: true },
    }),
  ]);
  if (corpus.assertionCount === 0) return !index && embeddings.length === 0;
  if (
    !index ||
    index.indexedAssertionCount !== corpus.assertionCount ||
    embeddings.length !== corpus.assertionCount
  ) {
    return false;
  }
  return memoryAssertionCorpusRevision(embeddings) === corpus.revision;
}

async function markReadyFromExistingIndex(
  corpus: MemoryAssertionCorpus,
): Promise<MemoryAssertionIndexJobView> {
  const row = await getDatabase().memoryAssertionIndexJob.upsert({
    where: { id: JOB_ID },
    create: {
      id: JOB_ID,
      status: "ready",
      targetRevision: corpus.revision,
      indexedRevision: corpus.revision,
      targetAssertionCount: corpus.assertionCount,
      completedAssertionCount: corpus.assertionCount,
      completedAt: new Date(),
    },
    update: {
      status: "ready",
      targetRevision: corpus.revision,
      indexedRevision: corpus.revision,
      targetAssertionCount: corpus.assertionCount,
      completedAssertionCount: corpus.assertionCount,
      errorMessage: null,
      nextAttemptAt: null,
      startedAt: null,
      heartbeatAt: new Date(),
      completedAt: new Date(),
    },
  });
  return row;
}

/**
 * Compare the durable corpus with the materialized vectors and persist the work
 * still required. This makes a restored snapshot and a manually built index
 * converge to the same lifecycle state.
 */
export async function reconcileMemoryAssertionIndexJob(): Promise<MemoryAssertionIndexJobView> {
  const database = getDatabase();
  const corpus = await inspectMemoryAssertionCorpus();
  if (await materializedIndexMatches(corpus)) {
    return markReadyFromExistingIndex(corpus);
  }

  const existing = await database.memoryAssertionIndexJob.findUnique({
    where: { id: JOB_ID },
  });
  const runningIsFresh = existing?.status === "running" &&
    existing.targetRevision === corpus.revision &&
    existing.heartbeatAt !== null &&
    existing.heartbeatAt.getTime() >= Date.now() - staleAfterMs();
  if (runningIsFresh) return existing;

  return database.memoryAssertionIndexJob.upsert({
    where: { id: JOB_ID },
    create: {
      id: JOB_ID,
      status: "queued",
      targetRevision: corpus.revision,
      targetAssertionCount: corpus.assertionCount,
    },
    update: {
      status: "queued",
      targetRevision: corpus.revision,
      targetAssertionCount: corpus.assertionCount,
      completedAssertionCount: 0,
      errorMessage: existing?.targetRevision === corpus.revision
        ? existing.errorMessage
        : null,
      nextAttemptAt: existing?.targetRevision === corpus.revision
        ? existing.nextAttemptAt
        : null,
      startedAt: null,
      heartbeatAt: null,
      completedAt: null,
    },
  });
}

async function claimQueuedJob(): Promise<MemoryAssertionIndexJobView | null> {
  const database = getDatabase();
  const now = new Date();
  const claimed = await database.memoryAssertionIndexJob.updateMany({
    where: {
      id: JOB_ID,
      status: "queued",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: {
      status: "running",
      attemptCount: { increment: 1 },
      errorMessage: null,
      nextAttemptAt: null,
      startedAt: now,
      heartbeatAt: now,
      completedAt: null,
    },
  });
  if (!claimed.count) return null;
  return database.memoryAssertionIndexJob.findUnique({ where: { id: JOB_ID } });
}

function scheduleAttempt(delayMs = 0): void {
  if (globalIndexRuntime.memoryAssertionIndexPromise) {
    globalIndexRuntime.memoryAssertionIndexPendingDelayMs = Math.min(
      globalIndexRuntime.memoryAssertionIndexPendingDelayMs ?? Number.POSITIVE_INFINITY,
      Math.max(0, delayMs),
    );
    return;
  }
  if (globalIndexRuntime.memoryAssertionIndexTimer) {
    if (delayMs > 0) return;
    clearTimeout(globalIndexRuntime.memoryAssertionIndexTimer);
  }
  globalIndexRuntime.memoryAssertionIndexTimer = setTimeout(() => {
    globalIndexRuntime.memoryAssertionIndexTimer = undefined;
    const promise = runOneAttempt()
      .catch((error) => console.error("[memory.assertion-index]", error))
      .finally(() => {
        if (globalIndexRuntime.memoryAssertionIndexPromise === promise) {
          globalIndexRuntime.memoryAssertionIndexPromise = undefined;
        }
        const pendingDelay = globalIndexRuntime.memoryAssertionIndexPendingDelayMs;
        globalIndexRuntime.memoryAssertionIndexPendingDelayMs = undefined;
        if (pendingDelay !== undefined) scheduleAttempt(pendingDelay);
      });
    globalIndexRuntime.memoryAssertionIndexPromise = promise;
  }, Math.max(0, delayMs));
  globalIndexRuntime.memoryAssertionIndexTimer.unref?.();
}

async function runOneAttempt(): Promise<void> {
  const database = getDatabase();
  const job = await claimQueuedJob();
  if (!job) return;
  const targetRevision = job.targetRevision;
  try {
    const result = await rebuildMemoryAssertionIndex({
      onProgress: async (completed, total) => {
        await database.memoryAssertionIndexJob.updateMany({
          where: { id: JOB_ID, status: "running", targetRevision },
          data: {
            completedAssertionCount: completed,
            targetAssertionCount: total,
            heartbeatAt: new Date(),
          },
        });
      },
    });
    if (result.revision !== targetRevision) {
      throw new Error("Assertion 在索引任务排队后发生变化，正在切换到最新版本");
    }
    const completed = await database.memoryAssertionIndexJob.updateMany({
      where: { id: JOB_ID, status: "running", targetRevision },
      data: {
        status: "ready",
        indexedRevision: result.revision,
        targetAssertionCount: result.indexedAssertionCount,
        completedAssertionCount: result.indexedAssertionCount,
        errorMessage: null,
        nextAttemptAt: null,
        heartbeatAt: new Date(),
        completedAt: new Date(),
      },
    });
    if (completed.count) {
      console.info(
        `[memory.assertion-index] ready ${result.indexedAssertionCount} assertions`,
      );
      return;
    }
    await reconcileMemoryAssertionIndexJob();
    scheduleAttempt();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const delay = retryDelayMs(job.attemptCount);
    const requeued = await database.memoryAssertionIndexJob.updateMany({
      where: { id: JOB_ID, status: "running", targetRevision },
      data: {
        status: "queued",
        completedAssertionCount: 0,
        errorMessage: message,
        nextAttemptAt: new Date(Date.now() + delay),
        heartbeatAt: new Date(),
        completedAt: null,
      },
    });
    if (!requeued.count) {
      await reconcileMemoryAssertionIndexJob();
      scheduleAttempt();
      return;
    }
    console.warn(
      `[memory.assertion-index] attempt ${job.attemptCount} failed; retrying in ${delay}ms: ${message}`,
    );
    scheduleAttempt(delay);
  }
}

/** Queue the current corpus and make a best-effort start in this process. */
export async function queueMemoryAssertionIndexRebuild(): Promise<MemoryAssertionIndexJobView> {
  const job = await reconcileMemoryAssertionIndexJob();
  if (job.status !== "ready") {
    scheduleAttempt(job.nextAttemptAt
      ? Math.max(0, job.nextAttemptAt.getTime() - Date.now())
      : 0);
  }
  return job;
}

async function cheaplyReadCurrentJob(): Promise<MemoryAssertionIndexJobView | null> {
  const database = getDatabase();
  const [job, assertionCount, embeddingCount, index] = await Promise.all([
    database.memoryAssertionIndexJob.findUnique({ where: { id: JOB_ID } }),
    database.memoryAssertion.count(),
    database.memoryAssertionEmbedding.count(),
    database.memoryAssertionEmbeddingIndex.findUnique({ where: { id: JOB_ID } }),
  ]);
  if (!job) return null;
  if (job.status === "ready") {
    return job.targetAssertionCount === assertionCount &&
        embeddingCount === assertionCount &&
        (assertionCount === 0 || index?.indexedAssertionCount === assertionCount)
      ? job
      : null;
  }
  if (job.status === "running") {
    return job.heartbeatAt &&
        job.heartbeatAt.getTime() >= Date.now() - staleAfterMs()
      ? job
      : null;
  }
  return job;
}

/**
 * Called at process startup and cheaply from read paths. It recovers stale work,
 * discovers snapshots with missing vectors, and resumes retries without blocking
 * the request that noticed the problem.
 */
export function ensureMemoryAssertionIndexInBackground(): void {
  const now = Date.now();
  if (
    globalIndexRuntime.memoryAssertionIndexEnsurePromise ||
    now - (globalIndexRuntime.memoryAssertionIndexLastEnsureAt ?? 0) < ENSURE_THROTTLE_MS
  ) {
    return;
  }
  globalIndexRuntime.memoryAssertionIndexLastEnsureAt = now;
  const promise = cheaplyReadCurrentJob()
    .then((job) => job ?? reconcileMemoryAssertionIndexJob())
    .then((job) => {
      if (job.status !== "ready") {
        const delay = job.nextAttemptAt
          ? Math.max(0, job.nextAttemptAt.getTime() - Date.now())
          : 0;
        scheduleAttempt(delay);
      }
    })
    .catch((error) => {
      console.warn("[memory.assertion-index.reconcile]", error);
      scheduleAttempt(retryDelayMs(1));
    })
    .finally(() => {
      if (globalIndexRuntime.memoryAssertionIndexEnsurePromise === promise) {
        globalIndexRuntime.memoryAssertionIndexEnsurePromise = undefined;
      }
    });
  globalIndexRuntime.memoryAssertionIndexEnsurePromise = promise;
}

export async function readMemoryAssertionIndexJob(): Promise<MemoryAssertionIndexJobView | null> {
  return getDatabase().memoryAssertionIndexJob.findUnique({ where: { id: JOB_ID } });
}
