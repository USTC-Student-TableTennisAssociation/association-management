import { afterAll, describe, expect, it } from "vitest";

import type { EchoDebugTrace } from "@/ai/debug-trace";
import { getDatabase } from "@/db";
import {
  captureChatAssertions,
  currentMemoryActor,
  type ChatAssertionCaptureResult,
} from "@/memory/chat-assertion";
import { maintainObjectHigherMemories } from "@/memory/object-higher-memory";
import {
  curateRetrievalAssertions,
  resolveRetrievalTargets,
} from "@/memory/retrieval-curator";
import type { MemoryRetrievalResult } from "@/memory/types";

const runLive = process.env.ECHO_LIVE_STRUCTURED_SUBMISSION_TEST === "1";
const chatMessageId = "live-structured-submission-chat-001";
const objectMaintenanceMessageId = "live-structured-submission-object-memory-001";

function traceRecorder(titles: string[]): EchoDebugTrace {
  return {
    enabled: true,
    appendSection: async (title) => { titles.push(title); },
    appendJsonSection: async () => undefined,
    appendError: async () => undefined,
    flush: async () => undefined,
  };
}

async function latestCompilation() {
  return getDatabase().memoryCompilation.findFirstOrThrow({
    orderBy: [{ importedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
}

function emptyRetrieval(compilationId: string, query: string): MemoryRetrievalResult {
  return {
    query,
    mode: "object-assertion",
    compilationId,
    seedMap: { facets: [], objects: [], assertions: [], connections: [] },
  };
}

describe.runIf(runLive)("GLM structured submission compatibility", () => {
  afterAll(async () => {
    await getDatabase().$disconnect();
  });

  it("uses forced tool submissions for both Retrieval Curator decisions", async () => {
    const context = {
      conversation: [{
        messageId: "live-curator-user-001",
        role: "user" as const,
        text: "我说的是星河协会本身，不是星河协会知识库。",
      }],
      originalUserMessage: "那它现在最需要处理什么？",
      currentInstant: "2026-08-15T01:00:00.000Z",
      timezone: "Asia/Shanghai",
    };
    const objects = [{
      id: "association",
      canonicalName: "星河协会",
      surfaceForms: ["协会"],
      lexicalMatch: true,
      semanticMatch: true,
    }, {
      id: "knowledge-base",
      canonicalName: "星河协会知识库",
      surfaceForms: ["知识库"],
      lexicalMatch: true,
      semanticMatch: true,
    }];

    const targets = await resolveRetrievalTargets({
      query: "当前重点",
      targetHints: ["它"],
      candidates: objects,
      context,
    });
    expect(targets.mode).toBe("model");
    expect(targets.targetObjectIds).toEqual(["association"]);

    const assertions = await curateRetrievalAssertions({
      query: "当前重点",
      targetHints: ["星河协会"],
      targetObjects: [objects[0]],
      candidates: [{
        id: "direct",
        renderedStatement: "星河协会当前重点是完成场地确认。",
        kind: "grounded",
        contextDependent: false,
        sourceSummary: ["chat:test"],
      }, {
        id: "unrelated",
        renderedStatement: "星河协会知识库收录了历史材料。",
        kind: "grounded",
        contextDependent: false,
        sourceSummary: ["document:test"],
      }],
      context,
    });
    expect(assertions.mode).toBe("model");
    expect(assertions.selectedAssertionIds).toContain("direct");
  }, 180_000);

  it("lets Chat Assertion explicitly submit an empty extraction", async () => {
    const database = getDatabase();
    const compilation = await latestCompilation();
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
          systemInstruction: "你是 Echo。",
          modelCalls: [],
          toolExecutions: [],
          finalAnswer: "可以改成：欢迎参加。",
        },
        retrieval: emptyRetrieval(compilation.id, "普通改写任务"),
        queueDecision: { reason: "兼容性测试故意触发提取，模型应判断没有组织事实" },
      }, traceRecorder(titles));

      expect(result.publishedAssertions).toBe(0);
      expect(titles).toContain("后台 Assertion Agent · Schema 校验后的输出");
    } finally {
      const actor = currentMemoryActor();
      const capture = await database.memoryChatAssertionCapture.findUnique({
        where: {
          queuedByActorId_queuedByMessageId: {
            queuedByActorId: actor.id,
            queuedByMessageId: chatMessageId,
          },
        },
        select: { id: true, compilationId: true, assertions: { select: { id: true } } },
      });
      if (capture) {
        await database.$transaction(async (transaction) => {
          await transaction.memoryChatAssertionCapture.delete({ where: { id: capture.id } });
          await transaction.memoryChatEvidence.deleteMany({
            where: { submittedByActorId: actor.id, clientMessageId: chatMessageId },
          });
          await transaction.memoryAssertionEmbeddingIndex.update({
            where: { compilationId: capture.compilationId },
            data: { indexedAssertionCount: { decrement: capture.assertions.length } },
          });
          const createdObjectIds = result?.affectedObjects
            .filter((object) => object.resolution === "created")
            .map((object) => object.id) ?? [];
          if (createdObjectIds.length) {
            await transaction.memoryGlobalObject.deleteMany({
              where: { id: { in: createdObjectIds } },
            });
          }
        });
      }
    }
  }, 240_000);

  it("uses the searchable Object Higher Memory agent and restores its test target", async () => {
    const database = getDatabase();
    const compilation = await latestCompilation();
    const target = await database.memoryGlobalObject.findFirstOrThrow({
      where: {
        compilationId: compilation.id,
        literalReferences: { some: {} },
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
          systemInstruction: "你是 Echo。",
          modelCalls: [],
          toolExecutions: [],
          finalAnswer: "我会基于已有记忆整理。",
        },
        retrieval: {
          ...emptyRetrieval(compilation.id, target.canonicalName),
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
            contentMarkdown: target.higherMemory.contentMarkdown,
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
