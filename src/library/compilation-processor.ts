import {
  extractJsonMiddleware,
  generateText,
  NoObjectGeneratedError,
  Output,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";

import { getChatModel, getVisionModel } from "@/ai/provider";
import { getDatabase } from "@/db";
import {
  textModelConcurrency,
  visionModelConcurrency,
} from "@/library/compilation-concurrency";
import {
  libraryCatalogCompilationOutputSchema,
  libraryCoarseCompilationOutputSchema,
  libraryCompilationAssessmentSchema,
  libraryVisualObservationOutputSchema,
  type LibraryCatalogCompilationOutput,
  type LibraryCompilationAssessment,
  type LibraryCoarseCompilationOutput,
  type LibraryVisualObservationOutput,
} from "@/library/compilation-types";
import { runDeepColdStart } from "@/library/deep-compilation-worker";
import { extractLibraryPreview, type LibraryPreview } from "@/library/preview-extractor";

export class ModelInFlightGate {
  private active = 0;
  private readonly queue: Array<(release: () => void) => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("模型在途请求上限必须大于 0");
  }

  get activeCount(): number {
    return this.active;
  }

  async acquire(onQueued?: (position: number) => void | Promise<void>): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseHandle();
    }
    const position = this.queue.length + 1;
    const lease = new Promise<() => void>((resolve) => this.queue.push(resolve));
    await onQueued?.(position);
    return lease;
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(this.releaseHandle());
      else this.active -= 1;
    };
  }
}

const modelRuntime = globalThis as typeof globalThis & {
  libraryModelRuntime?: {
    nextTextCallAt: number;
    nextVisionCallAt: number;
    gates: Map<string, ModelInFlightGate>;
  };
};

function runtime() {
  modelRuntime.libraryModelRuntime ??= {
    nextTextCallAt: 0,
    nextVisionCallAt: 0,
    gates: new Map(),
  };
  return modelRuntime.libraryModelRuntime;
}

function structuredTextModel() {
  return wrapLanguageModel({
    model: getChatModel(),
    middleware: extractJsonMiddleware(),
  });
}

function structuredVisionModel() {
  return wrapLanguageModel({
    model: getVisionModel(),
    middleware: extractJsonMiddleware(),
  });
}

export function parseEmbeddedModelJson<T>(
  text: string | undefined,
  schema: z.ZodType<T>,
): T | undefined {
  if (!text?.trim()) return undefined;
  const withoutFence = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const candidates = [withoutFence];
  const objectStart = withoutFence.indexOf("{");
  const objectEnd = withoutFence.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(withoutFence.slice(objectStart, objectEnd + 1));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = schema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next bounded candidate. Schema validation remains mandatory.
    }
  }
  return undefined;
}

