import { z } from "zod";

import {
  debugCodeBlock,
  debugJson,
  renderDebugMessages,
  renderDebugModelOutput,
  type DebugTrace,
} from "@/ai/debug-trace";
import { getChatModel } from "@/ai/provider";
import { generateStructuredResult } from "@/ai/structured-submission";
import { getDatabase } from "@/db";
import { transactionAdvisoryLockQuery } from "@/db-advisory-lock";
import type { ChatAssertionSemanticContext } from "@/memory/chat-assertion";
import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import { followObject } from "@/memory/explore";
import {
  cognitiveMemorySchema,
  operationalMemoryIndexSchema,
  parseCognitiveMemory,
  parseOperationalMemoryIndex,
  renderCognitiveMemory,
  renderOperationalMemoryIndex,
  sanitizeCognitiveMemory,
  sanitizeOperationalMemoryIndex,
  type OperationalMemoryIndex,
} from "@/memory/higher-memory-document";
import type { ObjectHigherMemoryQueueDecision } from "@/memory/higher-memory-queue";
import type { MemoryRetrievalResult } from "@/memory/types";

const maintenanceSchema = z.object({
  memories: z.array(z.object({
    globalObjectId: z.string().uuid(),
    cognitivePatch: cognitiveMemorySchema.partial().default({}),
    operationalIndexPatch: z.object({
      upsertAspects: operationalMemoryIndexSchema.shape.aspects.default([]),
      removeAspectKeys: z.array(z.string().trim().min(1).max(100)).max(16).default([]),
    }).default({ upsertAspects: [], removeAspectKeys: [] }),
  })).max(6),
});

const MAX_CONCURRENT_REBASE_ATTEMPTS = 3;

type StoredHigherMemory = {
  globalObjectId: string;
  cognitiveMemory: ReturnType<typeof parseCognitiveMemory>;
  operationalIndex: ReturnType<typeof parseOperationalMemoryIndex>;
  maintainedAt: Date;
  updatedAt: Date;
};

class HigherMemoryWriteConflict extends Error {
  constructor() {
    super("Object Higher Memory 在生成期间已被其他任务更新");
    this.name = "HigherMemoryWriteConflict";
  }
}

export type ObjectHigherMemoryMaintenanceInput = {
  clientMessageId: string;
  submittedAt: string;
  timezone: string;
  semanticContext: ChatAssertionSemanticContext;
  retrieval: MemoryRetrievalResult;
  queueDecision: ObjectHigherMemoryQueueDecision;
  existingOnly?: boolean;
};

/**
 * Assertion publication may refresh an existing Higher Memory automatically,
 * but must not create Higher Memory for every Object mentioned in chat.
 */
export async function findExistingHigherMemoryObjectIds(input: {
  objectIds: string[];
}): Promise<string[]> {
  const objectIds = [...new Set(input.objectIds)];
  if (!objectIds.length) return [];
  const database = getDatabase();
  const rows = await database.memoryObjectHigherMemory.findMany({
    where: {
      globalObjectId: { in: objectIds },
    },
    select: { globalObjectId: true },
  });
  const existing = new Set(rows.map((row) => row.globalObjectId));
  return objectIds.filter((id) => existing.has(id));
}

