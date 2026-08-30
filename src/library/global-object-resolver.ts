import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  extractJsonMiddleware,
  generateText,
  NoObjectGeneratedError,
  Output,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";

import { getChatModel } from "@/ai/provider";
import { getDatabase } from "@/db";
import { parseEmbeddedModelJson } from "@/library/compilation-processor";
import {
  libraryObjectCandidateSchema,
} from "@/library/compilation-types";
import { publishLibraryRunsToSharedMemory } from "@/library/shared-memory-publisher";

type IncomingObjectCandidate = {
  key: string;
  runId: string;
  sourceName: string;
  label: string;
  reason: string;
  action: "bind_existing" | "new_candidate";
  existingObjectId?: string;
};

type IncomingSource = {
  runId: string;
  sourceBlobId: string;
  sourceName: string;
  preResolved: boolean;
  candidates: IncomingObjectCandidate[];
};

const globalObjectMemberSchema = z.object({
  key: z.string(),
  runId: z.string().uuid(),
  sourceName: z.string(),
  label: z.string(),
  reason: z.string(),
});

const globalObjectDraftSchema = z.object({
  draftObjectId: z.string().uuid(),
  canonicalLabel: z.string().min(1),
  labels: z.array(z.string().min(1)),
  existingObjectId: z.string().uuid().optional(),
  members: z.array(globalObjectMemberSchema),
});

const globalCheckpointSchema = z.object({
  version: z.literal("library-global-resolution.v3"),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  nextSourceIndex: z.number().int().nonnegative(),
  objects: z.array(globalObjectDraftSchema),
});

type GlobalCheckpoint = z.infer<typeof globalCheckpointSchema>;
export type GlobalObjectDraft = z.infer<typeof globalObjectDraftSchema>;

function refreshedGlobalObject(
  object: GlobalObjectDraft,
  members: GlobalObjectDraft["members"],
): GlobalObjectDraft | undefined {
  const uniqueMembers = [...new Map(members.map((item) => [item.key, item])).values()];
  if (!uniqueMembers.length) return undefined;
  const labels = [...new Set(uniqueMembers.map((item) => item.label))];
  const keepsCanonicalLabel = labels.some((label) =>
    normalizeObjectLabel(label) === normalizeObjectLabel(object.canonicalLabel)
  );
  return {
    ...object,
    canonicalLabel: object.existingObjectId || keepsCanonicalLabel
      ? object.canonicalLabel
      : labels[0],
    labels,
    members: uniqueMembers,
  };
}

export function withoutGlobalObjectRuns(
  objects: GlobalObjectDraft[],
  runIds: ReadonlySet<string>,
): GlobalObjectDraft[] {
  return objects.flatMap((object) => {
    const refreshed = refreshedGlobalObject(
      object,
      object.members.filter((memberItem) => !runIds.has(memberItem.runId)),
    );
    return refreshed ? [refreshed] : [];
  });
}

export function onlyGlobalObjectRuns(
  objects: GlobalObjectDraft[],
  runIds: ReadonlySet<string>,
): GlobalObjectDraft[] {
  return objects.flatMap((object) => {
    const refreshed = refreshedGlobalObject(
      object,
      object.members.filter((memberItem) => runIds.has(memberItem.runId)),
    );
    return refreshed ? [refreshed] : [];
  });
}

export function mergeGlobalObjectDrafts(
  base: GlobalObjectDraft[],
  additions: GlobalObjectDraft[],
): GlobalObjectDraft[] {
  const merged = base.map((object) => ({
    ...object,
    labels: [...object.labels],
    members: [...object.members],
  }));
  for (const addition of additions) {
    const index = merged.findIndex((object) =>
      object.draftObjectId === addition.draftObjectId ||
      Boolean(
        object.existingObjectId &&
        addition.existingObjectId &&
        object.existingObjectId === addition.existingObjectId
      )
    );
    if (index < 0) {
      merged.push(addition);
      continue;
    }
    const refreshed = refreshedGlobalObject(
      merged[index],
      [...merged[index].members, ...addition.members],
    );
    if (refreshed) merged[index] = refreshed;
  }
  return merged;
}

