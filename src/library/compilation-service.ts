import { Prisma } from "@/generated/prisma/client";
import { getDatabase } from "@/db";
import {
  catalogCompilationConcurrency,
  coarseCompilationConcurrency,
  DEEP_FILE_CONCURRENCY,
  deepSourceCompilationConcurrency,
  GLOBAL_OBJECT_CONCURRENCY,
  coldStartModelConcurrency,
  textModelConcurrency,
  visionModelConcurrency,
} from "@/library/compilation-concurrency";
import type {
  LibraryCompilationInventory,
  LibraryCompilationCandidate,
  LibraryCompilationJobView,
  LibraryCompilationOverview,
  LibraryCompilationRunView,
  LibraryCompilationSelection,
} from "@/library/compilation-types";
import { LibraryValidationError } from "@/library/service";
import type { LibraryProcessingProfile } from "@/library/types";

const PROFILE_ORDER: Record<LibraryProcessingProfile, number> = {
  deep: 0,
  coarse: 1,
  catalog: 2,
};

const STALE_JOB_AFTER_MS = 90 * 1_000;

type PlannedContent = {
  sourceBlobId: string;
  representativeNodeId: string;
  profile: LibraryProcessingProfile;
  mimeType: string;
  byteSize: bigint;
  nodeName: string;
  originalRelativePath: string | null;
  duplicateNodeCount: number;
};