function maintenancePrompt(input: ObjectHigherMemoryMaintenanceInput, state: {
  objects: Array<{
    id: string;
    globalObjectKey: string;
    canonicalName: string;
  }>;
  oldMemories: Array<{
    globalObjectId: string;
    cognitiveMemory: ReturnType<typeof parseCognitiveMemory>;
    operationalIndex: ReturnType<typeof parseOperationalMemoryIndex>;
    maintainedAt: string;
  }>;
}): string {
  return [
    "维护 Sydaris 的 Object Higher Memory：Cognitive Memory 保存高层认知，Operational Memory Index 保存检索导航。只处理 targetObjects。",
    "事实只来自可见的 grounded Assertion 或权威 Business View；用户问题、助手回答和检索命中本身不是事实。账号绑定、Proposal、处理状态和当前用户的私人偏好属于 Runtime 或 Actor 记忆，不进入 Object Higher Memory。",
    "以 oldHigherMemories 为连续状态，只输出确有证据变化的 Patch。cognitivePatch 只填写需要新增或修正的字段；未填写字段由 Runtime 原样保留。Operational aspect 使用稳定 key 增量 upsert，只有证据明确推翻时才放入 removeAspectKeys。当前证据较窄不是删除旧内容的理由。",
    "Cognitive Memory 保留对象的身份边界、叙事意义、稳定结构与运行方式；currentSituation 只写有时间依据的近期状态。Operational Index 记录有限覆盖、真实 Assertion/source 入口和推荐查询，不充当事实正文。",
    "首次创建时提供足以通过 Cognitive Memory Schema 的内容；没有可靠增量时返回空 memories。输出中不写生成过程、内部 ref 或数据库标识。",
    JSON.stringify({
      maintenanceInstant: input.submittedAt,
      environmentTimezone: input.timezone,
      queueDecision: input.queueDecision,
      targetObjects: state.objects,
      oldHigherMemories: state.oldMemories,
      semanticContext: input.semanticContext,
      mainDialogueRetrieval: input.retrieval,
    }),
  ].join("\n\n");
}

function mergeOperationalIndex(
  previous: OperationalMemoryIndex | undefined,
  patch: {
    upsertAspects: OperationalMemoryIndex["aspects"];
    removeAspectKeys: string[];
  },
): OperationalMemoryIndex {
  const removed = new Set(patch.removeAspectKeys);
  const upserts = new Map(patch.upsertAspects.map((aspect) => [aspect.key, aspect]));
  const aspects = (previous?.aspects ?? [])
    .filter((aspect) => !removed.has(aspect.key))
    .map((aspect) => upserts.get(aspect.key) ?? aspect);
  const existingKeys = new Set(aspects.map((aspect) => aspect.key));
  for (const aspect of patch.upsertAspects) {
    if (existingKeys.has(aspect.key) || aspects.length >= 16) continue;
    aspects.push(aspect);
    existingKeys.add(aspect.key);
  }
  return sanitizeOperationalMemoryIndex({ aspects });
}

function mergeCognitiveMemory(
  previous: StoredHigherMemory["cognitiveMemory"] | undefined,
  patch: Partial<StoredHigherMemory["cognitiveMemory"]>,
) {
  return sanitizeCognitiveMemory(cognitiveMemorySchema.parse({
    identityAndBoundaries: previous?.identityAndBoundaries ?? "",
    narrativeAndMeaning: previous?.narrativeAndMeaning ?? "",
    structuralModel: previous?.structuralModel ?? "",
    operatingModel: previous?.operatingModel ?? "",
    currentSituation: previous?.currentSituation ?? "",
    openQuestions: previous?.openQuestions ?? [],
    ...patch,
  }));
}

function rowVersion(row: Pick<StoredHigherMemory, "updatedAt"> | undefined): string | null {
  return row?.updatedAt.toISOString() ?? null;
}

function isUniqueConstraintFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "P2002";
}