const attachDecisionSchema = z.object({
  action: z.literal("attach_draft"),
  incomingKeys: z.array(z.string()).min(1),
  targetDraftObjectId: z.string().uuid(),
});

const bindDecisionSchema = z.object({
  action: z.literal("bind_existing"),
  incomingKeys: z.array(z.string()).min(1),
  existingObjectId: z.string().uuid(),
});

const createDecisionSchema = z.object({
  action: z.literal("create_new"),
  incomingKeys: z.array(z.string()).min(1),
  canonicalLabel: z.string().trim().min(1).max(200),
});

export const globalObjectResolutionDecisionSchema = z.object({
  groups: z.array(z.discriminatedUnion("action", [
    attachDecisionSchema,
    bindDecisionSchema,
    createDecisionSchema,
  ])).min(1).max(100),
});

type GlobalDecision = z.infer<typeof globalObjectResolutionDecisionSchema>;

export function failureAfterGlobalResolution(input: {
  runId: string;
  objectCandidates: unknown;
  resolvedMemberKeys: ReadonlySet<string>;
}): { failed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const rawCandidates = Array.isArray(input.objectCandidates) ? input.objectCandidates : [];
  let invalidCandidates = 0;
  let unresolvedCandidates = 0;
  rawCandidates.forEach((candidate, index) => {
    const parsed = libraryObjectCandidateSchema.safeParse(candidate);
    if (!parsed.success) {
      invalidCandidates += 1;
      return;
    }
    if (
      parsed.data.action === "new_candidate" &&
      !input.resolvedMemberKeys.has(`${input.runId}:assessment:${index}`)
    ) {
      unresolvedCandidates += 1;
    }
  });
  if (invalidCandidates) reasons.push(`${invalidCandidates} 个 Object 候选格式无效`);
  if (unresolvedCandidates) reasons.push(`${unresolvedCandidates} 个新 Object 候选尚未完成全局归并`);
  return { failed: reasons.length > 0, reasons };
}

type ExistingObject = {
  id: string;
  canonicalName: string;
  surfaceForms: string[];
};

export function normalizeObjectLabel(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s·•_/—–-]+/g, "");
}

function member(candidate: IncomingObjectCandidate) {
  return {
    key: candidate.key,
    runId: candidate.runId,
    sourceName: candidate.sourceName,
    label: candidate.label,
    reason: candidate.reason,
  };
}

function mergeLabels(current: string[], candidates: IncomingObjectCandidate[]): string[] {
  return [...new Set([...current, ...candidates.map((item) => item.label)])];
}

function findExistingDraft(objects: GlobalObjectDraft[], existingObjectId: string) {
  return objects.find((item) => item.existingObjectId === existingObjectId);
}

function attachCandidates(
  object: GlobalObjectDraft,
  candidates: IncomingObjectCandidate[],
): GlobalObjectDraft {
  return {
    ...object,
    labels: mergeLabels(object.labels, candidates),
    members: [...object.members, ...candidates.map(member)],
  };
}

function newDraft(
  candidates: IncomingObjectCandidate[],
  canonicalLabel: string,
  existingObjectId?: string,
): GlobalObjectDraft {
  return {
    draftObjectId: randomUUID(),
    canonicalLabel,
    labels: mergeLabels([], candidates),
    ...(existingObjectId ? { existingObjectId } : {}),
    members: candidates.map(member),
  };
}

function validateDecision(
  decision: GlobalDecision,
  incoming: IncomingObjectCandidate[],
  candidateDrafts: GlobalObjectDraft[],
  candidateExisting: ExistingObject[],
): void {
  const expected = incoming.map((item) => item.key).sort();
  const actual = decision.groups.flatMap((item) => item.incomingKeys).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Global Object 决策必须恰好覆盖当前文件的每个 Object 候选一次");
  }
  const draftIds = new Set(candidateDrafts.map((item) => item.draftObjectId));
  const existingIds = new Set(candidateExisting.map((item) => item.id));
  for (const group of decision.groups) {
    if (group.action === "attach_draft" && !draftIds.has(group.targetDraftObjectId)) {
      throw new Error("Global Object 决策引用了未召回的草稿 Object");
    }
    if (group.action === "bind_existing" && !existingIds.has(group.existingObjectId)) {
      throw new Error("Global Object 决策引用了未召回的既有 Object");
    }
    if (
      group.action === "create_new" &&
      !group.incomingKeys.some((key) =>
        incoming.find((item) => item.key === key)?.label === group.canonicalLabel
      )
    ) {
      throw new Error("新 Object 的 canonicalLabel 必须来自当前文件候选原文");
    }
  }
}