async function planUniqueContent(): Promise<{
  contents: PlannedContent[];
  fileNodes: number;
}> {
  const nodes = await getDatabase().libraryNode.findMany({
    where: { kind: "file", blobId: { not: null } },
    orderBy: [{ processingProfile: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      blobId: true,
      processingProfile: true,
      name: true,
      originalRelativePath: true,
      blob: { select: { mimeType: true, byteSize: true } },
    },
  });
  const byBlob = new Map<string, PlannedContent>();
  for (const node of nodes) {
    if (!node.blobId || !node.blob) continue;
    const current = byBlob.get(node.blobId);
    if (current) current.duplicateNodeCount += 1;
    if (!current || PROFILE_ORDER[node.processingProfile] < PROFILE_ORDER[current.profile]) {
      byBlob.set(node.blobId, {
        sourceBlobId: node.blobId,
        representativeNodeId: node.id,
        profile: node.processingProfile,
        mimeType: node.blob.mimeType,
        byteSize: node.blob.byteSize,
        nodeName: node.name,
        originalRelativePath: node.originalRelativePath,
        duplicateNodeCount: current?.duplicateNodeCount ?? 1,
      });
    }
  }
  return {
    contents: [...byBlob.values()].sort((left, right) =>
      PROFILE_ORDER[left.profile] - PROFILE_ORDER[right.profile] ||
      (left.originalRelativePath ?? left.nodeName).localeCompare(
        right.originalRelativePath ?? right.nodeName,
        "zh-CN",
      )
    ),
    fileNodes: nodes.length,
  };
}

export async function getLibraryCompilationInventory(): Promise<LibraryCompilationInventory> {
  const plan = await planUniqueContent();
  const count = (profile: LibraryProcessingProfile) =>
    plan.contents.filter((content) => content.profile === profile).length;
  return {
    fileNodes: plan.fileNodes,
    uniqueContent: plan.contents.length,
    duplicateNodes: Math.max(0, plan.fileNodes - plan.contents.length),
    deep: count("deep"),
    coarse: count("coarse"),
    catalog: count("catalog"),
  };
}

export async function getLibraryCompilationCandidates(): Promise<LibraryCompilationCandidate[]> {
  const plan = await planUniqueContent();
  return plan.contents.map((content) => ({
    sourceBlobId: content.sourceBlobId,
    representativeNodeId: content.representativeNodeId,
    nodeName: content.nodeName,
    ...(content.originalRelativePath
      ? { originalRelativePath: content.originalRelativePath }
      : {}),
    mimeType: content.mimeType,
    byteSize: content.byteSize.toString(),
    duplicateNodeCount: content.duplicateNodeCount,
    profile: content.profile,
  }));
}

export async function createLibraryCompilationJob(
  selections: LibraryCompilationSelection[],
): Promise<string> {
  const database = getDatabase();
  const active = await database.libraryCompilationJob.findFirst({
    where: { status: { in: ["queued", "running", "paused"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (active) throw new LibraryValidationError("已有基础编译任务正在排队、运行或暂停");
  const plan = await planUniqueContent();
  const plannedByBlob = new Map(plan.contents.map((content) => [content.sourceBlobId, content]));
  const selectedByBlob = new Map<string, LibraryProcessingProfile>();
  for (const selection of selections) {
    if (selectedByBlob.has(selection.sourceBlobId)) {
      throw new LibraryValidationError("本次选择中包含重复内容");
    }
    if (!plannedByBlob.has(selection.sourceBlobId)) {
      throw new LibraryValidationError("本次选择包含资料库中不存在的内容");
    }
    selectedByBlob.set(selection.sourceBlobId, selection.profile);
  }
  const contents = selections.map((selection) => ({
    ...plannedByBlob.get(selection.sourceBlobId)!,
    profile: selection.profile,
  }));
  if (!contents.length) throw new LibraryValidationError("请至少选择一份需要编译的内容");
  const semanticContents = contents.filter((content) => content.profile !== "deep");
  if (contents.length && !process.env.AI_MODEL?.trim()) {
    throw new LibraryValidationError("普通文字模型 AI_MODEL 尚未配置");
  }
  if (
    semanticContents.some((content) => content.mimeType.startsWith("image/")) &&
    !process.env.AI_VISION_MODEL?.trim()
  ) {
    throw new LibraryValidationError("所选内容包含图片，但视觉模型 AI_VISION_MODEL 尚未配置");
  }
  const profileCount = (profile: LibraryProcessingProfile) =>
    contents.filter((content) => content.profile === profile).length;
  const job = await database.$transaction(async (transaction) => {
    const created = await transaction.libraryCompilationJob.create({
      data: {
        totalContent: contents.length,
        deepTotal: profileCount("deep"),
        coarseTotal: profileCount("coarse"),
        catalogTotal: profileCount("catalog"),
        configuration: {
          profileOrder: ["deep", "coarse", "catalog"],
          deduplicateBy: "sha256",
          publication: "draft_only",
          version: "library-foundation.v2",
          retryStrategy: "automatic_checkpoint_resume",
          globalObjectResolution: "draft_per_source_checkpoint",
          model: process.env.AI_MODEL?.trim() || null,
          textModel: process.env.AI_MODEL?.trim() || null,
          visionModel: process.env.AI_VISION_MODEL?.trim() || null,
          imagePipeline: "vision_to_text_then_semantic_compilation",
          selectionMode: "explicit",
          unselectedContent: plan.contents.length - contents.length,
        },
      },
      select: { id: true },
    });
    await transaction.librarySourceProcessingRun.createMany({
      data: contents.map((content) => ({
        jobId: created.id,
        libraryNodeId: content.representativeNodeId,
        sourceBlobId: content.sourceBlobId,
        profile: content.profile,
        profileVersion: "library-foundation.v3",
        status: "queued",
        stage: "queued",
        phaseOrder: PROFILE_ORDER[content.profile],
        progressCurrent: 0,
        progressTotal: content.profile === "deep" || content.mimeType.startsWith("image/") ? 5 : 4,
        parserKey: parserKeyForMimeType(content.mimeType),
      })),
    });
    for (const profile of ["deep", "coarse", "catalog"] as const) {
      const blobIds = contents
        .filter((content) => content.profile === profile)
        .map((content) => content.sourceBlobId);
      if (blobIds.length) {
        await transaction.libraryNode.updateMany({
          where: { kind: "file", blobId: { in: blobIds } },
          data: { processingProfile: profile },
        });
      }
    }
    await transaction.libraryNode.updateMany({
      where: { kind: "file", blobId: { in: contents.map((content) => content.sourceBlobId) } },
      data: { processingStatus: "queued" },
    });
    return created;
  });
  return job.id;
}

export function parserKeyForMimeType(mimeType: string): string {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "vision";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (mimeType.startsWith("text/")) return "text";
  if (mimeType.includes("zip")) return "archive-manifest";
  return "metadata-only";
}

function jsonArrayLength(value: Prisma.JsonValue): number {
  return Array.isArray(value) ? value.length : 0;
}

function jsonNumber(value: Prisma.JsonValue, key: string): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function parallelUnits(value: Prisma.JsonValue): LibraryCompilationRunView["parallelUnits"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const deep = value.deep;
  if (!deep || typeof deep !== "object" || Array.isArray(deep)) return [];
  const units = deep.parallelUnits;
  if (!Array.isArray(units)) return [];
  return units.flatMap((unit) => {
    if (!unit || typeof unit !== "object" || Array.isArray(unit)) return [];
    const { id, kind, statusMessage } = unit;
    if (
      typeof id !== "string" ||
      (kind !== "source" && kind !== "global_object") ||
      typeof statusMessage !== "string"
    ) return [];
    return [{
      id,
      kind: kind as "source" | "global_object",
      statusMessage,
    }];
  }).slice(0, 32);
}

function modelRetries(value: Prisma.JsonValue): LibraryCompilationRunView["modelRetries"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { text: 0, vision: 0 };
  const retries = value.modelRetries;
  if (!retries || typeof retries !== "object" || Array.isArray(retries)) {
    return { text: 0, vision: 0 };
  }
  const text = typeof retries.text === "number" && Number.isFinite(retries.text)
    ? Math.max(0, Math.floor(retries.text))
    : 0;
  const vision = typeof retries.vision === "number" && Number.isFinite(retries.vision)
    ? Math.max(0, Math.floor(retries.vision))
    : 0;
  return {
    text,
    vision,
    ...(typeof retries.lastError === "string" ? { lastError: retries.lastError } : {}),
    ...(typeof retries.lastFailedAt === "string" ? { lastFailedAt: retries.lastFailedAt } : {}),
  };
}

function runView(run: {
  id: string;
  profile: "catalog" | "coarse" | "deep";
  status: "idle" | "queued" | "running" | "ready" | "failed";
  stage: "queued" | "preparing" | "parsing" | "analyzing" | "resolving" | "staging" | "ready" | "failed";
  progressCurrent: number;
  progressTotal: number;
  retryCount: number;
  statusMessage: string | null;
  resultSummary: string | null;
  errorMessage: string | null;
  publishedAt: Date | null;
  publishedAssertionCount: number;
  publishedObjectCount: number;
  checkpoint: Prisma.JsonValue;
  libraryNode: { id: string; name: string; originalRelativePath: string | null };
  sourceBlob: { mimeType: string; byteSize: bigint } | null;
  assessment: null | {
    summary: string;
    referenceCandidates: Prisma.JsonValue;
    assertionCandidates: Prisma.JsonValue;
    objectCandidates: Prisma.JsonValue;
  };
}): LibraryCompilationRunView {
  return {
    id: run.id,
    profile: run.profile,
    status: run.status,
    stage: run.stage,
    progressCurrent: run.progressCurrent,
    progressTotal: run.progressTotal,
    retryCount: run.retryCount,
    ...(run.statusMessage ? { statusMessage: run.statusMessage } : {}),
    nodeId: run.libraryNode.id,
    nodeName: run.libraryNode.name,
    ...(run.libraryNode.originalRelativePath
      ? { originalRelativePath: run.libraryNode.originalRelativePath }
      : {}),
    mimeType: run.sourceBlob?.mimeType ?? "application/octet-stream",
    byteSize: (run.sourceBlob?.byteSize ?? BigInt(0)).toString(),
    ...(run.resultSummary ? { resultSummary: run.resultSummary } : {}),
    ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    ...(run.publishedAt ? { publishedAt: run.publishedAt.toISOString() } : {}),
    publishedAssertionCount: run.publishedAssertionCount,
    publishedObjectCount: run.publishedObjectCount,
    modelRetries: modelRetries(run.checkpoint),
    parallelUnits: parallelUnits(run.checkpoint),
    ...(run.assessment
      ? {
          assessment: {
            summary: run.assessment.summary,
            referenceCandidateCount: jsonArrayLength(run.assessment.referenceCandidates),
            assertionCandidateCount: jsonArrayLength(run.assessment.assertionCandidates),
            objectCandidateCount: jsonArrayLength(run.assessment.objectCandidates),
          },
        }
      : {}),
  };
}

const runInclude = {
  libraryNode: { select: { id: true, name: true, originalRelativePath: true } },
  sourceBlob: { select: { mimeType: true, byteSize: true } },
  assessment: true,
} satisfies Prisma.LibrarySourceProcessingRunInclude;

export async function getLibraryCompilationJobView(
  jobId?: string,
): Promise<LibraryCompilationJobView | undefined> {
  const database = getDatabase();
  const job = jobId
    ? await database.libraryCompilationJob.findUnique({ where: { id: jobId } })
    : await database.libraryCompilationJob.findFirst({ orderBy: { createdAt: "desc" } });
  if (!job) return undefined;
  const [activeRuns, queuedRun, failureRuns, recentRuns] = await Promise.all([
    database.librarySourceProcessingRun.findMany({
      where: { jobId: job.id, status: "running" },
      orderBy: [{ phaseOrder: "asc" }, { createdAt: "asc" }],
      take: 18,
      include: runInclude,
    }),
    database.librarySourceProcessingRun.findFirst({
      where: { jobId: job.id, status: "queued" },
      orderBy: [{ phaseOrder: "asc" }, { createdAt: "asc" }],
      include: runInclude,
    }),
    database.librarySourceProcessingRun.findMany({
      where: { jobId: job.id, status: "failed" },
      orderBy: [{ status: "desc" }, { createdAt: "asc" }],
      take: 100,
      include: runInclude,
    }),
    database.librarySourceProcessingRun.findMany({
      where: { jobId: job.id, status: { in: ["ready", "failed"] } },
      orderBy: { completedAt: "desc" },
      take: 40,
      include: runInclude,
    }),
  ]);
  const activeRunViews = activeRuns.map(runView);
  const queuedRunView = queuedRun ? runView(queuedRun) : undefined;
  return {
    id: job.id,
    status: job.status,
    recoverable: Boolean(
      ["queued", "running"].includes(job.status) &&
      job.heartbeatAt &&
      job.heartbeatAt <= new Date(Date.now() - STALE_JOB_AFTER_MS)
    ),
    ...(job.activePhase ? { activePhase: job.activePhase } : {}),
    ...(job.activeStage ? { activeStage: job.activeStage } : {}),
    pauseRequested: job.pauseRequested,
    totalContent: job.totalContent,
    completedContent: job.completedContent,
    failedContent: job.failedContent,
    phases: {
      deep: { total: job.deepTotal, completed: job.deepCompleted },
      coarse: { total: job.coarseTotal, completed: job.coarseCompleted },
      catalog: { total: job.catalogTotal, completed: job.catalogCompleted },
    },
    globalResolution: {
      status: job.globalStatus,
      progress: job.globalProgress,
      total: job.globalTotal,
      retryCount: job.globalRetryCount,
      ...(job.globalStatusMessage ? { statusMessage: job.globalStatusMessage } : {}),
      ...(job.globalErrorMessage ? { errorMessage: job.globalErrorMessage } : {}),
      objectCount: jsonNumber(job.globalResult, "objectCount"),
    },
    createdAt: job.createdAt.toISOString(),
    ...(job.startedAt ? { startedAt: job.startedAt.toISOString() } : {}),
    ...(job.heartbeatAt ? { heartbeatAt: job.heartbeatAt.toISOString() } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt.toISOString() } : {}),
    ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
    ...(activeRunViews[0]
      ? { activeRun: activeRunViews[0] }
      : queuedRunView
        ? { activeRun: queuedRunView }
        : {}),
    activeRuns: activeRunViews,
    concurrency: {
      deepFiles: DEEP_FILE_CONCURRENCY,
      deepSources: deepSourceCompilationConcurrency(),
      coarseFiles: coarseCompilationConcurrency(),
      catalogFiles: catalogCompilationConcurrency(),
      textModels: textModelConcurrency(),
      visionModels: visionModelConcurrency(),
      coldStartModels: coldStartModelConcurrency(),
      globalObjects: GLOBAL_OBJECT_CONCURRENCY,
    },
    recentRuns: recentRuns.map(runView),
    failureRuns: failureRuns.map(runView),
  };
}

export async function getLibraryCompilationOverview(
  jobId?: string,
  includeCandidates = true,
): Promise<LibraryCompilationOverview> {
  const [inventory, job, candidates] = await Promise.all([
    getLibraryCompilationInventory(),
    getLibraryCompilationJobView(jobId),
    includeCandidates ? getLibraryCompilationCandidates() : undefined,
  ]);
  return {
    inventory,
    modelConfiguration: {
      text: {
        configured: Boolean(process.env.AI_MODEL?.trim()),
        ...(process.env.AI_MODEL?.trim() ? { modelId: process.env.AI_MODEL.trim() } : {}),
      },
      vision: {
        configured: Boolean(process.env.AI_VISION_MODEL?.trim()),
        ...(process.env.AI_VISION_MODEL?.trim()
          ? { modelId: process.env.AI_VISION_MODEL.trim() }
          : {}),
      },
    },
    ...(candidates ? { candidates } : {}),
    ...(job ? { job } : {}),
  };
}

export async function recalculateLibraryCompilationJob(jobId: string): Promise<void> {
  const database = getDatabase();
  const runs = await database.librarySourceProcessingRun.findMany({
    where: { jobId },
    select: { profile: true, status: true, stage: true },
  });
  const handled = (profile: LibraryProcessingProfile) =>
    runs.filter((run) =>
      run.profile === profile && (run.status === "ready" || run.status === "failed")
    ).length;
  await database.libraryCompilationJob.update({
    where: { id: jobId },
    data: {
      completedContent: runs.filter((run) => run.status === "ready").length,
      failedContent: runs.filter((run) => run.status === "failed").length,
      deepCompleted: handled("deep"),
      coarseCompleted: handled("coarse"),
      catalogCompleted: handled("catalog"),
      heartbeatAt: new Date(),
    },
  });
}

export async function requestLibraryCompilationPause(jobId: string): Promise<void> {
  const database = getDatabase();
  const job = await database.libraryCompilationJob.findUnique({ where: { id: jobId } });
  if (!job) throw new LibraryValidationError("基础编译任务不存在");
  if (!["queued", "running"].includes(job.status)) {
    throw new LibraryValidationError("当前任务不能暂停");
  }
  await database.libraryCompilationJob.update({
    where: { id: jobId },
    data: {
      pauseRequested: true,
      ...(job.status === "queued" ? { status: "paused" as const } : {}),
    },
  });
}

export async function prepareLibraryCompilationResume(jobId: string): Promise<void> {
  const result = await getDatabase().libraryCompilationJob.updateMany({
    where: { id: jobId, status: { in: ["paused", "queued"] } },
    data: {
      status: "queued",
      pauseRequested: false,
      completedAt: null,
      errorMessage: null,
    },
  });
  if (!result.count) throw new LibraryValidationError("当前任务不能继续");
}

export async function prepareLibraryCompilationRecovery(jobId: string): Promise<void> {
  const database = getDatabase();
  const job = await database.libraryCompilationJob.findUnique({
    where: { id: jobId },
    select: { status: true, heartbeatAt: true, activeStage: true },
  });
  if (!job) throw new LibraryValidationError("基础编译任务不存在");
  const staleBefore = new Date(Date.now() - STALE_JOB_AFTER_MS);
  if (
    !["queued", "running"].includes(job.status) ||
    !job.heartbeatAt ||
    job.heartbeatAt > staleBefore
  ) {
    throw new LibraryValidationError("任务心跳尚未超时，不能作为中断任务恢复");
  }

  const interruptedRuns = await database.librarySourceProcessingRun.findMany({
    where: { jobId, status: "running" },
    select: { id: true, sourceBlobId: true },
  });
  const runIds = interruptedRuns.map((run) => run.id);
  const sourceBlobIds = interruptedRuns
    .map((run) => run.sourceBlobId)
    .filter((id): id is string => Boolean(id));
  await database.$transaction([
    database.librarySourceProcessingRun.updateMany({
      where: { id: { in: runIds } },
      data: {
        status: "queued",
        stage: "queued",
        progressCurrent: 0,
        retryCount: { increment: 1 },
        statusMessage: "中断后等待自动恢复",
        resultSummary: null,
        errorMessage: null,
        completedAt: null,
      },
    }),
    database.libraryNode.updateMany({
      where: { blobId: { in: sourceBlobIds } },
      data: { processingStatus: "queued" },
    }),
    database.libraryCompilationJob.update({
      where: { id: jobId },
      data: {
        status: "queued",
        activePhase: null,
        activeStage: null,
        pauseRequested: false,
        startedAt: null,
        heartbeatAt: new Date(),
        completedAt: null,
        errorMessage: null,
        ...(job.activeStage === "global_objects"
          ? {
              globalRetryCount: { increment: 1 },
              globalStatusMessage: "Global Object worker 中断，将从已保存的文件 checkpoint 续跑",
            }
          : {}),
      },
    }),
  ]);
  await recalculateLibraryCompilationJob(jobId);
}

export async function prepareLibraryCompilationRetry(jobId: string): Promise<void> {
  const database = getDatabase();
  const failedRuns = await database.librarySourceProcessingRun.findMany({
    where: { jobId, status: "failed" },
    select: { id: true },
  });
  if (!failedRuns.length) throw new LibraryValidationError("没有可重试的失败文件");
  const ids = failedRuns.map((run) => run.id);
  await database.$transaction([
    database.librarySourceProcessingRun.updateMany({
      where: { id: { in: ids } },
      data: {
        status: "queued",
        stage: "queued",
        progressCurrent: 0,
        statusMessage: "等待重试",
        resultSummary: null,
        errorMessage: null,
        completedAt: null,
      },
    }),
    database.libraryCompilationJob.update({
      where: { id: jobId },
      data: {
        status: "queued",
        pauseRequested: false,
        completedAt: null,
        errorMessage: null,
      },
    }),
  ]);
  await recalculateLibraryCompilationJob(jobId);
}
