import { afterAll, describe, expect, it } from "vitest";

import type { DebugTrace } from "@/ai/debug-trace";
import { getDatabase } from "@/db";
import {
  captureChatAssertions,
  type ChatAssertionCaptureResult,
  type ChatAssertionSemanticContext,
} from "@/memory/chat-assertion";
import {
  searchMemory,
  type MemoryExploreResult,
} from "@/memory/explore";
import { parseCognitiveMemory, renderCognitiveMemory } from "@/memory/higher-memory-document";
import { maintainObjectHigherMemories } from "@/memory/object-higher-memory";
import type {
  MemoryRetrievalResult,
} from "@/memory/types";

const runLive = process.env.SYDARIS_LIVE_MEMORY_CLOSED_LOOP_TEST === "1";
const eventName = "结构化闭环远航验收会";
const firstMessageId = "live-memory-closed-loop-create-001";
const updateMessageId = "live-memory-closed-loop-update-001";
const maintenanceOneMessageId = "live-memory-closed-loop-maintain-001";
const maintenanceTwoMessageId = "live-memory-closed-loop-maintain-002";
const testMessageIds = [firstMessageId, updateMessageId];

function traceRecorder(titles: string[]): DebugTrace {
  return {
    enabled: true,
    appendSection: async (title) => { titles.push(title); },
    appendJsonSection: async () => undefined,
    appendError: async () => undefined,
    flush: async () => undefined,
  };
}

function semanticContext(input: {
  messageId: string;
  text: string;
  submittedAt: string;
  finalAnswer: string;
}): ChatAssertionSemanticContext {
  return {
    conversation: [{
      messageId: input.messageId,
      role: "user",
      text: input.text,
      submittedAt: input.submittedAt,
    }],
    systemInstruction: "你是 Sydaris。本轮是隔离的真实记忆闭环测试。",
    modelCalls: [],
    toolExecutions: [],
    finalAnswer: input.finalAnswer,
  };
}

function emptyRetrieval(query: string): MemoryRetrievalResult {
  return {
    query,
    mode: "object-assertion",
    seedMap: { facets: [], objects: [], assertions: [], connections: [] },
  };
}

async function locate(input: {
  query: string;
  targetObjectId?: string;
}): Promise<{ result: MemoryExploreResult; retrieval: MemoryRetrievalResult }> {
  let retrieval: MemoryRetrievalResult | undefined;
  const result = await searchMemory({
    query: input.query,
    targetHints: [eventName],
    ...(input.targetObjectId ? { targetObjectIds: [input.targetObjectId] } : {}),
  }, { onLocate: (value) => { retrieval = value; } });
  if (!retrieval) throw new Error("Locate 没有返回底层 MemoryRetrievalResult");
  return { result, retrieval };
}

async function cleanupClosedLoopData(): Promise<void> {
  const database = getDatabase();
  const evidences = await database.memoryChatEvidence.findMany({
    where: { clientMessageId: { in: testMessageIds } },
    select: {
      id: true,
      objectMentions: {
        select: {
          globalObject: {
            select: { id: true, globalObjectKey: true },
          },
        },
      },
    },
  });
  const createdObjectIds = [...new Set(evidences.flatMap((evidence) =>
    evidence.objectMentions
      .map((mention) => mention.globalObject)
      .filter((object) => object.globalObjectKey.startsWith("chat-object:"))
      .map((object) => object.id)
  ))];

  await database.$transaction(async (transaction) => {
    if (createdObjectIds.length) {
      await transaction.memoryObjectHigherMemory.deleteMany({
        where: { globalObjectId: { in: createdObjectIds } },
      });
    }
    await transaction.memoryChatAssertionCapture.deleteMany({
      where: { queuedByMessageId: { in: testMessageIds } },
    });
    if (createdObjectIds.length) {
      await transaction.memoryGlobalObject.deleteMany({
        where: { id: { in: createdObjectIds } },
      });
    }
    await transaction.memoryChatEvidence.deleteMany({
      where: { clientMessageId: { in: testMessageIds } },
    });
    const assertionCount = await transaction.memoryAssertion.count();
    await transaction.memoryAssertionEmbeddingIndex.update({
      where: { id: "shared" },
      data: { indexedAssertionCount: assertionCount, indexedAt: new Date() },
    });
  }, { maxWait: 30_000, timeout: 120_000 });
}