export function applyGlobalDecision(
  objects: GlobalObjectDraft[],
  incoming: IncomingObjectCandidate[],
  decision: GlobalDecision,
  existingObjects: ExistingObject[],
): GlobalObjectDraft[] {
  const next = objects.map((item) => ({ ...item, members: [...item.members], labels: [...item.labels] }));
  const byKey = new Map(incoming.map((item) => [item.key, item]));
  for (const group of decision.groups) {
    const candidates = group.incomingKeys.map((key) => {
      const candidate = byKey.get(key);
      if (!candidate) throw new Error(`Global Object 决策引用未知候选：${key}`);
      return candidate;
    });
    if (group.action === "attach_draft") {
      const index = next.findIndex((item) => item.draftObjectId === group.targetDraftObjectId);
      if (index < 0) throw new Error("Global Object 草稿目标不存在");
      next[index] = attachCandidates(next[index], candidates);
      continue;
    }
    if (group.action === "bind_existing") {
      const existing = existingObjects.find((item) => item.id === group.existingObjectId);
      if (!existing) throw new Error("既有 Global Object 不存在");
      const target = findExistingDraft(next, existing.id);
      if (target) {
        const index = next.findIndex((item) => item.draftObjectId === target.draftObjectId);
        next[index] = attachCandidates(target, candidates);
      } else {
        next.push(newDraft(candidates, existing.canonicalName, existing.id));
      }
      continue;
    }
    next.push(newDraft(candidates, group.canonicalLabel));
  }
  return next;
}

function similarityText(candidate: IncomingObjectCandidate): string {
  return normalizeObjectLabel(`${candidate.label}${candidate.reason}`);
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    result.add(value.slice(index, index + 2));
  }
  return result;
}

function overlapScore(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) return 50;
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  let matches = 0;
  for (const item of leftPairs) if (rightPairs.has(item)) matches += 1;
  return matches;
}

function shortlistDrafts(
  incoming: IncomingObjectCandidate[],
  objects: GlobalObjectDraft[],
): GlobalObjectDraft[] {
  return objects.map((object) => ({
    object,
    score: Math.max(...incoming.map((candidate) => overlapScore(
      similarityText(candidate),
      normalizeObjectLabel(
        `${object.labels.join(" ")} ${object.members.map((item) => `${item.label} ${item.reason}`).join(" ")}`,
      ),
    ))),
  })).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 40)
    .map((item) => item.object);
}

function shortlistExisting(
  incoming: IncomingObjectCandidate[],
  objects: ExistingObject[],
): ExistingObject[] {
  return objects.map((object) => ({
    object,
    score: Math.max(...incoming.map((candidate) => overlapScore(
      similarityText(candidate),
      normalizeObjectLabel(`${object.canonicalName} ${object.surfaceForms.join(" ")}`),
    ))),
  })).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 30)
    .map((item) => item.object);
}

function deterministicDecision(
  incoming: IncomingObjectCandidate[],
  objects: GlobalObjectDraft[],
  existingObjects: ExistingObject[],
): { decision: GlobalDecision; unresolved: IncomingObjectCandidate[] } {
  const groups: GlobalDecision["groups"] = [];
  const unresolved: IncomingObjectCandidate[] = [];
  for (const candidate of incoming) {
    if (candidate.action === "bind_existing" && candidate.existingObjectId) {
      groups.push({
        action: "bind_existing",
        incomingKeys: [candidate.key],
        existingObjectId: candidate.existingObjectId,
      });
      continue;
    }
    const normalized = normalizeObjectLabel(candidate.label);
    const matchingDrafts = objects.filter((object) =>
      object.labels.some((label) => normalizeObjectLabel(label) === normalized)
    );
    if (matchingDrafts.length === 1) {
      groups.push({
        action: "attach_draft",
        incomingKeys: [candidate.key],
        targetDraftObjectId: matchingDrafts[0].draftObjectId,
      });
      continue;
    }
    const matchingExisting = existingObjects.filter((object) =>
      normalizeObjectLabel(object.canonicalName) === normalized
    );
    if (matchingExisting.length === 1) {
      groups.push({
        action: "bind_existing",
        incomingKeys: [candidate.key],
        existingObjectId: matchingExisting[0].id,
      });
      continue;
    }
    unresolved.push(candidate);
  }
  return { decision: { groups }, unresolved };
}