function validatedOperationalIndex(
  index: OperationalMemoryIndex,
  retrieval: MemoryRetrievalResult,
): OperationalMemoryIndex {
  const assertionIds = new Set(retrieval.seedMap.assertions.flatMap((assertion) =>
    assertion.id ? [assertion.id] : []
  ));
  const sourceNodeIds = new Set(retrieval.seedMap.assertions.flatMap((assertion) => [
    ...(assertion.sourceNodeId ? [assertion.sourceNodeId] : []),
    ...assertion.sources.flatMap((source) =>
      source.kind === "chat" ? [] : [source.sourceNodeId]
    ),
  ]));
  const sourceTitles = new Set(retrieval.seedMap.assertions.flatMap((assertion) =>
    assertion.sources.flatMap((source) =>
      source.kind === "chat" ? [] : [source.sourceTitle]
    )
  ));
  return {
    aspects: index.aspects.map((aspect) => ({
      ...aspect,
      assertionIds: [...new Set(aspect.assertionIds.filter((id) => assertionIds.has(id)))],
      sourceNodeIds: [...new Set(aspect.sourceNodeIds.filter((id) => sourceNodeIds.has(id)))],
      sourceTitles: [...new Set(aspect.sourceTitles.filter((title) => sourceTitles.has(title)))],
      recommendedQueries: [...new Set(aspect.recommendedQueries)],
      unresolvedAspects: [...new Set(aspect.unresolvedAspects)],
    })),
  };
}

