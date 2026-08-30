import { afterAll, describe, expect, it } from "vitest";

import type { DebugTrace } from "@/ai/debug-trace";
import { getDatabase } from "@/db";
import {
  captureChatAssertions,
  currentMemoryActor,
  type ChatAssertionCaptureResult,
} from "@/memory/chat-assertion";
import {
  parseCognitiveMemory,
  parseOperationalMemoryIndex,
} from "@/memory/higher-memory-document";
import { maintainObjectHigherMemories } from "@/memory/object-higher-memory";
import type { MemoryRetrievalResult } from "@/memory/types";

const runLive = process.env.SYDARIS_LIVE_STRUCTURED_SUBMISSION_TEST === "1";
const chatMessageId = "live-structured-submission-chat-001";
const hypotheticalMessageId = "live-structured-submission-hypothetical-001";
const questionMessageId = "live-structured-submission-question-001";
const assistantInferenceMessageId = "live-structured-submission-assistant-inference-001";
const relayedFactMessageId = "live-structured-submission-relayed-fact-001";
const multiFactHistoryMessageId = "live-structured-submission-multi-fact-history-001";
const multiFactMessageId = "live-structured-submission-multi-fact-001";
const objectMaintenanceMessageId = "live-structured-submission-object-memory-001";

function traceRecorder(titles: string[], sections?: string[]): DebugTrace {
  return {
    enabled: true,
    appendSection: async (title, markdown) => {
      titles.push(title);
      sections?.push(`## ${title}\n\n${markdown}`);
    },
    appendJsonSection: async (title, value) => {
      titles.push(title);
      sections?.push(`## ${title}\n\n${JSON.stringify(value, null, 2)}`);
    },
    appendError: async () => undefined,
    flush: async () => undefined,
  };
}

async function requireSharedBrainIndex() {
  return getDatabase().memoryAssertionEmbeddingIndex.findUniqueOrThrow({
    where: { id: "shared" },
  });
}

function emptyRetrieval(query: string): MemoryRetrievalResult {
  return {
    query,
    mode: "object-assertion",
    seedMap: { facets: [], objects: [], assertions: [], connections: [] },
  };
}

async function cleanupChatCapture(
  messageId: string,
  result?: ChatAssertionCaptureResult,
): Promise<void> {
  const database = getDatabase();
  const actor = currentMemoryActor();
  const capture = await database.memoryChatAssertionCapture.findUnique({
    where: {
      queuedByActorId_queuedByMessageId: {
        queuedByActorId: actor.id,
        queuedByMessageId: messageId,
      },
    },
    select: {
      id: true,
      assertions: {
        select: {
          id: true,
          chatEvidenceLinks: { select: { chatEvidenceId: true } },
        },
      },
    },
  });
  const evidence = await database.memoryChatEvidence.findUnique({
    where: {
      submittedByActorId_clientMessageId: {
        submittedByActorId: actor.id,
        clientMessageId: messageId,
      },
    },
    select: { id: true },
  });
  const createdObjectIds = result?.affectedObjects
    .filter((object) => object.resolution === "created")
    .map((object) => object.id) ?? [];
  const evidenceIds = [...new Set([
    ...(evidence ? [evidence.id] : []),
    ...(capture?.assertions.flatMap((assertion) =>
      assertion.chatEvidenceLinks.map((link) => link.chatEvidenceId)
    ) ?? []),
  ])];
  if (!capture && !evidenceIds.length && !createdObjectIds.length) return;
  await database.$transaction(async (transaction) => {
    if (capture) {
      await transaction.memoryChatAssertionCapture.delete({ where: { id: capture.id } });
    }
    if (evidenceIds.length) {
      await transaction.memoryChatObjectMention.deleteMany({
        where: { chatEvidenceId: { in: evidenceIds } },
      });
      await transaction.memoryChatEvidence.deleteMany({
        where: { id: { in: evidenceIds } },
      });
    }
    if (capture?.assertions.length) {
      await transaction.memoryAssertionEmbeddingIndex.update({
        where: { id: "shared" },
        data: { indexedAssertionCount: { decrement: capture.assertions.length } },
      });
    }
    if (createdObjectIds.length) {
      await transaction.memoryGlobalObject.deleteMany({
        where: { id: { in: createdObjectIds } },
      });
    }
  });
}