function structuredTextModel() {
  return wrapLanguageModel({ model: getChatModel(), middleware: extractJsonMiddleware() });
}

async function decideWithModel(
  incoming: IncomingObjectCandidate[],
  candidateDrafts: GlobalObjectDraft[],
  candidateExisting: ExistingObject[],
): Promise<GlobalDecision> {
  const prompt = [
    "你正在做 Sydaris 基础编译的跨文件 Global Object 身份归并。当前文件等价于一个叶子来源。",
    "只判断不同文件中的名称是否指向现实中的同一个稳定对象；主题相关、同属一个活动、斜杠并列或标题相邻都不等于同一对象。",
    "attach_draft 只能指向给出的草稿候选；bind_existing 只能指向给出的正式 Object 候选；证据不足时 create_new。",
    "允许把当前文件的多个 incomingKeys 放入同一组，但只有来源理由明确说明它们同指时才这样做。",
    "create_new 的 canonicalLabel 必须逐字采用该组某个 incoming label。不要创建或修改正式 Shared Brain 数据。",
    `当前文件候选：${JSON.stringify(incoming)}`,
    `已建立草稿候选：${JSON.stringify(candidateDrafts.map((item) => ({
      draftObjectId: item.draftObjectId,
      canonicalLabel: item.canonicalLabel,
      labels: item.labels,
      sourceReasons: item.members.map((memberItem) => memberItem.reason),
      sourceNames: [...new Set(item.members.map((memberItem) => memberItem.sourceName))],
    })))}`,
    `正式 Object 候选：${JSON.stringify(candidateExisting)}`,
  ].join("\n");
  try {
    const result = await generateText({
      model: structuredTextModel(),
      messages: [{ role: "user", content: prompt }],
      output: Output.object({
        schema: globalObjectResolutionDecisionSchema,
        name: "library_global_object_resolution",
        description: "把当前文件的 Object 候选归并到跨文件草稿或既有 Object",
      }),
      temperature: 0,
      maxOutputTokens: 5_000,
    });
    return result.output;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const recovered = parseEmbeddedModelJson(error.text, globalObjectResolutionDecisionSchema);
      if (recovered) return recovered;
      throw new Error(`${error.message}；rawResponse=${error.text?.slice(0, 2_000) || "<empty>"}`);
    }
    throw error;
  }
}

async function resolveIncomingSource(
  source: IncomingSource,
  objects: GlobalObjectDraft[],
  existingObjects: ExistingObject[],
): Promise<GlobalObjectDraft[]> {
  if (!source.candidates.length) return objects;
  const deterministic = deterministicDecision(source.candidates, objects, existingObjects);
  let next = objects;
  if (deterministic.decision.groups.length) {
    next = applyGlobalDecision(next, source.candidates, deterministic.decision, existingObjects);
  }
  if (!deterministic.unresolved.length) return next;
  for (const candidate of deterministic.unresolved) {
    const candidateDrafts = shortlistDrafts([candidate], next).filter((draft) =>
      !source.preResolved || !draft.members.some((item) => item.runId === source.runId)
    );
    const candidateExisting = shortlistExisting([candidate], existingObjects);
    const decision: GlobalDecision = !candidateDrafts.length && !candidateExisting.length
      ? {
          groups: [{
            action: "create_new",
            incomingKeys: [candidate.key],
            canonicalLabel: candidate.label,
          }],
        }
      : await decideWithModel([candidate], candidateDrafts, candidateExisting);
    validateDecision(decision, [candidate], candidateDrafts, candidateExisting);
    next = applyGlobalDecision(next, [candidate], decision, existingObjects);
  }
  return next;
}