export async function maintainObjectHigherMemories(
  input: ObjectHigherMemoryMaintenanceInput,
  trace?: DebugTrace,
): Promise<number> {
  const triggerInstant = new Date(input.submittedAt);
  if (Number.isNaN(triggerInstant.getTime())) {
    await trace?.appendSection("Higher Memory 处理结果", "结果：未维护。触发时间无效。");
    return 0;
  }
  const targetIds = [...new Set(input.queueDecision.objectIds)];
  const database = getDatabase();
  const objects = await database.memoryGlobalObject.findMany({
    where: { id: { in: targetIds } },
    select: {
      id: true,
      globalObjectKey: true,
      canonicalName: true,
    },
  });
  const objectById = new Map(objects.map((object) => [object.id, object]));
  const invalidIds = targetIds.filter((id) => !objectById.has(id));
  if (invalidIds.length) {
    await trace?.appendSection(
      "Higher Memory 目标校验",
      `以下 Object 不属于 Shared Brain，已拒绝整次维护：${invalidIds.map((id) => `\`${id}\``).join("、")}`,
    );
    return 0;
  }
  const orderedObjects = targetIds.map((id) => objectById.get(id)!);
  if (input.existingOnly) {
    const existingRows = await database.memoryObjectHigherMemory.findMany({
      where: { globalObjectId: { in: targetIds } },
      select: { globalObjectId: true },
    });
    if (existingRows.length !== targetIds.length) {
      await trace?.appendSection(
        "Higher Memory 目标校验",
        "本轮只允许更新已有 Object Higher Memory；至少一个目标尚未建立，因此未执行维护。",
      );
      return 0;
    }
  }
  const searchEvidence = new MemoryEvidenceAccumulator(input.retrieval);
  const maintenanceSignal = AbortSignal.timeout(1_800_000);
  const objectEvidence = await Promise.all(targetIds.map((globalObjectId) =>
    followObject(
      globalObjectId,
      input.queueDecision.reason.slice(0, 300),
      { signal: maintenanceSignal, preferHigherMemory: false },
    )
  ));
  for (const result of objectEvidence) searchEvidence.merge(result);
  const finalRetrieval = searchEvidence.snapshot();
  let callNumber = 0;
  for (let attempt = 1; attempt <= MAX_CONCURRENT_REBASE_ATTEMPTS; attempt += 1) {
    const storedRows = await database.memoryObjectHigherMemory.findMany({
      where: { globalObjectId: { in: targetIds } },
      select: {
        globalObjectId: true,
        cognitiveMemory: true,
        operationalIndex: true,
        maintainedAt: true,
        updatedAt: true,
      },
    });
    const oldRows: StoredHigherMemory[] = storedRows.map((memory) => ({
      globalObjectId: memory.globalObjectId,
      cognitiveMemory: parseCognitiveMemory(memory.cognitiveMemory),
      operationalIndex: parseOperationalMemoryIndex(memory.operationalIndex),
      maintainedAt: memory.maintainedAt,
      updatedAt: memory.updatedAt,
    }));
    if (input.existingOnly && oldRows.length !== targetIds.length) {
      await trace?.appendSection(
        "Higher Memory 目标校验",
        "本轮只允许更新已有 Object Higher Memory；至少一个目标已不存在，因此未执行写入。",
      );
      return 0;
    }
    const previousById = new Map(oldRows.map((memory) => [memory.globalObjectId, memory]));
    const prompt = maintenancePrompt(
      { ...input, retrieval: finalRetrieval },
      {
        objects: orderedObjects,
        oldMemories: oldRows.map((memory) => ({
          globalObjectId: memory.globalObjectId,
          cognitiveMemory: memory.cognitiveMemory,
          operationalIndex: memory.operationalIndex,
          maintainedAt: memory.maintainedAt.toISOString(),
        })),
      },
    );
    await trace?.appendSection(
      attempt === 1
        ? "后台 Higher Memory Agent · 初始输入"
        : `后台 Higher Memory Agent · 并发重算 ${attempt}`,
      [
        debugCodeBlock(prompt),
        "",
        `> 服务端已按 ${targetIds.length} 个目标 Object 补全证据；Agent 只提交增量 Patch。`,
      ].join("\n"),
    );

    const output = await generateStructuredResult({
      model: getChatModel(),
      schema: maintenanceSchema,
      name: "object_higher_memory_maintenance",
      description: "提交目标 GlobalObject 的高层认知增量 Patch",
      prompt,
      temperature: 0.15,
      maxOutputTokens: 12_000,
      abortSignal: maintenanceSignal,
      timeout: { totalMs: 1_800_000, stepMs: 1_800_000, toolMs: 30_000 },
      onLanguageModelCallStart: async (event) => {
        callNumber += 1;
        await trace?.appendSection(
          `后台 Higher Memory Agent 调用 ${callNumber} · 实际输入`,
          [
            `- Provider：\`${event.provider}\``,
            `- Model：\`${event.modelId}\``,
            `- Call ID：\`${event.callId}\``,
            "",
            "### Instructions",
            "",
            debugCodeBlock(typeof event.instructions === "string"
              ? event.instructions
              : debugJson(event.instructions)),
            "",
            "### Messages",
            "",
            renderDebugMessages(event.messages),
          ].join("\n"),
        );
      },
      onLanguageModelCallEnd: async (event) => {
        await trace?.appendSection(
          `后台 Higher Memory Agent 调用 ${callNumber} · 实际输出`,
          [
            `- Finish reason：\`${String(event.finishReason)}\``,
            `- Token usage：${debugCodeBlock(debugJson(event.usage), "json")}`,
            "",
            renderDebugModelOutput(event.content),
          ].join("\n"),
        );
      },
    });
    await trace?.appendSection(
      "后台 Higher Memory Agent · Schema 校验后的输出",
      debugCodeBlock(debugJson(output), "json"),
    );

    const outputIds = output.memories.map((memory) => memory.globalObjectId);
    const invalidOutputIds = outputIds.filter((id) => !targetIds.includes(id));
    if (invalidOutputIds.length || new Set(outputIds).size !== outputIds.length) {
      await trace?.appendSection(
        "Higher Memory 处理结果",
        "结果：拒绝整次维护。Agent 输出了非目标 Object 或重复 Object，旧 Higher Memory 保持不变。",
      );
      return 0;
    }
    const accepted = output.memories.flatMap((memory) => {
      const previous = previousById.get(memory.globalObjectId);
      const validatedPatch = validatedOperationalIndex(
        { aspects: memory.operationalIndexPatch.upsertAspects },
        finalRetrieval,
      );
      const cognitiveMemory = mergeCognitiveMemory(previous?.cognitiveMemory, memory.cognitivePatch);
      const operationalIndex = mergeOperationalIndex(previous?.operationalIndex, {
        upsertAspects: validatedPatch.aspects,
        removeAspectKeys: memory.operationalIndexPatch.removeAspectKeys,
      });
      if (
        previous &&
        JSON.stringify(previous.cognitiveMemory) === JSON.stringify(cognitiveMemory) &&
        JSON.stringify(previous.operationalIndex) === JSON.stringify(operationalIndex)
      ) {
        return [];
      }
      return [{
        globalObjectId: memory.globalObjectId,
        cognitiveMemory,
        operationalIndex,
        baseVersion: rowVersion(previous),
      }];
    });
    if (!accepted.length) {
      await trace?.appendSection(
        "Higher Memory 处理结果",
        "结果：没有可靠增量，旧 Higher Memory 保持不变。",
      );
      return 0;
    }

    try {
      const maintainedAt = new Date();
      await database.$transaction(async (transaction) => {
        for (const globalObjectId of accepted.map((memory) => memory.globalObjectId).sort()) {
          await transaction.$queryRaw(transactionAdvisoryLockQuery(
            `object-higher-memory:${globalObjectId}`,
          ));
        }
        const acceptedIds = accepted.map((memory) => memory.globalObjectId);
        const currentObjectCount = await transaction.memoryGlobalObject.count({
          where: { id: { in: acceptedIds } },
        });
        if (currentObjectCount !== acceptedIds.length) {
          throw new Error("Higher Memory 目标 Object 已改变");
        }
        const currentRows = await transaction.memoryObjectHigherMemory.findMany({
          where: { globalObjectId: { in: acceptedIds } },
          select: { globalObjectId: true, updatedAt: true },
        });
        const currentVersionById = new Map(
          currentRows.map((row) => [row.globalObjectId, row.updatedAt.toISOString()]),
        );
        for (const memory of accepted) {
          if ((currentVersionById.get(memory.globalObjectId) ?? null) !== memory.baseVersion) {
            throw new HigherMemoryWriteConflict();
          }
        }
        for (const memory of accepted) {
          const data = {
            cognitiveMemory: memory.cognitiveMemory,
            operationalIndex: memory.operationalIndex,
            maintainedAt,
            triggerMessageId: input.clientMessageId,
            maintenanceReason: input.queueDecision.reason,
          };
          if (memory.baseVersion) {
            const updated = await transaction.memoryObjectHigherMemory.updateMany({
              where: {
                globalObjectId: memory.globalObjectId,
                updatedAt: new Date(memory.baseVersion),
              },
              data,
            });
            if (updated.count !== 1) throw new HigherMemoryWriteConflict();
          } else if (!input.existingOnly) {
            await transaction.memoryObjectHigherMemory.create({
              data: { globalObjectId: memory.globalObjectId, ...data },
            });
          } else {
            throw new HigherMemoryWriteConflict();
          }
        }
      }, { maxWait: 30_000, timeout: 120_000 });

      await trace?.appendSection(
        "Higher Memory 处理结果",
        [
          `结果：成功增量维护 ${accepted.length} 个重要 Object。`,
          "",
          ...accepted.flatMap((memory) => {
            const object = objectById.get(memory.globalObjectId)!;
            return [
              `### ${object.canonicalName}`,
              "",
              renderCognitiveMemory(memory.cognitiveMemory),
              "",
              "#### Operational Memory Index",
              "",
              renderOperationalMemoryIndex(memory.operationalIndex),
              "",
            ];
          }),
        ].join("\n"),
      );
      return accepted.length;
    } catch (error) {
      const conflict = error instanceof HigherMemoryWriteConflict ||
        isUniqueConstraintFailure(error);
      if (!conflict) throw error;
      await trace?.appendSection(
        "Higher Memory 并发冲突",
        attempt < MAX_CONCURRENT_REBASE_ATTEMPTS
          ? "目标 Object 已有更新；丢弃当前结果并基于最新版重新生成 Patch。"
          : "连续发生版本冲突；未覆盖任何已有 Higher Memory。",
      );
      if (attempt === MAX_CONCURRENT_REBASE_ATTEMPTS) throw new HigherMemoryWriteConflict();
    }
  }
  return 0;
}