describe.runIf(runLive)("GLM structured submission compatibility", () => {
  afterAll(async () => {
    await getDatabase().$disconnect();
  });

  it("lets Chat Assertion explicitly submit an empty extraction", async () => {
    await requireSharedBrainIndex();
    const titles: string[] = [];
    let result: ChatAssertionCaptureResult | undefined;
    try {
      result = await captureChatAssertions({
        clientMessageId: chatMessageId,
        submittedAt: "2026-08-15T01:05:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {
          conversation: [{
            messageId: chatMessageId,
            role: "user",
            text: "请把“欢迎参加活动”改得更简洁。",
            submittedAt: "2026-08-15T01:05:00.000Z",
          }],
          systemInstruction: "你是 Sydaris。",
          modelCalls: [],
          toolExecutions: [],
          finalAnswer: "可以改成：欢迎参加。",
        },
        retrieval: emptyRetrieval("普通改写任务"),
        queueDecision: { reason: "兼容性测试故意触发提取，模型应判断没有组织事实" },
      }, traceRecorder(titles));

      expect(result.publishedAssertions).toBe(0);
      expect(titles).toContain("后台 Assertion Agent · Schema 校验后的输出");
    } finally {
      await cleanupChatCapture(chatMessageId, result);
    }
  }, 240_000);

  it("does not publish an explicitly labeled hypothetical scenario", async () => {
    const database = getDatabase();
    await requireSharedBrainIndex();
    const titles: string[] = [];
    let result: ChatAssertionCaptureResult | undefined;
    try {
      result = await captureChatAssertions({
        clientMessageId: hypotheticalMessageId,
        submittedAt: "2026-08-21T05:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {
          conversation: [{
            messageId: hypotheticalMessageId,
            role: "user",
            text: "假设Sydaris人工验收赛-20260821-C1在2026年8月26日举行、地点在东区馆，这只是测试假设，不代表真实安排。",
            submittedAt: "2026-08-21T05:00:00.000Z",
          }],
          systemInstruction: "你是 Sydaris。本轮验证明确假设不得写入组织事实。",
          modelCalls: [],
          toolExecutions: [],
          finalAnswer: "明白，这是测试假设，不代表真实安排。",
        },
        retrieval: emptyRetrieval("明确标注的测试假设"),
        queueDecision: { reason: "负例验收：明确假设必须由 Assertion Agent 拒绝" },
      }, traceRecorder(titles));

      expect(result.publishedAssertions).toBe(0);
      expect(result.affectedObjects).toEqual([]);
      expect(titles).toContain("后台 Assertion Agent · Schema 校验后的输出");
      await expect(database.memoryGlobalObject.count({
        where: {
          canonicalName: "Sydaris人工验收赛-20260821-C1",
        },
      })).resolves.toBe(0);
    } finally {
      await cleanupChatCapture(hypotheticalMessageId, result);
    }
  }, 240_000);

  it("does not publish a proposition that the user only asked as a question", async () => {
    const database = getDatabase();
    await requireSharedBrainIndex();
    const titles: string[] = [];
    let result: ChatAssertionCaptureResult | undefined;
    try {
      result = await captureChatAssertions({
        clientMessageId: questionMessageId,
        submittedAt: "2026-08-21T05:05:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {
          conversation: [{
            messageId: questionMessageId,
            role: "user",
            text: "Sydaris人工验收赛-20260821-C2是不是在2026年8月27日于西区馆举行？",
            submittedAt: "2026-08-21T05:05:00.000Z",
          }],
          systemInstruction: "你是 Sydaris。本轮验证用户问题不得写入组织事实。",
          modelCalls: [],
          toolExecutions: [],
          finalAnswer: "目前没有足够证据确认该活动的时间和地点。",
        },
        retrieval: emptyRetrieval("未得到事实答案的活动时间地点提问"),
        queueDecision: { reason: "负例验收：疑问句中的命题必须由 Assertion Agent 拒绝" },
      }, traceRecorder(titles));

      expect(result.publishedAssertions).toBe(0);
      expect(result.affectedObjects).toEqual([]);
      expect(titles).toContain("后台 Assertion Agent · Schema 校验后的输出");
      await expect(database.memoryGlobalObject.count({
        where: {
          canonicalName: "Sydaris人工验收赛-20260821-C2",
        },
      })).resolves.toBe(0);
    } finally {
      await cleanupChatCapture(questionMessageId, result);
    }
  }, 240_000);

  it("does not publish a factual detail introduced only by the Assistant", async () => {
    const database = getDatabase();
    await requireSharedBrainIndex();
    const titles: string[] = [];
    let result: ChatAssertionCaptureResult | undefined;
    try {
      result = await captureChatAssertions({
        clientMessageId: assistantInferenceMessageId,
        submittedAt: "2026-08-21T05:10:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {
          conversation: [{
            messageId: assistantInferenceMessageId,
            role: "user",
            text: "请介绍一下Sydaris人工验收赛-20260821-C3。",
            submittedAt: "2026-08-21T05:10:00.000Z",
          }],
          systemInstruction: "你是 Sydaris。本轮验证 Assistant 内容不能重新认证为用户事实。",
          modelCalls: [],
          toolExecutions: [],
          finalAnswer: "Sydaris人工验收赛-20260821-C3将于2026年8月28日在南区馆举行。",
        },
        retrieval: emptyRetrieval("Assistant 单方面给出的活动信息"),
        queueDecision: { reason: "负例验收：只有 Assistant 提供的事实必须被 Assertion Agent 拒绝" },
      }, traceRecorder(titles));

      expect(result.publishedAssertions).toBe(0);
      expect(result.affectedObjects).toEqual([]);
      expect(titles).toContain("后台 Assertion Agent · Schema 校验后的输出");
      await expect(database.memoryGlobalObject.count({
        where: {
          canonicalName: "Sydaris人工验收赛-20260821-C3",
        },
      })).resolves.toBe(0);
    } finally {
      await cleanupChatCapture(assistantInferenceMessageId, result);
    }
  }, 240_000);

  it("preserves relayed sources and handles an identical retry idempotently", async () => {
    const database = getDatabase();
    await requireSharedBrainIndex();
    const titles: string[] = [];
    const testObjectName = "Sydaris人工验收赛-20260821-C4";
    const userMessage =
      `我问了一下验收员王明，他说${testObjectName}可能在2026年8月29日举行，地点还没确定。`;
    const staleObject = await database.memoryGlobalObject.findFirst({
      where: { canonicalName: testObjectName },
      select: { id: true, canonicalName: true },
    });
    await cleanupChatCapture(relayedFactMessageId, staleObject ? {
      publishedAssertions: 0,
      publishedAssertionIds: [],
      affectedObjectIds: [staleObject.id],
      affectedObjects: [{ ...staleObject, resolution: "created" }],
    } : undefined);
    const captureInput = {
      clientMessageId: relayedFactMessageId,
      submittedAt: "2026-08-21T05:15:00.000Z",
      timezone: "Asia/Shanghai",
      semanticContext: {
        conversation: [{
          messageId: relayedFactMessageId,
          role: "user" as const,
          text: userMessage,
          submittedAt: "2026-08-21T05:15:00.000Z",
        }],
        systemInstruction: "你是 Sydaris。本轮验证转述来源和不确定性必须保留。",
        modelCalls: [],
        toolExecutions: [],
        finalAnswer: "收到，我会把它作为验收员王明提供、且时间和地点尚未完全确定的信息处理。",
      },
      retrieval: emptyRetrieval("带明确来源和不确定性的活动安排"),
      queueDecision: { reason: "正例验收：转述事实应保留来源后发布" },
    };
    let result: ChatAssertionCaptureResult | undefined;
    try {
      result = await captureChatAssertions(captureInput, traceRecorder(titles));

      expect(result.publishedAssertions).toBeGreaterThanOrEqual(1);
      expect(result.affectedObjects).toContainEqual(expect.objectContaining({
        canonicalName: testObjectName,
      }));
      expect(titles).toContain("后台 Assertion Agent · Schema 校验后的输出");

      const capture = await database.memoryChatAssertionCapture.findUniqueOrThrow({
        where: {
          queuedByActorId_queuedByMessageId: {
            queuedByActorId: currentMemoryActor().id,
            queuedByMessageId: relayedFactMessageId,
          },
        },
        select: {
          assertions: {
            select: {
              statementTemplateMarkdown: true,
              chatEvidenceLinks: {
                select: {
                  evidenceQuotes: true,
                  chatEvidence: {
                    select: { clientMessageId: true, rawUserMessage: true },
                  },
                },
              },
            },
          },
        },
      });
      expect(capture.assertions).toHaveLength(result.publishedAssertions);
      for (const assertion of capture.assertions) {
        expect(assertion.statementTemplateMarkdown).toContain("验收员王明");
        expect(assertion.statementTemplateMarkdown).toMatch(/说|称|表示|告知|告诉|转述|据/u);
        expect(assertion.chatEvidenceLinks).toContainEqual(expect.objectContaining({
          chatEvidence: {
            clientMessageId: relayedFactMessageId,
            rawUserMessage: userMessage,
          },
        }));
      }

      const retryTitles: string[] = [];
      const retryResult = await captureChatAssertions(captureInput, traceRecorder(retryTitles));
      expect(retryResult.publishedAssertionIds).toEqual(result.publishedAssertionIds);
      expect(retryResult.affectedObjectIds).toEqual(result.affectedObjectIds);
      expect(retryTitles).not.toContain("后台 Assertion Agent · Schema 校验后的输出");
      await expect(database.memoryChatAssertionCapture.count({
        where: {
          queuedByActorId: currentMemoryActor().id,
          queuedByMessageId: relayedFactMessageId,
        },
      })).resolves.toBe(1);
      await expect(database.memoryChatEvidence.count({
        where: {
          submittedByActorId: currentMemoryActor().id,
          clientMessageId: relayedFactMessageId,
        },
      })).resolves.toBe(1);
      await expect(database.memoryGlobalObject.count({
        where: { canonicalName: testObjectName },
      })).resolves.toBe(1);
    } finally {
      await cleanupChatCapture(relayedFactMessageId, result);
    }
  }, 240_000);

  it("publishes multiple propositions, Objects, and cross-message Evidence", async () => {
    const database = getDatabase();
    await requireSharedBrainIndex();
    const titles: string[] = [];
    const sections: string[] = [];
    const eventName = "Sydaris人工验收赛-20260821-C5";
    const groupName = "Sydaris-C5验收组";
    const staleObjects = await database.memoryGlobalObject.findMany({
      where: {
        canonicalName: { in: [eventName, groupName] },
      },
      select: { id: true, canonicalName: true },
    });
    await cleanupChatCapture(multiFactMessageId, staleObjects.length ? {
      publishedAssertions: 0,
      publishedAssertionIds: [],
      affectedObjectIds: staleObjects.map((object) => object.id),
      affectedObjects: staleObjects.map((object) => ({ ...object, resolution: "created" })),
    } : undefined);

    let result: ChatAssertionCaptureResult | undefined;
    try {
      result = await captureChatAssertions({
        clientMessageId: multiFactMessageId,
        submittedAt: "2026-08-21T05:25:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {
          conversation: [{
            messageId: multiFactHistoryMessageId,
            role: "user",
            text: `${eventName}由${groupName}负责。`,
            submittedAt: "2026-08-21T05:20:00.000Z",
          }, {
            messageId: "live-structured-submission-multi-fact-assistant-001",
            role: "assistant",
            text: "收到，我记下了负责人安排。",
            submittedAt: "2026-08-21T05:21:00.000Z",
          }, {
            messageId: multiFactMessageId,
            role: "user",
            text: `刚才说的负责人安排保持不变；${eventName}确定在2026年8月30日于中区馆举行，报名截止时间为2026年8月28日。`,
            submittedAt: "2026-08-21T05:25:00.000Z",
          }],
          systemInstruction: "你是 Sydaris。本轮验证多命题、多对象和跨消息 Evidence。",
          modelCalls: [],
          toolExecutions: [],
          finalAnswer: "收到，负责人安排不变，并已补充活动时间、地点和报名截止时间。",
        },
        retrieval: emptyRetrieval("活动负责人和多项安排"),
        queueDecision: { reason: "综合正例验收：多命题、多对象和多 Evidence" },
      }, traceRecorder(titles, sections));

      const validationTrace = sections.filter((section) =>
        section.startsWith("## 后台 Assertion Agent · Schema 校验后的输出") ||
        section.startsWith("## 后台 Assertion Agent · 确定性预检反馈") ||
        section.startsWith("## 后台 Assertion Agent · 复核后的 Schema 输出") ||
        section.startsWith("## Object 候选校验") ||
        section.startsWith("## Assertion 候选校验")
      ).join("\n\n");
      expect(result.publishedAssertions, validationTrace).toBeGreaterThanOrEqual(2);
      expect(result.affectedObjects).toEqual(expect.arrayContaining([
        expect.objectContaining({ canonicalName: eventName }),
        expect.objectContaining({ canonicalName: groupName }),
      ]));
      expect(titles).toContain("后台 Assertion Agent · Schema 校验后的输出");

      const capture = await database.memoryChatAssertionCapture.findUniqueOrThrow({
        where: {
          queuedByActorId_queuedByMessageId: {
            queuedByActorId: currentMemoryActor().id,
            queuedByMessageId: multiFactMessageId,
          },
        },
        select: {
          assertions: {
            select: {
              statementTemplateMarkdown: true,
              chatEvidenceLinks: {
                select: { chatEvidence: { select: { clientMessageId: true } } },
              },
            },
          },
        },
      });
      expect(capture.assertions).toHaveLength(result.publishedAssertions);
      expect(capture.assertions.some((assertion) => {
        const evidenceMessageIds = assertion.chatEvidenceLinks.map((link) =>
          link.chatEvidence.clientMessageId
        );
        return evidenceMessageIds.includes(multiFactHistoryMessageId) &&
          evidenceMessageIds.includes(multiFactMessageId);
      })).toBe(true);
      await expect(database.memoryChatEvidence.count({
        where: {
          submittedByActorId: currentMemoryActor().id,
          clientMessageId: { in: [multiFactHistoryMessageId, multiFactMessageId] },
        },
      })).resolves.toBe(2);
    } finally {
      await cleanupChatCapture(multiFactMessageId, result);
    }
  }, 300_000);

  it("uses the searchable Object Higher Memory agent and restores its test target", async () => {
    const database = getDatabase();
    await requireSharedBrainIndex();
    const target = await database.memoryGlobalObject.findFirstOrThrow({
      where: {
        assertionLinks: { some: {} },
      },
      orderBy: { canonicalName: "asc" },
      select: {
        id: true,
        globalObjectKey: true,
        canonicalName: true,
        higherMemory: true,
      },
    });
    const titles: string[] = [];
    try {
      const maintained = await maintainObjectHigherMemories({
        clientMessageId: objectMaintenanceMessageId,
        submittedAt: "2026-08-15T01:10:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {
          conversation: [{
            messageId: objectMaintenanceMessageId,
            role: "user",
            text: `请根据已有记忆重新理解${target.canonicalName}。`,
            submittedAt: "2026-08-15T01:10:00.000Z",
          }],
          systemInstruction: "你是 Sydaris。",
          modelCalls: [],
          toolExecutions: [],
          finalAnswer: "我会基于已有记忆整理。",
        },
        retrieval: {
          ...emptyRetrieval(target.canonicalName),
          seedMap: {
            facets: [],
            objects: [{
              ref: "O1",
              id: target.id,
              globalObjectKey: target.globalObjectKey,
              canonicalName: target.canonicalName,
              surfaceForms: [target.canonicalName],
              matchedBy: [],
              matchedFacets: [],
              supportingAssertions: [],
              lexicalMatch: true,
              semanticMatch: false,
            }],
            assertions: [],
            connections: [],
          },
        },
        queueDecision: {
          objectIds: [target.id],
          reason: "验证搜索型 Higher Memory Agent 的强制工具提交兼容性",
        },
      }, traceRecorder(titles));

      expect(maintained).toBeGreaterThanOrEqual(0);
      expect(titles).toContain("后台 Higher Memory Agent · Schema 校验后的输出");
    } finally {
      if (target.higherMemory) {
        await database.memoryObjectHigherMemory.update({
          where: { globalObjectId: target.id },
          data: {
            cognitiveMemory: parseCognitiveMemory(target.higherMemory.cognitiveMemory),
            operationalIndex: parseOperationalMemoryIndex(target.higherMemory.operationalIndex),
            maintainedAt: target.higherMemory.maintainedAt,
            triggerMessageId: target.higherMemory.triggerMessageId,
            maintenanceReason: target.higherMemory.maintenanceReason,
            updatedAt: target.higherMemory.updatedAt,
          },
        });
      } else {
        await database.memoryObjectHigherMemory.deleteMany({
          where: {
            globalObjectId: target.id,
            triggerMessageId: objectMaintenanceMessageId,
          },
        });
      }
    }
  }, 300_000);
});