function enrichedObjectError(error: unknown): Error {
  if (!NoObjectGeneratedError.isInstance(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const rawExcerpt = error.text?.trim().slice(0, 2_000);
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return new Error([
    error.message,
    error.finishReason ? `finishReason=${error.finishReason}` : undefined,
    cause ? `cause=${cause}` : undefined,
    rawExcerpt ? `rawResponse=${rawExcerpt}` : "rawResponse=<empty>",
  ].filter(Boolean).join("；"), { cause: error });
}

type ModelRequestKind = "text" | "vision";

function modelGate(kind: ModelRequestKind): ModelInFlightGate {
  const limit = kind === "text" ? textModelConcurrency() : visionModelConcurrency();
  const key = `${kind}:${limit}`;
  const state = runtime();
  let gate = state.gates.get(key);
  if (!gate) {
    gate = new ModelInFlightGate(limit);
    state.gates.set(key, gate);
  }
  return gate;
}

async function waitForModelStart(
  kind: ModelRequestKind,
  onWaiting?: (message: string) => void | Promise<void>,
): Promise<void> {
  const configured = Number(kind === "vision"
    ? process.env.AI_VISION_REQUESTS_PER_MINUTE ?? 10
    : process.env.AI_REQUESTS_PER_MINUTE ?? 18);
  const rpm = Number.isFinite(configured) ? Math.max(1, configured) : kind === "vision" ? 10 : 18;
  const interval = Math.ceil(60_000 / rpm);
  const now = Date.now();
  const state = runtime();
  const scheduledAt = Math.max(
    now,
    kind === "vision" ? state.nextVisionCallAt : state.nextTextCallAt,
  );
  if (kind === "vision") state.nextVisionCallAt = scheduledAt + interval;
  else state.nextTextCallAt = scheduledAt + interval;
  const wait = scheduledAt - now;
  if (wait) await onWaiting?.(`等待${kind === "vision" ? "视觉" : "文字"}模型 RPM 时隙：约 ${Math.ceil(wait / 1_000)} 秒`);
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function withModelRequest<T>(input: {
  kind: ModelRequestKind;
  onWaiting?: (message: string) => void | Promise<void>;
  onStarted?: (active: number, limit: number) => void | Promise<void>;
  request: () => Promise<T>;
}): Promise<T> {
  await waitForModelStart(input.kind, input.onWaiting);
  const gate = modelGate(input.kind);
  const release = await gate.acquire(async (position) => {
    await input.onWaiting?.(
      `等待${input.kind === "vision" ? "视觉" : "文字"}模型并发槽位：队列第 ${position} 位，上限 ${gate.limit}`,
    );
  });
  try {
    await input.onStarted?.(gate.activeCount, gate.limit);
    return await input.request();
  } finally {
    release();
  }
}

async function findProcessingRun(runId: string) {
  return getDatabase().librarySourceProcessingRun.findUnique({
    where: { id: runId },
    include: { libraryNode: true, sourceBlob: true },
  });
}

type RawProcessingRun = NonNullable<Awaited<ReturnType<typeof findProcessingRun>>>;
type ProcessingRun = Omit<RawProcessingRun, "sourceBlob"> & {
  sourceBlob: NonNullable<RawProcessingRun["sourceBlob"]>;
};

const storedPreviewSchema = z.object({
  parser: z.string(),
  text: z.string().optional(),
  sourceKind: z.enum(["text_excerpt", "visual_observation"]),
  warning: z.string().optional(),
});

const runCheckpointSchema = z.object({
  version: z.literal("library-run-checkpoint.v1"),
  extractedPreview: storedPreviewSchema.optional(),
  semanticPreview: storedPreviewSchema.optional(),
  assessment: libraryCompilationAssessmentSchema.optional(),
  modelRetries: z.object({
    text: z.number().int().nonnegative().default(0),
    vision: z.number().int().nonnegative().default(0),
    lastError: z.string().optional(),
    lastFailedAt: z.string().optional(),
  }).optional(),
  deep: z.object({
    ownerRunId: z.string().uuid(),
    sourcePath: z.string().optional(),
    explorationRun: z.string().optional(),
    sourceCompilation: z.string().optional(),
    globalResolution: z.string().optional(),
    globalAssertions: z.string().optional(),
    parallelUnits: z.array(z.object({
      id: z.string(),
      kind: z.enum(["source", "global_object"]),
      statusMessage: z.string(),
    })).max(32).optional(),
  }).optional(),
});

type RunCheckpoint = z.infer<typeof runCheckpointSchema>;

type ModelRetryEvent = {
  kind: ModelRequestKind;
  error: string;
};

type ModelRetryReporter = (event: ModelRetryEvent) => Promise<void>;

function loadRunCheckpoint(run: ProcessingRun): RunCheckpoint {
  const parsed = runCheckpointSchema.safeParse(run.checkpoint);
  return parsed.success ? parsed.data : { version: "library-run-checkpoint.v1" };
}

function storablePreview(preview: LibraryPreview): z.infer<typeof storedPreviewSchema> {
  return {
    parser: preview.parser,
    ...(preview.text ? { text: preview.text } : {}),
    sourceKind: preview.sourceKind,
    ...(preview.warning ? { warning: preview.warning } : {}),
  };
}

async function saveRunCheckpoint(runId: string, checkpoint: RunCheckpoint): Promise<void> {
  await updateRun(runId, { checkpoint });
}

async function loadProcessingRun(runId: string): Promise<ProcessingRun> {
  const run = await findProcessingRun(runId);
  if (!run?.sourceBlob) throw new Error("处理运行缺少内容对象");
  return run as ProcessingRun;
}

async function updateRun(
  runId: string,
  data: Parameters<ReturnType<typeof getDatabase>["librarySourceProcessingRun"]["update"]>[0]["data"],
) {
  await getDatabase().librarySourceProcessingRun.update({ where: { id: runId }, data });
}

async function existingObjectCandidates(searchText: string) {
  const objects = await getDatabase().memoryGlobalObject.findMany({
    select: { id: true, canonicalName: true },
    take: 2_000,
  });
  const normalized = searchText.normalize("NFKC").toLocaleLowerCase("zh-CN");
  return objects
    .filter((object) =>
      object.canonicalName.length >= 2 &&
      normalized.includes(object.canonicalName.normalize("NFKC").toLocaleLowerCase("zh-CN"))
    )
    .slice(0, 30);
}

export type LibraryEvidenceBlock = {
  id: string;
  text: string;
  sourceKind: "text_excerpt" | "visual_observation" | "file_context";
};

function evidenceChunks(text: string, maxChars = 1_800): string[] {
  return text.split(/\n{2,}/u).flatMap((paragraph) => {
    const trimmed = paragraph.trim();
    if (!trimmed) return [];
    const chunks: string[] = [];
    for (let start = 0; start < trimmed.length; start += maxChars) {
      const chunk = trimmed.slice(start, start + maxChars).trim();
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  });
}

export function buildLibraryEvidenceCatalog(input: {
  previewText?: string;
  previewSourceKind: "text_excerpt" | "visual_observation";
  fileName: string;
  originalRelativePath?: string | null;
}): LibraryEvidenceBlock[] {
  const content = evidenceChunks(input.previewText ?? "").map((text, index) => ({
    id: `S${String(index + 1).padStart(4, "0")}`,
    text,
    sourceKind: input.previewSourceKind,
  }));
  const context: LibraryEvidenceBlock[] = [{
    id: "F0001",
    text: input.fileName,
    sourceKind: "file_context",
  }];
  if (input.originalRelativePath && input.originalRelativePath !== input.fileName) {
    context.push({
      id: "F0002",
      text: input.originalRelativePath,
      sourceKind: "file_context",
    });
  }
  return [...context, ...content];
}

function normalizeCandidateLabel(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

export function materializeLibraryAssessment(input: ({
  profile: "coarse";
  output: LibraryCoarseCompilationOutput;
} | {
  profile: "catalog";
  output: LibraryCatalogCompilationOutput;
}) & {
  evidence: LibraryEvidenceBlock[];
  existingObjects: Array<{ id: string; canonicalName: string }>;
}): LibraryCompilationAssessment {
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const source = (sourceId: string, assertion: boolean) => {
    const block = evidenceById.get(sourceId);
    if (!block) throw new Error(`模型引用了未提供的证据编号 ${sourceId}`);
    if (assertion && block.sourceKind === "file_context") {
      throw new Error(`grounded Assertion 不能使用文件路径证据 ${sourceId}`);
    }
    return block;
  };
  const assertions = input.profile === "coarse" ? input.output.assertionCandidates : [];
  const labels = [
    ...input.output.referenceCandidates.flatMap((item) => item.objectLabels),
    ...assertions.flatMap((item) => item.objectLabels),
  ];
  const canonicalLabels = new Map<string, string>();
  for (const label of labels) {
    const normalized = normalizeCandidateLabel(label);
    if (!canonicalLabels.has(normalized)) canonicalLabels.set(normalized, label.trim());
  }
  const canonicalizeLabels = (values: string[]) => [...new Set(values.map((label) =>
    canonicalLabels.get(normalizeCandidateLabel(label)) ?? label.trim()
  ))];
  const existingByLabel = new Map(input.existingObjects.map((object) => [
    normalizeCandidateLabel(object.canonicalName),
    object,
  ]));
  return libraryCompilationAssessmentSchema.parse({
    summary: input.output.summary,
    referenceCandidates: input.output.referenceCandidates.map((candidate) => {
      const block = source(candidate.sourceId, false);
      return {
        statement: candidate.statement,
        sourceExcerpt: block.text,
        sourceKind: block.sourceKind,
        objectLabels: canonicalizeLabels(candidate.objectLabels),
      };
    }),
    assertionCandidates: assertions.map((candidate) => ({
      statement: candidate.statement,
      sourceExcerpt: source(candidate.sourceId, true).text,
      objectLabels: canonicalizeLabels(candidate.objectLabels),
      contextDependent: candidate.contextDependent,
    })),
    objectCandidates: [...canonicalLabels].map(([normalized, label]) => {
      const existing = existingByLabel.get(normalized);
      return existing
        ? {
            label,
            action: "bind_existing",
            existingObjectId: existing.id,
            reason: `名称与已有 Object“${existing.canonicalName}”精确匹配`,
          }
        : {
            label,
            action: "new_candidate",
            reason: "来源中的主要 Object 名称，等待 Global Object 归并",
          };
    }),
  });
}

export function coarseCompilationInstructions(): string[] {
  return [
    "人已经选择对此文件进行粗编译；不要重新判断处理档位，也不要输出你的分析过程。",
    "请顺着文档自身的结构，将内容分成少量有意义的大主题，并为每个主题生成一条 Reference Assertion。优先沿用原文标题；不要逐句拆分，也不要把明显不同的主题强行合并。",
    "另外提取能够脱离文档上下文单独使用的重要事实作为 grounded Assertion。由文档内容决定提取多少，不必凑数。",
    "为 Reference 和 Assertion 标注正文明确出现的主要活动、组织、地点、角色或文件主题 Object 名称，不要猜测。",
  ];
}

export function sourceExcerptMatchesPreview(excerpt: string, previewText: string): boolean {
  if (previewText.includes(excerpt)) return true;
  const normalizeEvidence = (value: string) => value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/[\s*_`#>]/gu, "");
  const normalizedExcerpt = normalizeEvidence(excerpt);
  return normalizedExcerpt.length >= 8 && normalizeEvidence(previewText).includes(normalizedExcerpt);
}

function semanticPrompt(input: {
  run: ProcessingRun;
  preview: LibraryPreview;
  existingObjects: Awaited<ReturnType<typeof existingObjectCandidates>>;
  evidence: LibraryEvidenceBlock[];
}): string {
  const coarse = input.run.profile === "coarse";
  return [
    `你正在为 Sydaris 资料库执行${coarse ? "粗编译" : "仅归档的轻量语义编目"}。`,
    "文件名和目录只作归档上下文；正文中的事实必须有正文原文支持。无法确认的内容不要输出。",
    ...(input.preview.sourceKind === "visual_observation"
      ? ["来源预览是独立视觉模型产生的 OCR 与视觉观察记录；你没有看到原图，不得补充、改写或猜测记录之外的画面内容。"]
      : []),
    ...(coarse
      ? coarseCompilationInstructions()
      : [
        "只做轻量语义编目，不提取 grounded Assertion。",
        "如果内容有可供检索的具体语义，生成 Reference 并标注它涉及的 Object 名称；否则返回空的 referenceCandidates。",
      ]),
    "每条 Reference 或 Assertion 只选择一个最直接的 sourceId；只能使用证据目录中存在的编号，不要抄写原文。grounded Assertion 不得使用 F 开头的文件语境证据。",
    "objectLabels 只写对象名称，不要写 action、Object ID 或其他协议字段。如果与已有 Object 候选明确同指，优先逐字使用其 canonicalName。",
    "summary 只概括文档内容，不要描述任务、输出格式、失败原因或纠正过程。",
    `文件名：${input.run.libraryNode.name}`,
    `导入相对路径：${input.run.libraryNode.originalRelativePath ?? "未知"}`,
    `MIME：${input.run.sourceBlob.mimeType}`,
    `预览解析器：${input.preview.parser}`,
    `已有 Object 候选：${JSON.stringify(input.existingObjects)}`,
    `\n证据目录：\n${input.evidence.map((item) => `[${item.id}] ${item.text}`).join("\n\n")}`,
  ].join("\n");
}

function sourceExcerptIsValid(input: {
  excerpt: string;
  sourceKind?: "text_excerpt" | "visual_observation" | "file_context";
  preview: LibraryPreview;
  run: ProcessingRun;
}): boolean {
  if (input.sourceKind === "file_context") {
    return [input.run.libraryNode.name, input.run.libraryNode.originalRelativePath]
      .some((context) => context?.includes(input.excerpt));
  }
  return Boolean(
    input.preview.text && sourceExcerptMatchesPreview(input.excerpt, input.preview.text)
  );
}

function validateAssessment(
  output: LibraryCompilationAssessment,
  input: {
    run: ProcessingRun;
    preview: LibraryPreview;
    existingObjectIds: Set<string>;
  },
): LibraryCompilationAssessment {
  const problems: string[] = [];
  for (const [index, candidate] of output.referenceCandidates.entries()) {
    if (!sourceExcerptIsValid({
      excerpt: candidate.sourceExcerpt,
      sourceKind: candidate.sourceKind,
      preview: input.preview,
      run: input.run,
    })) problems.push(`Reference ${index + 1} 的 sourceExcerpt 不在来源中`);
  }
  for (const [index, candidate] of output.assertionCandidates.entries()) {
    if (!sourceExcerptIsValid({
      excerpt: candidate.sourceExcerpt,
      preview: input.preview,
      run: input.run,
    })) problems.push(`Assertion ${index + 1} 的 sourceExcerpt 不在来源中`);
  }

  const normalizeLabel = (value: string) =>
    value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  const objectByLabel = new Map<string, (typeof output.objectCandidates)[number]>();
  for (const candidate of output.objectCandidates) {
    const label = normalizeLabel(candidate.label);
    if (objectByLabel.has(label)) problems.push(`Object ${candidate.label} 重复输出`);
    objectByLabel.set(label, candidate);
    if (
      candidate.action === "bind_existing" &&
      !input.existingObjectIds.has(candidate.existingObjectId)
    ) {
      problems.push(`Object ${candidate.label} 绑定了未提供的已有 Object`);
    }
  }

  const referencedObjectLabels = new Set<string>();
  for (const candidate of [
    ...output.referenceCandidates,
    ...output.assertionCandidates,
  ]) {
    if (input.run.profile === "catalog" && !candidate.objectLabels.length) {
      problems.push("Reference 没有关联 Object");
    }
    for (const rawLabel of candidate.objectLabels) {
      const label = normalizeLabel(rawLabel);
      referencedObjectLabels.add(label);
      if (!objectByLabel.has(label)) {
        problems.push(`候选引用了未输出的 Object ${rawLabel}`);
      }
    }
  }
  for (const [label, candidate] of objectByLabel) {
    if (!referencedObjectLabels.has(label)) {
      problems.push(`Object ${candidate.label} 没有被 Reference 或 Assertion 使用`);
    }
  }
  if (input.run.profile === "coarse") {
    if (!output.referenceCandidates.length) problems.push("没有生成 Reference Assertion");
    if (!output.objectCandidates.length) problems.push("没有生成 Object");
  } else if (
    Boolean(output.referenceCandidates.length) !== Boolean(output.objectCandidates.length)
  ) {
    problems.push("仅归档的 Reference 和 Object 必须同时为空或同时存在");
  }

  if (problems.length) {
    const label = input.run.profile === "coarse" ? "粗编译" : "仅归档";
    throw new Error(`${label}结果未形成有效闭环：${[...new Set(problems)].slice(0, 8).join("；")}`);
  }
  return output;
}

function visualObservationPrompt(run: ProcessingRun): string {
  return [
    "你是 Sydaris 资料库的视觉转文字阶段，只负责忠实观察图片，不负责组织知识编译。",
    "请提取清晰可见的文字，并描述画面中可直接确认的场景、物体、人数范围、版式或关系。",
    "无法确认的人名、身份、活动名称和时间必须放入 uncertainties，不能根据文件名或目录猜测。",
    "文件名与目录仅帮助理解拍摄语境，不是图片内容证据。",
    "visibleText 尽量保持图片中的原始文字和顺序；没有可见文字时返回空字符串。",
    `文件名：${run.libraryNode.name}`,
    `导入相对路径：${run.libraryNode.originalRelativePath ?? "未知"}`,
    `MIME：${run.sourceBlob.mimeType}`,
  ].join("\n");
}

export function renderVisualObservation(
  observation: LibraryVisualObservationOutput,
  modelId: string,
): string {
  return [
    `[视觉模型：${modelId}]`,
    "[视觉摘要]",
    observation.summary,
    "[可见文字 / OCR]",
    observation.visibleText || "（未识别到清晰文字）",
    "[可直接确认的视觉观察]",
    ...(observation.observations.length
      ? observation.observations.map((item) =>
          `- ${item.statement}${item.evidenceRegion ? `（位置：${item.evidenceRegion}）` : ""}`
        )
      : ["- 无"]),
    "[不确定性]",
    ...(observation.uncertainties.length
      ? observation.uncertainties.map((item) => `- ${item}`)
      : ["- 无"]),
  ].join("\n");
}

async function observeImageWithVisionModel(
  run: ProcessingRun,
  preview: LibraryPreview,
  onModelRetry: ModelRetryReporter,
): Promise<LibraryPreview> {
  if (!preview.image) return preview;
  const modelId = process.env.AI_VISION_MODEL?.trim();
  if (!modelId) throw new Error("AI_VISION_MODEL is not configured");
  const basePrompt = visualObservationPrompt(run);
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\n上一次输出未通过结构校验：${lastError.slice(0, 800)}\n请重新生成一份完整结果，不要续写或解释上一次输出。`;
    try {
      const output = await withModelRequest({
        kind: "vision",
        onWaiting: (message) => updateRun(run.id, { statusMessage: message }),
        onStarted: (active, limit) => updateRun(run.id, {
          statusMessage: `视觉模型正在 thinking / 输出 · 在途 ${active}/${limit}`,
        }),
        request: async () => {
          try {
            const result = await generateText({
              model: structuredVisionModel(),
              messages: [{
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  {
                    type: "file",
                    data: preview.image!,
                    mediaType: preview.imageMediaType ?? run.sourceBlob.mimeType,
                  },
                ],
              }],
              output: Output.object({
                schema: libraryVisualObservationOutputSchema,
                name: "library_visual_observation",
                description: "只把图片转换为带不确定性标记的 OCR 和视觉观察文字",
              }),
              temperature: 0,
              maxOutputTokens: 4_000,
            });
            return result.output;
          } catch (error) {
            if (NoObjectGeneratedError.isInstance(error)) {
              const recovered = parseEmbeddedModelJson(
                error.text,
                libraryVisualObservationOutputSchema,
              );
              if (recovered) return recovered;
            }
            throw enrichedObjectError(error);
          }
        },
      });
      return {
        parser: "vision-to-text",
        text: renderVisualObservation(output, modelId),
        sourceKind: "visual_observation",
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      lastError = failure.message;
      if (attempt === 2) throw failure;
      await onModelRetry({ kind: "vision", error: lastError });
    }
  }
  throw new Error("视觉模型未形成可用输出");
}

async function persistVisualIntermediate(
  run: ProcessingRun,
  preview: LibraryPreview,
): Promise<void> {
  const summary = "视觉模型已完成 OCR 与画面观察，等待普通文字模型进行语义编译。";
  await getDatabase().libraryCatalogAssessment.upsert({
    where: { processingRunId: run.id },
    update: {
      summary,
      previewExcerpt: preview.text?.slice(0, 8_000),
      referenceCandidates: [],
      assertionCandidates: [],
      objectCandidates: [],
    },
    create: {
      processingRunId: run.id,
      sourceBlobId: run.sourceBlob.id,
      representativeNodeId: run.libraryNode.id,
      summary,
      previewExcerpt: preview.text?.slice(0, 8_000),
      referenceCandidates: [],
      assertionCandidates: [],
      objectCandidates: [],
    },
  });
}

async function analyzeWithTextModel(
  run: ProcessingRun,
  preview: LibraryPreview,
  onModelRetry: ModelRetryReporter,
): Promise<LibraryCompilationAssessment> {
  const searchText = [run.libraryNode.name, run.libraryNode.originalRelativePath, preview.text]
    .filter(Boolean)
    .join("\n");
  const existingObjects = await existingObjectCandidates(searchText);
  const evidence = buildLibraryEvidenceCatalog({
    previewText: preview.text,
    previewSourceKind: preview.sourceKind,
    fileName: run.libraryNode.name,
    originalRelativePath: run.libraryNode.originalRelativePath,
  });
  const basePrompt = semanticPrompt({ run, preview, existingObjects, evidence });
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\n上一次输出未通过结构或证据编号校验：${lastError.slice(0, 1_000)}\n请只根据原始输入重新生成一份完整结果；summary 只概括文档内容，不要续写、修补或解释上一次输出。`;
    try {
      const output = await withModelRequest({
        kind: "text",
        onWaiting: (message) => updateRun(run.id, { statusMessage: message }),
        onStarted: (active, limit) => updateRun(run.id, {
          statusMessage: `文字模型正在 thinking / 输出 · 在途 ${active}/${limit}`,
        }),
        request: async (): Promise<
          LibraryCoarseCompilationOutput | LibraryCatalogCompilationOutput
        > => {
          try {
            if (run.profile === "coarse") {
              const result = await generateText({
                model: structuredTextModel(),
                messages: [{ role: "user", content: prompt }],
                output: Output.object({
                  schema: libraryCoarseCompilationOutputSchema,
                  name: "coarse_library_compilation",
                  description: "选择证据编号，生成粗粒度 Reference、可选 grounded Assertion 与 Object 名称",
                }),
                temperature: 0.1,
                maxOutputTokens: 6_000,
              });
              return result.output;
            }
            const result = await generateText({
              model: structuredTextModel(),
              messages: [{ role: "user", content: prompt }],
              output: Output.object({
                schema: libraryCatalogCompilationOutputSchema,
                name: "catalog_library_compilation",
                description: "选择证据编号生成轻量 Reference 和 Object 名称，或返回空结果",
              }),
              temperature: 0.1,
              maxOutputTokens: 3_000,
            });
            return result.output;
          } catch (error) {
            if (NoObjectGeneratedError.isInstance(error)) {
              const schema = run.profile === "coarse"
                ? libraryCoarseCompilationOutputSchema
                : libraryCatalogCompilationOutputSchema;
              const recovered = parseEmbeddedModelJson(error.text, schema);
              if (recovered) return recovered;
            }
            throw enrichedObjectError(error);
          }
        },
      });
      const assessment = run.profile === "coarse"
        ? materializeLibraryAssessment({
            profile: "coarse",
            output: output as LibraryCoarseCompilationOutput,
            evidence,
            existingObjects,
          })
        : materializeLibraryAssessment({
            profile: "catalog",
            output: output as LibraryCatalogCompilationOutput,
            evidence,
            existingObjects,
          });
      return validateAssessment(assessment, {
        run,
        preview,
        existingObjectIds: new Set(existingObjects.map((object) => object.id)),
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      lastError = failure.message;
      if (attempt === 2) throw failure;
      await onModelRetry({ kind: "text", error: lastError });
    }
  }
  throw new Error("文字模型未形成可用输出");
}

async function persistAssessment(
  run: ProcessingRun,
  preview: LibraryPreview,
  assessment: LibraryCompilationAssessment,
) {
  await getDatabase().libraryCatalogAssessment.upsert({
    where: { processingRunId: run.id },
    update: {
      summary: assessment.summary,
      previewExcerpt: preview.text?.slice(0, 8_000),
      referenceCandidates: assessment.referenceCandidates,
      assertionCandidates: assessment.assertionCandidates,
      objectCandidates: assessment.objectCandidates,
    },
    create: {
      processingRunId: run.id,
      sourceBlobId: run.sourceBlob.id,
      representativeNodeId: run.libraryNode.id,
      summary: assessment.summary,
      previewExcerpt: preview.text?.slice(0, 8_000),
      referenceCandidates: assessment.referenceCandidates,
      assertionCandidates: assessment.assertionCandidates,
      objectCandidates: assessment.objectCandidates,
    },
  });
}

async function processDeep(run: ProcessingRun): Promise<void> {
  let checkpoint = loadRunCheckpoint(run);
  await updateRun(run.id, {
    stage: "parsing",
    progressCurrent: 0,
    statusMessage: "准备深度冷启动",
  });
  if (run.sourceBlob.mimeType === "application/pdf") {
    const result = await runDeepColdStart({
      runId: run.id,
      sha256: run.sourceBlob.sha256,
      storageKey: run.sourceBlob.storageKey,
      checkpoint: checkpoint.deep ?? {},
      onCheckpoint: async (deep) => {
        checkpoint = { ...checkpoint, deep };
        await saveRunCheckpoint(run.id, checkpoint);
      },
      onProgress: async ({ progressCurrent, statusMessage, parallelUnits }) => {
        if (parallelUnits && checkpoint.deep) {
          checkpoint = {
            ...checkpoint,
            deep: { ...checkpoint.deep, parallelUnits },
          };
        }
        await updateRun(run.id, {
          stage: progressCurrent <= 1
            ? "parsing"
            : progressCurrent === 2
              ? "analyzing"
              : "resolving",
          progressCurrent,
          statusMessage,
          ...(parallelUnits ? { checkpoint } : {}),
        });
      },
    });
    const preview: LibraryPreview = {
      parser: "deep-cold-start-artifacts",
      sourceKind: "text_excerpt",
    };
    await updateRun(run.id, {
      stage: "staging",
      progressCurrent: 4,
      artifactLocation: `cold-start-global-resolution:${result.globalResolutionDirectory}`,
      statusMessage: "保存深度冷启动草稿产物",
    });
    await persistAssessment(run, preview, {
      summary: `深度冷启动草稿完成：${result.objectCount} 个 Global Object，${result.assertionCount} 条 Assertion。`,
      referenceCandidates: [],
      assertionCandidates: [],
      objectCandidates: [],
    });
    await updateRun(run.id, {
      status: "ready",
      stage: "ready",
      progressCurrent: 5,
      statusMessage: "文件草稿已完成，等待本次任务的 Global Object 归并与发布",
      resultSummary: `${result.objectCount} 个 Global Object · ${result.assertionCount} 条 Assertion`,
      errorMessage: null,
      completedAt: new Date(),
    });
    return;
  }
  const preview = await extractLibraryPreview({
    storageKey: run.sourceBlob.storageKey,
    sha256: run.sourceBlob.sha256,
    mimeType: run.sourceBlob.mimeType,
    parserKey: run.parserKey,
  });
  await persistAssessment(run, preview, {
    summary: "文件已安全保存，但尚没有对应的完整冷启动工作快照。",
    referenceCandidates: [],
    assertionCandidates: [],
    objectCandidates: [],
  });
  await updateRun(run.id, {
    status: "failed",
    stage: "failed",
    progressCurrent: 5,
    statusMessage: "处理失败：当前深度 worker 不支持该文件格式",
    resultSummary: "已保留深度处理请求，未改变当前 Shared Brain",
    errorMessage: "当前网页深度 worker 第一版只支持 PDF",
    completedAt: new Date(),
  });
}

async function processSemantic(run: ProcessingRun): Promise<void> {
  let checkpoint = loadRunCheckpoint(run);
  const reportModelRetry: ModelRetryReporter = async ({ kind, error }) => {
    const retries = checkpoint.modelRetries ?? { text: 0, vision: 0 };
    const nextRetries = {
      ...retries,
      [kind]: retries[kind] + 1,
      lastError: error.slice(0, 3_000),
      lastFailedAt: new Date().toISOString(),
    };
    checkpoint = { ...checkpoint, modelRetries: nextRetries };
    await updateRun(run.id, {
      checkpoint,
      errorMessage: error,
      statusMessage: `${kind === "vision" ? "视觉" : "文字"}模型输出未通过校验，正在当前模型步骤内纠正重试`,
    });
  };
  await updateRun(run.id, {
    stage: "parsing",
    progressCurrent: 1,
    statusMessage: checkpoint.extractedPreview || checkpoint.semanticPreview
      ? "从 checkpoint 恢复语义预览"
      : "提取低成本语义预览",
  });
  const isImage = run.sourceBlob.mimeType.startsWith("image/");
  let preview: LibraryPreview;
  if (!isImage && checkpoint.extractedPreview) {
    preview = checkpoint.extractedPreview;
  } else if (isImage && checkpoint.semanticPreview) {
    preview = checkpoint.semanticPreview;
  } else {
    preview = await extractLibraryPreview({
      storageKey: run.sourceBlob.storageKey,
      sha256: run.sourceBlob.sha256,
      mimeType: run.sourceBlob.mimeType,
      parserKey: run.parserKey,
    });
    if (!isImage) {
      checkpoint = { ...checkpoint, extractedPreview: storablePreview(preview) };
      await saveRunCheckpoint(run.id, checkpoint);
    }
  }
  if (!preview.text && !preview.image) {
    await persistAssessment(run, preview, {
      summary: "文件已保存，但当前解析器无法提供可供 AI 判断的内容。",
      referenceCandidates: [],
      assertionCandidates: [],
      objectCandidates: [],
    });
    await updateRun(run.id, {
      status: "failed",
      stage: "failed",
      progressCurrent: 4,
      statusMessage: "处理失败：解析器未提供可用内容",
      resultSummary: preview.warning ?? "格式不支持",
      errorMessage: preview.warning ?? "当前格式不支持",
      completedAt: new Date(),
    });
    return;
  }
  let semanticPreview = preview;
  if (isImage) {
    if (checkpoint.semanticPreview) {
      semanticPreview = checkpoint.semanticPreview;
      await updateRun(run.id, {
        stage: "analyzing",
        progressCurrent: 2,
        statusMessage: "已从 checkpoint 恢复视觉 OCR 与画面观察",
      });
    } else {
      await updateRun(run.id, {
        stage: "analyzing",
        progressCurrent: 2,
        statusMessage: "视觉模型正在执行 OCR 与画面观察",
      });
      semanticPreview = await observeImageWithVisionModel(run, preview, reportModelRetry);
      checkpoint = { ...checkpoint, semanticPreview: storablePreview(semanticPreview) };
      await saveRunCheckpoint(run.id, checkpoint);
    }
    await persistVisualIntermediate(run, semanticPreview);
    await updateRun(run.id, {
      stage: "analyzing",
      progressCurrent: 3,
      statusMessage: "普通文字模型正在编译视觉观察文字",
    });
  } else {
    await updateRun(run.id, {
      stage: "analyzing",
      progressCurrent: 2,
      statusMessage: run.profile === "coarse" ? "执行无全局勘探的粗编译" : "普通文字模型正在理解文件语义",
    });
  }
  const assessment = checkpoint.assessment ?? await analyzeWithTextModel(
    run,
    semanticPreview,
    reportModelRetry,
  );
  if (!checkpoint.assessment) {
    checkpoint = { ...checkpoint, assessment };
    await saveRunCheckpoint(run.id, checkpoint);
  }
  await updateRun(run.id, {
    stage: "staging",
    progressCurrent: isImage ? 4 : 3,
    statusMessage: "校验来源摘录并保存草稿候选",
  });
  await persistAssessment(run, semanticPreview, assessment);
  const formedKnowledge = assessment.referenceCandidates.length > 0 ||
    assessment.assertionCandidates.length > 0 || assessment.objectCandidates.length > 0;
  await updateRun(run.id, {
    status: "ready",
    stage: "ready",
    progressCurrent: isImage ? 5 : 4,
    statusMessage: formedKnowledge ? "编译成功" : "文件已保存，未形成知识结果",
    resultSummary: assessment.summary,
    errorMessage: null,
    completedAt: new Date(),
  });
}

export async function processLibraryCompilationRun(runId: string): Promise<void> {
  const run = await loadProcessingRun(runId);
  await updateRun(run.id, {
    status: "running",
    stage: "preparing",
    progressCurrent: 0,
    statusMessage: "正在准备内容对象",
  });
  if (run.profile === "deep") await processDeep(run);
  else await processSemantic(run);
}
