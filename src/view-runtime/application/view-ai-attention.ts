import type { PrismaClient } from "@/generated/prisma/client";

import type { ClubChatMessage } from "@/ai/types";
import type {
  ViewChangeAttentionDecision,
  ViewChangeEvent,
  ViewChangeExecution,
  ViewRelatedObject,
} from "@/ai/view-change-observer";
import type { ViewReadPort } from "@/contracts";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";

type AttentionTiming = "next_turn" | "after_settle" | "immediate";

export type ViewAIAttentionSchedule = "scheduled" | "next_turn" | "ignored";

type PendingBatch = {
  actor: { id: string; displayName: string };
  conversationId: string;
  viewKey: string;
  executionIds: Set<string>;
  timer: ReturnType<typeof setTimeout>;
};

export type ViewAttentionEvaluator = (input: {
  viewModule: NonNullable<ReturnType<ExtensionRegistry["getView"]>>;
  snapshot: Awaited<ReturnType<ViewReadPort["query"]>>;
  executions: readonly ViewChangeExecution[];
  events: readonly ViewChangeEvent[];
  objects: readonly ViewRelatedObject[];
  conversation: readonly ClubChatMessage[];
}) => Promise<ViewChangeAttentionDecision>;

export type ViewAttentionMessageAppender = (input: {
  actor: { id: string; displayName: string };
  conversationId: string;
  text: string;
}) => Promise<unknown>;

export type ViewAttentionConversationLoader = (input: {
  actor: { id: string; displayName: string };
  conversationId: string;
}) => Promise<ClubChatMessage[]>;

const timingRank: Record<AttentionTiming, number> = {
  next_turn: 0,
  after_settle: 1,
  immediate: 2,
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function collectIds(value: unknown, target: Set<string>): void {
  if (typeof value === "string") {
    if (uuid.test(value)) target.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectIds(item, target));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.values(value).forEach((item) => collectIds(item, target));
}

export function configuredViewAttentionSettleMs(
  environment: Record<string, string | undefined> = process.env,
): number {
  const raw = environment.VIEW_AI_ATTENTION_SETTLE_MS?.trim();
  if (!raw) return 20_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error("VIEW_AI_ATTENTION_SETTLE_MS 必须是 1000 到 300000 之间的整数");
  }
  return value;
}

export class ViewAIAttentionCoordinator {
  private readonly batches = new Map<string, PendingBatch>();

  constructor(private readonly dependencies: {
    database: PrismaClient;
    registry: ExtensionRegistry;
    readPort: ViewReadPort;
    evaluate: ViewAttentionEvaluator;
    appendMessage: ViewAttentionMessageAppender;
    loadConversation: ViewAttentionConversationLoader;
    defaultSettleMs?: number;
  }) {}

  async enqueue(input: {
    executionId: string;
    actor: { id: string; displayName: string };
    conversationId: string;
  }): Promise<ViewAIAttentionSchedule> {
    const execution = await this.dependencies.database.viewCommandExecution.findFirst({
      where: {
        id: input.executionId,
        actorId: input.actor.id,
        initiator: "human",
      },
      select: {
        id: true,
        viewKey: true,
        stateVersionAfter: true,
      },
    });
    if (!execution) return "ignored";
    const viewModule = this.dependencies.registry.getView(execution.viewKey);
    if (!viewModule) return "ignored";
    const events = await this.dependencies.database.domainEventOutbox.findMany({
      where: {
        viewKey: execution.viewKey,
        stateVersion: execution.stateVersionAfter,
      },
      select: { eventType: true, eventVersion: true },
    });
    const policies = events.flatMap((event) => {
      const definition = viewModule.events.find((candidate) =>
        candidate.key === event.eventType && candidate.version === event.eventVersion
      );
      return definition?.aiAttention ? [definition.aiAttention] : [];
    });
    if (!policies.length) return "ignored";
    const strongest = policies.reduce<{
      timing: AttentionTiming;
      settleMs?: number;
    }>((current, policy) =>
      timingRank[policy.timing] > timingRank[current.timing] ? policy : current
    , { timing: "next_turn" });
    if (strongest.timing === "next_turn") return "next_turn";

    const key = `${input.actor.id}:${input.conversationId}:${execution.viewKey}`;
    const existing = this.batches.get(key);
    if (existing) clearTimeout(existing.timer);
    const executionIds = existing?.executionIds ?? new Set<string>();
    executionIds.add(execution.id);
    const delay = strongest.timing === "immediate"
      ? 0
      : strongest.settleMs ?? this.dependencies.defaultSettleMs ?? configuredViewAttentionSettleMs();
    const batch: PendingBatch = {
      actor: input.actor,
      conversationId: input.conversationId,
      viewKey: execution.viewKey,
      executionIds,
      timer: setTimeout(() => void this.flush(key), delay),
    };
    this.batches.set(key, batch);
    return "scheduled";
  }