describe.runIf(runLive)("real memory closed loop", () => {
  afterAll(async () => {
    await getDatabase().$disconnect();
  });

  it("creates, retrieves, raises, invalidates, and refreshes an activity memory", async () => {
    const database = getDatabase();
    await database.memoryAssertionEmbeddingIndex.findUniqueOrThrow({ where: { id: "shared" } });
    await cleanupClosedLoopData();
    const baselineAssertionCount = await database.memoryAssertion.count();
    const baselineProposalCount = await database.memoryObjectChangeProposal.count();
    const traceTitles: string[] = [];
    let firstCapture: ChatAssertionCaptureResult | undefined;
    let secondCapture: ChatAssertionCaptureResult | undefined;

    try {
      const firstText =
        `${eventName}定于2026年8月18日14:00举行，地点在南楼302，场地确认是当前最重要的准备事项。`;
      const firstContext = semanticContext({
        messageId: firstMessageId,
        text: firstText,
        submittedAt: "2026-08-15T02:00:00.000Z",
        finalAnswer: "收到，我会记住活动时间、地点和当前准备重点。",
      });
      firstCapture = await captureChatAssertions({
        clientMessageId: firstMessageId,
        submittedAt: "2026-08-15T02:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: firstContext,
        retrieval: emptyRetrieval(eventName),
        queueDecision: { reason: "用户给出了新活动的明确时间、地点和准备重点" },
      }, traceRecorder(traceTitles));

      expect(firstCapture.publishedAssertions).toBeGreaterThanOrEqual(1);
      const eventObject = firstCapture.affectedObjects.find((object) =>
        object.canonicalName === eventName
      );
      expect(eventObject).toMatchObject({ resolution: "created" });
      if (!eventObject) throw new Error("首次聊天没有形成活动 GlobalObject");

      const afterFirst = await locate({
        query: "活动什么时候、在哪里举行，当前准备重点是什么",
        targetObjectId: eventObject.id,
      });
      expect(afterFirst.result.objects.some((object) => object.id === eventObject.id)).toBe(true);
      expect(afterFirst.result.assertions.some((assertion) =>
        /2026.{0,12}8.{0,8}18|8月18/.test(assertion.renderedStatement)
      )).toBe(true);
      expect(afterFirst.result.assertions.some((assertion) =>
        /南楼\s*302/.test(assertion.renderedStatement)
      )).toBe(true);

      const firstMaintained = await maintainObjectHigherMemories({
        clientMessageId: maintenanceOneMessageId,
        submittedAt: "2026-08-15T02:05:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: firstContext,
        retrieval: afterFirst.retrieval,
        queueDecision: {
          objectIds: [eventObject.id],
          reason: "活动已形成多项可复用事实，需要建立 Object Higher Memory",
        },
      }, traceRecorder(traceTitles));
      expect(firstMaintained).toBe(1);
      const firstHigherMemory = await database.memoryObjectHigherMemory.findUniqueOrThrow({
        where: { globalObjectId: eventObject.id },
      });
      const firstCognitiveMemory = renderCognitiveMemory(
        parseCognitiveMemory(firstHigherMemory.cognitiveMemory),
      );
      expect(firstCognitiveMemory).toMatch(/南楼\s*302/);
      expect(firstCognitiveMemory).toMatch(/2026|8月18/);

      const updateText =
        `进展更新：${eventName}的地点已经从南楼302改为北楼505，举行时间仍是2026年8月18日14:00，其他安排不变。`;
      const updateContext = semanticContext({
        messageId: updateMessageId,
        text: updateText,
        submittedAt: "2026-08-15T02:10:00.000Z",
        finalAnswer: "收到，地点改为北楼505，时间保持不变。",
      });
      secondCapture = await captureChatAssertions({
        clientMessageId: updateMessageId,
        submittedAt: "2026-08-15T02:10:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: updateContext,
        retrieval: afterFirst.retrieval,
        queueDecision: { reason: "用户明确修改了活动地点并重申时间不变" },
      }, traceRecorder(traceTitles));
      expect(secondCapture.publishedAssertions).toBeGreaterThanOrEqual(1);
      expect(secondCapture.affectedObjectIds).toContain(eventObject.id);

      const whileStale = await locate({
        query: "活动当前地点和时间",
        targetObjectId: eventObject.id,
      });
      expect(whileStale.result.higherMemories?.some((memory) =>
        memory.globalObjectId === eventObject.id
      )).toBe(true);
      expect(whileStale.result.assertions.some((assertion) =>
        /北楼\s*505/.test(assertion.renderedStatement)
      )).toBe(true);
      expect(whileStale.result.warnings.some((warning) =>
        warning.includes("新的关联 Assertion")
      )).toBe(true);

      const refreshed = await maintainObjectHigherMemories({
        clientMessageId: maintenanceTwoMessageId,
        submittedAt: "2026-08-15T02:15:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: updateContext,
        retrieval: whileStale.retrieval,
        queueDecision: {
          objectIds: [eventObject.id],
          reason: "新 Assertion 改变了已有 Higher Memory 中的活动地点，需要刷新",
        },
      }, traceRecorder(traceTitles));
      expect(refreshed).toBe(1);

      const currentHigherMemory = await database.memoryObjectHigherMemory.findUniqueOrThrow({
        where: { globalObjectId: eventObject.id },
      });
      const currentCognitiveMemory = renderCognitiveMemory(
        parseCognitiveMemory(currentHigherMemory.cognitiveMemory),
      );
      expect(currentCognitiveMemory).toMatch(/北楼\s*505/);
      if (/南楼\s*302/.test(currentCognitiveMemory)) {
        expect(currentCognitiveMemory).toMatch(/改|原|此前|曾/);
      }

      const afterRefresh = await locate({
        query: "活动当前地点和时间",
        targetObjectId: eventObject.id,
      });
      const refreshedMemory = afterRefresh.result.higherMemories?.find((memory) =>
        memory.globalObjectId === eventObject.id
      );
      expect(refreshedMemory?.contentMarkdown).toMatch(/北楼\s*505/);
      expect(afterRefresh.result.assertions.length).toBeGreaterThan(0);
      expect(afterRefresh.result.warnings.some((warning) =>
        warning.includes("当前 query 仍独立检索/筛选 Assertions")
      )).toBe(true);

      expect(traceTitles).toContain("后台 Assertion Agent · Schema 校验后的输出");
      expect(traceTitles).toContain("后台 Higher Memory Agent · Schema 校验后的输出");
      const proposalCount = await database.memoryObjectChangeProposal.count();
      expect(proposalCount).toBe(baselineProposalCount);
    } finally {
      await cleanupClosedLoopData();
      const finalAssertionCount = await database.memoryAssertion.count();
      const finalIndex = await database.memoryAssertionEmbeddingIndex.findUniqueOrThrow({
        where: { id: "shared" },
      });
      expect(finalAssertionCount).toBe(baselineAssertionCount);
      expect(finalIndex.indexedAssertionCount).toBe(baselineAssertionCount);
      const leftovers = await Promise.all([
        database.memoryChatAssertionCapture.count({
          where: { queuedByMessageId: { in: testMessageIds } },
        }),
        database.memoryChatEvidence.count({
          where: { clientMessageId: { in: testMessageIds } },
        }),
        database.memoryGlobalObject.count({
          where: { canonicalName: eventName },
        }),
        database.memoryObjectHigherMemory.count({
          where: {
            triggerMessageId: { in: [maintenanceOneMessageId, maintenanceTwoMessageId] },
          },
        }),
      ]);
      expect(leftovers).toEqual([0, 0, 0, 0]);
    }
  }, 900_000);
});