function globalArtifactRoot(): string {
  const configured = process.env.SYDARIS_COLD_START_OUTPUT_ROOT?.trim();
  if (configured) return path.normalize(/* turbopackIgnore: true */ configured);
  return path.join(/* turbopackIgnore: true */ process.cwd(), ".cold-start");
}

function safeGlobalArtifactPath(location: string): string | undefined {
  const prefix = "cold-start-global-resolution:";
  if (!location.startsWith(prefix)) return undefined;
  const resolved = path.normalize(/* turbopackIgnore: true */ location.slice(prefix.length));
  const root = globalArtifactRoot();
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("深度冷启动产物路径越出允许目录");
  }
  return resolved.endsWith(".json")
    ? resolved
    : path.join(/* turbopackIgnore: true */ resolved, "global-resolution.json");
}

async function deepCandidates(input: {
  runId: string;
  sourceSha256: string;
  sourceName: string;
  artifactLocation: string | null;
}): Promise<IncomingObjectCandidate[]> {
  if (!input.artifactLocation) return [];
  const artifactPath = safeGlobalArtifactPath(input.artifactLocation);
  if (!artifactPath) return [];
  const root = z.object({
    global_objects: z.array(z.object({
      global_object_id: z.string().uuid(),
      canonical_name: z.string().min(1),
    })),
  }).parse(JSON.parse(await readFile(/* turbopackIgnore: true */ artifactPath, "utf8")));
  return root.global_objects.map((object, index) => ({
    key: `${input.runId}:deep:${index}`,
    runId: input.runId,
    sourceName: input.sourceName,
    label: object.canonical_name,
    reason: "深度冷启动产生的 Global Object",
    action: "new_candidate" as const,
  }));
}

async function loadIncomingSources(jobId: string): Promise<IncomingSource[]> {
  const runs = await getDatabase().librarySourceProcessingRun.findMany({
    where: { jobId, status: "ready", sourceBlobId: { not: null } },
    orderBy: [{ phaseOrder: "asc" }, { createdAt: "asc" }],
    include: {
      libraryNode: { select: { name: true } },
      sourceBlob: { select: { sha256: true } },
      assessment: { select: { objectCandidates: true } },
    },
  });
  const sources: IncomingSource[] = [];
  for (const run of runs) {
    if (run.profile === "deep") {
      sources.push({
        runId: run.id,
        sourceBlobId: run.sourceBlobId!,
        sourceName: run.libraryNode.name,
        preResolved: true,
        candidates: await deepCandidates({
          runId: run.id,
          sourceSha256: run.sourceBlob!.sha256,
          sourceName: run.libraryNode.name,
          artifactLocation: run.artifactLocation,
        }),
      });
      continue;
    }
    const raw = Array.isArray(run.assessment?.objectCandidates)
      ? run.assessment.objectCandidates
      : [];
    const candidates = raw.flatMap((candidate, index) => {
      const parsed = libraryObjectCandidateSchema.safeParse(candidate);
      if (!parsed.success) return [];
      return [{
        key: `${run.id}:assessment:${index}`,
        runId: run.id,
        sourceName: run.libraryNode.name,
        label: parsed.data.label,
        reason: parsed.data.reason,
        action: parsed.data.action,
        ...(parsed.data.action === "bind_existing"
          ? { existingObjectId: parsed.data.existingObjectId }
          : {}),
      } satisfies IncomingObjectCandidate];
    });
    sources.push({
      runId: run.id,
      sourceBlobId: run.sourceBlobId!,
      sourceName: run.libraryNode.name,
      preResolved: false,
      candidates,
    });
  }
  return sources;
}

function inputFingerprint(
  sources: IncomingSource[],
  startingObjects: GlobalObjectDraft[],
): string {
  return createHash("sha256").update(JSON.stringify({
    sources,
    startingObjects,
  })).digest("hex");
}