  dispose(): void {
    this.batches.forEach((batch) => clearTimeout(batch.timer));
    this.batches.clear();
  }

  private async flush(key: string): Promise<void> {
    const batch = this.batches.get(key);
    if (!batch) return;
    this.batches.delete(key);
    try {
      const viewModule = this.dependencies.registry.getView(batch.viewKey);
      if (!viewModule) return;
      const rows = await this.dependencies.database.viewCommandExecution.findMany({
        where: {
          id: { in: [...batch.executionIds] },
          actorId: batch.actor.id,
          initiator: "human",
        },
        orderBy: [{ stateVersionAfter: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          commandKey: true,
          inputJson: true,
          resultSummaryJson: true,
          stateVersionBefore: true,
          stateVersionAfter: true,
        },
      });
      if (!rows.length) return;
      const stateVersions = rows.map((row) => row.stateVersionAfter);
      const eventRows = await this.dependencies.database.domainEventOutbox.findMany({
        where: { viewKey: batch.viewKey, stateVersion: { in: stateVersions } },
        orderBy: [{ stateVersion: "asc" }, { occurredAt: "asc" }],
        select: { eventType: true, payloadJson: true, stateVersion: true },
      });
      const snapshot = await this.dependencies.readPort.query({
        viewKey: batch.viewKey,
        actor: { actorId: batch.actor.id, permissions: ["view.read"] },
      });
      const executions: ViewChangeExecution[] = rows.map((row) => ({
        id: row.id,
        commandKey: row.commandKey,
        input: row.inputJson,
        result: row.resultSummaryJson,
        stateVersionBefore: row.stateVersionBefore.toString(),
        stateVersionAfter: row.stateVersionAfter.toString(),
      }));
      const events: ViewChangeEvent[] = eventRows.map((event) => ({
        type: event.eventType,
        payload: event.payloadJson,
        stateVersion: event.stateVersion.toString(),
      }));
      const referencedIds = new Set<string>();
      executions.forEach((executionRow) => {
        collectIds(executionRow.input, referencedIds);
        collectIds(executionRow.result, referencedIds);
      });
      events.forEach((event) => collectIds(event.payload, referencedIds));
      const impactedCards = snapshot.cards.filter((card) => referencedIds.has(card.id));
      if (!impactedCards.length) return;
      const attentionSnapshot = { ...snapshot, cards: impactedCards };
      const impactedObjectIds = new Set(impactedCards
        .flatMap((card) => card.relatedObjectIds));
      const objectIds = [...new Set(impactedCards.flatMap((card) => card.relatedObjectIds))];
      const objectRows = objectIds.length
        ? await this.dependencies.database.memoryGlobalObject.findMany({
            where: { id: { in: objectIds } },
            orderBy: { canonicalName: "asc" },
            select: {
              id: true,
              canonicalName: true,
              higherMemory: { select: { cognitiveMemory: true } },
            },
          })
        : [];
      const objects: ViewRelatedObject[] = objectRows.map((object) => ({
        id: object.id,
        canonicalName: object.canonicalName,
        ...(impactedObjectIds.has(object.id) && object.higherMemory
          ? { cognitiveMemory: object.higherMemory.cognitiveMemory }
          : {}),
      }));
      const conversation = await this.dependencies.loadConversation({
        actor: batch.actor,
        conversationId: batch.conversationId,
      });
      const decision = await this.dependencies.evaluate({
        viewModule,
        snapshot: attentionSnapshot,
        executions,
        events,
        objects,
        conversation,
      });
      console.info("[view.ai-attention]", JSON.stringify({
        viewKey: batch.viewKey,
        executionCount: executions.length,
        action: decision.action,
        reason: decision.reason,
      }));
      if (decision.action === "silent") return;
      await this.dependencies.appendMessage({
        actor: batch.actor,
        conversationId: batch.conversationId,
        text: decision.message,
      });
    } catch (error) {
      console.error("[view.ai-attention]", error);
    }
  }
}
