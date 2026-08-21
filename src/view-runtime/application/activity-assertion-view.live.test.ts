import "dotenv/config";

import { afterAll, describe, expect, it } from "vitest";

import type { ViewInformationReference } from "@/agent-runtime/view-types";
import { buildViewContext } from "@/agent-runtime/view-context";
import { getDatabase } from "@/db";
import {
  captureChatAssertions,
  currentMemoryActor,
  type ChatAssertionCaptureResult,
} from "@/memory/chat-assertion";
import type { MemoryRetrievalResult } from "@/memory/types";
import {
  extensionRegistry,
  viewCommandBus,
  viewReadPort,
} from "@/shell/composition-root";

const runLive = process.env.ECHO_LIVE_ACTIVITY_VIEW_TEST === "1";
const viewKey = "activity_operations";
const eventName = "Echo视图闭环验收赛-20260821-D1";
const messageId = "live-activity-view-create-20260821-d1";

function emptyRetrieval(compilationId: string): MemoryRetrievalResult {
  return {
    query: eventName,
    mode: "object-assertion",
    compilationId,
    seedMap: { facets: [], objects: [], assertions: [], connections: [] },
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function referencesFor(snapshot: Awaited<ReturnType<typeof viewReadPort.query>>) {
  const references: ViewInformationReference[] = [{
    ref: "V1",
    label: "Activity Operations",
    target: { kind: "view", viewKey },
  }];
  snapshot.cards.forEach((card, index) => {
    references.push({
      ref: `V${index + 2}`,
      label: `Activity Operations / ${card.cardTypeKey}`,
      target: { kind: "card", viewKey, cardId: card.id },
    });
  });
  return references;
}

async function cleanupTestData(input: {
  capture?: ChatAssertionCaptureResult;
  cardId?: string;
  proposalId?: string;
  executionId?: string;
  appliedStateVersion?: bigint;
  baselineStateVersion?: bigint;
}) {
  const database = getDatabase();
  const evidenceRows = await database.memoryChatEvidence.findMany({
    where: { clientMessageId: messageId },
    select: {
      id: true,
      objectMentions: {
        select: {
          globalObject: { select: { id: true, globalObjectKey: true } },
        },
      },
    },
  });
  const namedObjects = await database.memoryGlobalObject.findMany({
    where: { canonicalName: eventName },
    select: {
      id: true,
      globalObjectKey: true,
      relatedViewCards: { select: { cardId: true } },
    },
  });
  const createdObjectIds = [...new Set([
    ...(input.capture?.affectedObjects
      .filter((object) => object.resolution === "created")
      .map((object) => object.id) ?? []),
    ...namedObjects
      .filter((object) => object.globalObjectKey.startsWith("chat-object:"))
      .map((object) => object.id),
    ...evidenceRows.flatMap((evidence) => evidence.objectMentions
      .map((mention) => mention.globalObject)
      .filter((object) => object.globalObjectKey.startsWith("chat-object:"))
      .map((object) => object.id)),
  ])];
  const cardIds = [...new Set([
    ...(input.cardId ? [input.cardId] : []),
    ...namedObjects.flatMap((object) => object.relatedViewCards.map((relation) => relation.cardId)),
  ])];

  const [candidateProposals, candidateExecutions, candidateOutbox] = await Promise.all([
    database.viewCommandProposal.findMany({
      where: { viewKey, commandKey: "activity.create_activity" },
      select: { id: true, inputJson: true },
    }),
    database.viewCommandExecution.findMany({
      where: { viewKey, commandKey: "activity.create_activity" },
      select: { id: true, inputJson: true, resultSummaryJson: true },
    }),
    database.domainEventOutbox.findMany({
      where: { viewKey, eventType: "activity.activity_created" },
      select: { id: true, payloadJson: true },
    }),
  ]);
  const proposalIds = [...new Set([
    ...(input.proposalId ? [input.proposalId] : []),
    ...candidateProposals.filter((proposal) => {
      const commandInput = objectValue(proposal.inputJson);
      return commandInput?.name === eventName ||
        (typeof commandInput?.objectId === "string" && createdObjectIds.includes(commandInput.objectId));
    }).map((proposal) => proposal.id),
  ])];
  const executionIds = [...new Set([
    ...(input.executionId ? [input.executionId] : []),
    ...candidateExecutions.filter((execution) => {
      const commandInput = objectValue(execution.inputJson);
      const summary = objectValue(execution.resultSummaryJson);
      return commandInput?.name === eventName ||
        (typeof commandInput?.objectId === "string" && createdObjectIds.includes(commandInput.objectId)) ||
        (typeof summary?.cardId === "string" && cardIds.includes(summary.cardId));
    }).map((execution) => execution.id),
  ])];
  const outboxIds = candidateOutbox.filter((event) => {
    const payload = objectValue(event.payloadJson);
    return typeof payload?.cardId === "string" && cardIds.includes(payload.cardId);
  }).map((event) => event.id);

  let stateRestored = input.appliedStateVersion === undefined;
  await database.$transaction(async (transaction) => {
    if (
      input.appliedStateVersion !== undefined &&
      input.baselineStateVersion !== undefined
    ) {
      const restored = await transaction.installedView.updateMany({
        where: { viewKey, stateVersion: input.appliedStateVersion },
        data: { stateVersion: input.baselineStateVersion },
      });
      stateRestored = restored.count === 1;
    }
    if (cardIds.length) {
      await transaction.viewCard.deleteMany({ where: { id: { in: cardIds } } });
    }
    if (proposalIds.length) {
      await transaction.viewCommandProposal.deleteMany({ where: { id: { in: proposalIds } } });
    }
    if (executionIds.length) {
      await transaction.viewCommandExecution.deleteMany({ where: { id: { in: executionIds } } });
    }
    if (outboxIds.length) {
      await transaction.domainEventOutbox.deleteMany({ where: { id: { in: outboxIds } } });
    }
    if (createdObjectIds.length) {
      await transaction.memoryObjectHigherMemory.deleteMany({
        where: { globalObjectId: { in: createdObjectIds } },
      });
    }
    await transaction.memoryChatAssertionCapture.deleteMany({
      where: { queuedByMessageId: messageId },
    });
    if (createdObjectIds.length) {
      await transaction.memoryGlobalObject.deleteMany({
        where: { id: { in: createdObjectIds } },
      });
    }
    await transaction.memoryChatEvidence.deleteMany({
      where: { clientMessageId: messageId },
    });
    const compilation = await transaction.memoryCompilation.findFirst({
      orderBy: [{ importedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (compilation) {
      const assertionCount = await transaction.memoryAssertion.count({
        where: { compilationId: compilation.id },
      });
      await transaction.memoryAssertionEmbeddingIndex.updateMany({
        where: { compilationId: compilation.id },
        data: { indexedAssertionCount: assertionCount, indexedAt: new Date() },
      });
    }
  }, { maxWait: 30_000, timeout: 120_000 });
  return { stateRestored };
}

describe.runIf(runLive)("Assertion to approved Activity View closed loop", () => {
  afterAll(async () => {
    await getDatabase().$disconnect();
  });

  it("publishes an activity Object, proposes a Card, approves it, and retrieves it", async () => {
    const database = getDatabase();
    await cleanupTestData({});
    const compilation = await database.memoryCompilation.findFirstOrThrow({
      orderBy: [{ importedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    const actor = currentMemoryActor();
    const initialSnapshot = await viewReadPort.query({
      viewKey,
      actor: { actorId: actor.id, permissions: ["view.read"] },
    });
    const baselineStateVersion = BigInt(initialSnapshot.stateVersion);
    let capture: ChatAssertionCaptureResult | undefined;
    let proposalId: string | undefined;
    let executionId: string | undefined;
    let cardId: string | undefined;
    let appliedStateVersion: bigint | undefined;

    try {
      const userMessage =
        `${eventName}定于2026年9月6日14:00在东区体育馆举行，目前处于筹备阶段。`;
      capture = await captureChatAssertions({
        clientMessageId: messageId,
        submittedAt: "2026-08-21T06:00:00.000Z",
        timezone: "Asia/Shanghai",
        semanticContext: {
          conversation: [{
            messageId,
            role: "user",
            text: userMessage,
            submittedAt: "2026-08-21T06:00:00.000Z",
          }],
          systemInstruction: "你是 Echo。本轮验证新活动从 Assertion 进入正式 Activity View 的审批闭环。",
          modelCalls: [],
          toolExecutions: [],
          finalAnswer: "收到，我会先记录活动事实，再提交正式活动卡片供审批。",
        },
        retrieval: emptyRetrieval(compilation.id),
        queueDecision: { reason: "用户明确陈述了新活动的名称、时间、地点和筹备状态" },
      });
      const eventObject = capture.affectedObjects.find(
        (object) => object.canonicalName === eventName,
      );
      expect(capture.publishedAssertions).toBeGreaterThanOrEqual(1);
      expect(eventObject).toMatchObject({ resolution: "created" });
      if (!eventObject) throw new Error("Assertion 没有形成测试活动 Object");

      const proposal = await viewCommandBus.dispatch({
        viewKey,
        commandKey: "activity.create_activity",
        commandVersion: "1",
        input: {
          objectId: eventObject.id,
          name: eventName,
          description: "Assertion → Proposal → Approval 闭环验收活动。",
          status: "PLANNING",
          time: { start: "2026-09-06" },
          format: "线下",
        },
        actor: { actorId: actor.id, permissions: ["view.write"] },
        initiator: "ai",
        expectedStateVersion: baselineStateVersion.toString(),
      });
      expect(proposal.kind).toBe("proposed");
      if (proposal.kind !== "proposed") throw new Error("AI 写入没有生成 Proposal");
      proposalId = proposal.proposalId;
      await expect(database.viewCard.count({
        where: {
          viewKey,
          cardTypeKey: "ActivityCard",
          relatedObjects: { some: { objectId: eventObject.id } },
        },
      })).resolves.toBe(0);

      const approved = await viewCommandBus.decideProposal({
        proposalId,
        decision: "approve",
        actor: { actorId: actor.id, permissions: ["view.approve", "view.write"] },
      });
      expect(approved.kind).toBe("executed");
      if (approved.kind !== "executed") throw new Error("Proposal 批准后没有执行");
      executionId = approved.executionId;
      appliedStateVersion = BigInt(approved.stateVersion);
      cardId = objectValue(approved.summary)?.cardId as string | undefined;
      expect(cardId).toMatch(/^[0-9a-f-]{36}$/i);
      if (!cardId) throw new Error("Command 结果没有返回 ActivityCard ID");

      const [card, storedProposal, execution, outbox] = await Promise.all([
        database.viewCard.findUnique({
          where: { id: cardId },
          include: { dimensions: true, relatedObjects: true },
        }),
        database.viewCommandProposal.findUnique({ where: { id: proposalId } }),
        database.viewCommandExecution.findUnique({ where: { id: executionId } }),
        database.domainEventOutbox.findFirst({
          where: {
            viewKey,
            stateVersion: appliedStateVersion,
            eventType: "activity.activity_created",
          },
        }),
      ]);
      expect(card).toMatchObject({ cardTypeKey: "ActivityCard", viewKey });
      expect(card?.dimensions).toContainEqual(expect.objectContaining({
        dimensionKey: "name",
        valueJson: eventName,
      }));
      expect(card?.relatedObjects.map((relation) => relation.objectId)).toEqual([eventObject.id]);
      expect(storedProposal?.status).toBe("applied");
      expect(objectValue(storedProposal?.inputJson)?.objectId).toBe(eventObject.id);
      expect(objectValue(execution?.inputJson)?.objectId).toBe(eventObject.id);
      expect(objectValue(outbox?.payloadJson)?.cardId).toBe(cardId);

      const snapshot = await viewReadPort.query({
        viewKey,
        actor: { actorId: actor.id, permissions: ["view.read"] },
      });
      const viewModule = extensionRegistry.getView(viewKey)!;
      const context = await buildViewContext({
        snapshot: { ...snapshot, references: referencesFor(snapshot) },
        viewLabel: viewModule.manifest.label,
        viewDescription: viewModule.manifest.description,
        cardTypes: viewModule.schema.cardTypes,
        focus: `查找${eventName}`,
        targetHints: [eventName],
      });
      expect(context.formalCardMissing).toBe(false);
      expect(context.relevantCards).toContainEqual(expect.objectContaining({
        id: cardId,
        relatedObjectIds: [eventObject.id],
      }));
      expect(context.evidence.objects).toContainEqual(expect.objectContaining({
        id: eventObject.id,
        canonicalName: eventName,
      }));
    } finally {
      const cleanup = await cleanupTestData({
        capture,
        cardId,
        proposalId,
        executionId,
        appliedStateVersion,
        baselineStateVersion,
      });
      expect(cleanup.stateRestored).toBe(true);
      const leftovers = await Promise.all([
        database.memoryGlobalObject.count({ where: { canonicalName: eventName } }),
        database.memoryChatEvidence.count({ where: { clientMessageId: messageId } }),
        database.memoryChatAssertionCapture.count({ where: { queuedByMessageId: messageId } }),
        database.viewCommandProposal.count({
          where: { viewKey, commandKey: "activity.create_activity", inputJson: { path: ["name"], equals: eventName } },
        }),
      ]);
      expect(leftovers).toEqual([0, 0, 0, 0]);
    }
  }, 900_000);
});