function parsedGlobalObjects(value: unknown): GlobalObjectDraft[] {
  const parsed = z.array(globalObjectDraftSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function canPromoteLibraryRun(input: {
  sourceBlobId: string | null;
  status: string;
  stage: string;
}): boolean {
  return Boolean(
    input.sourceBlobId && input.status === "ready" && input.stage === "ready"
  );
}

async function activeObjectsBeforeSelectedSources(
  sources: IncomingSource[],
): Promise<{ activeObjects: GlobalObjectDraft[]; startingObjects: GlobalObjectDraft[] }> {
  const state = await getDatabase().libraryCompilationState.findUnique({
    where: { id: "default" },
    select: { globalObjects: true },
  });
  const activeObjects = parsedGlobalObjects(state?.globalObjects);
  const memberRunIds = [...new Set(activeObjects.flatMap((object) =>
    object.members.map((memberItem) => memberItem.runId)
  ))];
  if (!memberRunIds.length) return { activeObjects, startingObjects: activeObjects };
  const selectedBlobIds = new Set(sources.map((source) => source.sourceBlobId));
  const memberRuns = await getDatabase().librarySourceProcessingRun.findMany({
    where: { id: { in: memberRunIds } },
    select: { id: true, sourceBlobId: true },
  });
  const knownRunIds = new Set(memberRuns.map((run) => run.id));
  const replacedRunIds = new Set([
    ...memberRunIds.filter((runId) => !knownRunIds.has(runId)),
    ...memberRuns
      .filter((run) => run.sourceBlobId && selectedBlobIds.has(run.sourceBlobId))
      .map((run) => run.id),
  ]);
  return {
    activeObjects,
    startingObjects: withoutGlobalObjectRuns(activeObjects, replacedRunIds),
  };
}

async function promoteSuccessfulLibraryResults(
  jobId: string,
  resolvedObjects: GlobalObjectDraft[],
): Promise<GlobalObjectDraft[]> {
  const database = getDatabase();
  const [state, runs, job] = await Promise.all([
    database.libraryCompilationState.findUnique({
      where: { id: "default" },
      select: { globalObjects: true },
    }),
    database.librarySourceProcessingRun.findMany({
      where: { jobId },
      select: {
        id: true,
        sourceBlobId: true,
        status: true,
        stage: true,
      },
    }),
    database.libraryCompilationJob.findUnique({
      where: { id: jobId },
      select: { globalResult: true },
    }),
  ]);
  if (!job) throw new Error("基础编译任务不存在");
  const promotedRuns = runs.filter(canPromoteLibraryRun);
  const promotedRunIds = new Set(promotedRuns.map((run) => run.id));
  const promotedBlobIds = new Set(promotedRuns.flatMap((run) =>
    run.sourceBlobId ? [run.sourceBlobId] : []
  ));
  const sharedMemory = await publishLibraryRunsToSharedMemory({
    jobId,
    resolvedObjects,
  });
  const activeObjects = parsedGlobalObjects(state?.globalObjects);
  const activeMemberRunIds = [...new Set(activeObjects.flatMap((object) =>
    object.members.map((memberItem) => memberItem.runId)
  ))];
  const activeMemberRuns = activeMemberRunIds.length
    ? await database.librarySourceProcessingRun.findMany({
        where: { id: { in: activeMemberRunIds } },
        select: { id: true, sourceBlobId: true },
      })
    : [];
  const knownActiveRunIds = new Set(activeMemberRuns.map((run) => run.id));
  const replacedRunIds = new Set([
    ...activeMemberRunIds.filter((runId) => !knownActiveRunIds.has(runId)),
    ...activeMemberRuns
      .filter((run) => run.sourceBlobId && promotedBlobIds.has(run.sourceBlobId))
      .map((run) => run.id),
  ]);
  const retainedObjects = withoutGlobalObjectRuns(activeObjects, replacedRunIds);
  const promotedObjects = onlyGlobalObjectRuns(resolvedObjects, promotedRunIds);
  const currentObjects = mergeGlobalObjectDrafts(retainedObjects, promotedObjects);
  const previousResult = job.globalResult && typeof job.globalResult === "object" &&
      !Array.isArray(job.globalResult)
    ? job.globalResult
    : {};
  const currentResult = {
    ...previousResult,
    version: "library-global-resolution-result.v4",
    objectCount: currentObjects.length,
    boundExistingCount: currentObjects.filter((item) => item.existingObjectId).length,
    newDraftObjectCount: currentObjects.filter((item) => !item.existingObjectId).length,
    sourceCount: new Set(currentObjects.flatMap((item) =>
      item.members.map((memberItem) => memberItem.runId)
    )).size,
    memberCount: currentObjects.reduce((total, item) => total + item.members.length, 0),
    objects: currentObjects,
    sharedMemory,
  };
  const supersededRuns = promotedBlobIds.size
    ? await database.librarySourceProcessingRun.findMany({
        where: {
          sourceBlobId: { in: [...promotedBlobIds] },
          id: { notIn: [...promotedRunIds] },
        },
        select: { id: true, jobId: true },
      })
    : [];
  const supersededJobIds = [...new Set(supersededRuns.flatMap((run) =>
    run.jobId && run.jobId !== jobId ? [run.jobId] : []
  ))];
  await database.$transaction(async (transaction) => {
    if (supersededRuns.length) {
      await transaction.librarySourceProcessingRun.deleteMany({
        where: { id: { in: supersededRuns.map((run) => run.id) } },
      });
    }
    if (promotedRunIds.size) {
      await transaction.librarySourceProcessingRun.updateMany({
        where: { id: { in: [...promotedRunIds] } },
        data: {
          isCurrent: true,
          checkpoint: { version: "library-run-checkpoint.released.v1" },
        },
      });
    }
    await transaction.libraryCompilationState.upsert({
      where: { id: "default" },
      update: { globalObjects: currentObjects },
      create: { id: "default", globalObjects: currentObjects },
    });
    await transaction.libraryCompilationJob.update({
      where: { id: jobId },
      data: {
        globalCheckpoint: {},
        globalResult: currentResult,
        globalStatusMessage: `已发布到 Shared Brain：${sharedMemory.assertionCount} 条 Assertion、${sharedMemory.objectCount} 个 Object`,
      },
    });
    for (const oldJobId of supersededJobIds) {
      await transaction.librarySourceProcessingRun.updateMany({
        where: { jobId: oldJobId, isCurrent: true },
        data: { jobId: null },
      });
      await transaction.libraryCompilationJob.delete({ where: { id: oldJobId } });
    }
  });
  return currentObjects;
}

async function loadExistingObjects(): Promise<ExistingObject[]> {
  const objects = await getDatabase().memoryGlobalObject.findMany({
    select: {
      id: true,
      canonicalName: true,
      surfaceMemberships: {
        select: {
          surfaceFormOrdinal: true,
          objectFragment: { select: { surfaceForms: true } },
        },
      },
      chatMentions: { select: { surfaceForm: true } },
    },
    orderBy: { globalObjectKey: "asc" },
  });
  return objects.map((object) => ({
    id: object.id,
    canonicalName: object.canonicalName,
    surfaceForms: [...new Set([
      object.canonicalName,
      ...object.surfaceMemberships.map((membership) =>
        membership.objectFragment.surfaceForms[membership.surfaceFormOrdinal]
      ).filter((value): value is string => Boolean(value)),
      ...object.chatMentions.map((mention) => mention.surfaceForm),
    ])],
  }));
}

async function reconcileCompilationOutcomes(
  jobId: string,
  objects: GlobalObjectDraft[],
): Promise<void> {
  const database = getDatabase();
  const resolvedMemberKeys = new Set(
    objects.flatMap((object) => object.members.map((item) => item.key)),
  );
  const runs = await database.librarySourceProcessingRun.findMany({
    where: { jobId, status: "ready", assessment: { isNot: null } },
    select: {
      id: true,
      sourceBlobId: true,
      assessment: {
        select: {
          objectCandidates: true,
        },
      },
    },
  });
  if (!runs.length) return;
  await database.$transaction(async (transaction) => {
    for (const run of runs) {
      if (!run.assessment) continue;
      const outcome = failureAfterGlobalResolution({
        runId: run.id,
        objectCandidates: run.assessment.objectCandidates,
        resolvedMemberKeys,
      });
      await transaction.librarySourceProcessingRun.update({
        where: { id: run.id },
        data: {
          status: outcome.failed ? "failed" : "ready",
          stage: outcome.failed ? "failed" : "ready",
          statusMessage: outcome.failed
            ? "Global Object 归并失败"
            : "Global Object 已归并，编译成功",
          errorMessage: outcome.failed ? outcome.reasons.join("；") : null,
        },
      });
      if (run.sourceBlobId) {
        await transaction.libraryNode.updateMany({
          where: { blobId: run.sourceBlobId },
          data: { processingStatus: outcome.failed ? "failed" : "ready" },
        });
      }
    }
  });
}

export async function processLibraryGlobalResolution(jobId: string): Promise<boolean> {
  const database = getDatabase();
  const [job, sources, existingObjects] = await Promise.all([
    database.libraryCompilationJob.findUnique({
      where: { id: jobId },
      select: { globalCheckpoint: true },
    }),
    loadIncomingSources(jobId),
    loadExistingObjects(),
  ]);
  if (!job) throw new Error("基础编译任务不存在");
  const { startingObjects } = await activeObjectsBeforeSelectedSources(sources);
  const fingerprint = inputFingerprint(sources, startingObjects);
  const parsedCheckpoint = globalCheckpointSchema.safeParse(job.globalCheckpoint);
  let checkpoint: GlobalCheckpoint = parsedCheckpoint.success
    ? parsedCheckpoint.data
    : {
        version: "library-global-resolution.v3",
        inputFingerprint: fingerprint,
        nextSourceIndex: 0,
        objects: startingObjects,
      };
  if (checkpoint.inputFingerprint !== fingerprint) {
    throw new Error("基础编译文件集合已变化，不能复用原 Global Object checkpoint");
  }
  if (checkpoint.nextSourceIndex > sources.length) {
    throw new Error("Global Object checkpoint 游标越界");
  }
  await database.libraryCompilationJob.update({
    where: { id: jobId },
    data: {
      globalStatus: "running",
      globalProgress: checkpoint.nextSourceIndex,
      globalTotal: sources.length,
      globalStatusMessage: checkpoint.nextSourceIndex
        ? `从第 ${checkpoint.nextSourceIndex + 1} 个文件 checkpoint 继续`
        : "逐文件归并 Object 草稿",
    },
  });
  for (let index = checkpoint.nextSourceIndex; index < sources.length; index += 1) {
    const control = await database.libraryCompilationJob.findUnique({
      where: { id: jobId },
      select: { pauseRequested: true },
    });
    if (!control || control.pauseRequested) return false;
    const source = sources[index];
    await database.libraryCompilationJob.update({
      where: { id: jobId },
      data: {
        globalStatusMessage: `解析 ${index + 1}/${sources.length}：${source.sourceName}`,
      },
    });
    const objects = await resolveIncomingSource(source, checkpoint.objects, existingObjects);
    checkpoint = { ...checkpoint, nextSourceIndex: index + 1, objects };
    await database.libraryCompilationJob.update({
      where: { id: jobId },
      data: {
        globalCheckpoint: checkpoint,
        globalProgress: index + 1,
        globalStatusMessage: `已保存 ${index + 1}/${sources.length} 个文件的 Object checkpoint`,
        globalErrorMessage: null,
      },
    });
  }
  const boundExistingCount = checkpoint.objects.filter((item) => item.existingObjectId).length;
  const result = {
    version: "library-global-resolution-result.v3",
    objectCount: checkpoint.objects.length,
    boundExistingCount,
    newDraftObjectCount: checkpoint.objects.length - boundExistingCount,
    sourceCount: sources.length,
    memberCount: checkpoint.objects.reduce((total, item) => total + item.members.length, 0),
    objects: checkpoint.objects,
  };
  await database.libraryCompilationJob.update({
    where: { id: jobId },
    data: {
      globalStatus: "ready",
      globalProgress: sources.length,
      globalTotal: sources.length,
      globalStatusMessage: `跨文件 Object 草稿完成：${checkpoint.objects.length} 个 Object`,
      globalErrorMessage: null,
      globalResult: result,
    },
  });
  await reconcileCompilationOutcomes(jobId, checkpoint.objects);
  await promoteSuccessfulLibraryResults(jobId, checkpoint.objects);
  return true;
}
