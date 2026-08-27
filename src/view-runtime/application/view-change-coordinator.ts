import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import type { ViewChangeAttentionDecision } from "@/ai/view-change-observer";
import type {
  ViewChange,
  ViewReadPort,
  ViewReactionAttentionPolicy,
} from "@/contracts";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import type {
  ViewChangeEvent,
  ViewChangeExecution,
  ViewRelatedObject,
} from "@/view-runtime/application/view-change-context";

export type ViewAttentionEvaluator = (input: {
  viewModule: NonNullable<ReturnType<ExtensionRegistry["getView"]>>;
  snapshot: Awaited<ReturnType<ViewReadPort["query"]>>;
  executions: readonly ViewChangeExecution[];
  events: readonly ViewChangeEvent[];
  objects: readonly ViewRelatedObject[];
  conversation: readonly [];
  attentionPolicy: ViewReactionAttentionPolicy;
  reactionGuidance: readonly string[];
}) => Promise<ViewChangeAttentionDecision>;

export type ViewHigherMemoryReconciler = (input: {
  viewModule: NonNullable<ReturnType<ExtensionRegistry["getView"]>>;
  snapshot: Awaited<ReturnType<ViewReadPort["query"]>>;
  executions: readonly ViewChangeExecution[];
  events: readonly ViewChangeEvent[];
  objects: readonly ViewRelatedObject[];
}) => Promise<number>;

function storedChanges(value: Prisma.JsonValue): ViewChange[] {
  return Array.isArray(value) ? value as ViewChange[] : [];
}

function storedObjects(value: Prisma.JsonValue): ViewRelatedObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const id = item.id;
    const canonicalName = item.canonicalName;
    if (typeof id !== "string" || typeof canonicalName !== "string") return [];
    return [{
      id,
      canonicalName,
      ...("cognitiveMemory" in item ? { cognitiveMemory: item.cognitiveMemory } : {}),
    }];
  });
}

function storedStrings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function targetCardIds(value: Prisma.JsonValue): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    return typeof item.cardId === "string" ? [item.cardId] : [];
  }));
}

export class ViewChangeCoordinator {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly knowledgeChains = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: {
    database: PrismaClient;
    registry: ExtensionRegistry;
    readPort: ViewReadPort;
    evaluate: ViewAttentionEvaluator;
    reconcileHigherMemory: ViewHigherMemoryReconciler;
  }) {}

  async enqueue(input: { reactionId: string; actorId: string }): Promise<boolean> {
    const reaction = await this.dependencies.database.viewChangeReaction.findFirst({
      where: { id: input.reactionId, actorId: input.actorId },
      select: { id: true, settleUntil: true, attentionStatus: true, knowledgeStatus: true },
    });
    if (!reaction) return false;
    if (reaction.attentionStatus !== "queued" && reaction.knowledgeStatus !== "queued") {
      return false;
    }
    this.schedule(reaction.id, reaction.settleUntil);
    return true;
  }

  async resumePending(input: { actorId: string; viewKey: string }): Promise<number> {
    const reactions = await this.dependencies.database.viewChangeReaction.findMany({
      where: {
        actorId: input.actorId,
        viewKey: input.viewKey,
        OR: [{ attentionStatus: "queued" }, { knowledgeStatus: "queued" }],
      },
      select: { id: true, settleUntil: true },
    });
    reactions.forEach((reaction) => this.schedule(reaction.id, reaction.settleUntil));
    return reactions.length;
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  private schedule(reactionId: string, settleUntil: Date): void {
    const existing = this.timers.get(reactionId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, settleUntil.getTime() - Date.now());
    this.timers.set(reactionId, setTimeout(() => void this.flush(reactionId), delay));
  }

  private enqueueKnowledge(viewKey: string, job: () => Promise<void>): Promise<void> {
    const previous = this.knowledgeChains.get(viewKey) ?? Promise.resolve();
    const scheduled = previous.catch(() => undefined).then(job);
    this.knowledgeChains.set(viewKey, scheduled);
    void scheduled.finally(() => {
      if (this.knowledgeChains.get(viewKey) === scheduled) {
        this.knowledgeChains.delete(viewKey);
      }
    });
    return scheduled;
  }

  private async flush(reactionId: string): Promise<void> {
    this.timers.delete(reactionId);
    const database = this.dependencies.database;
    try {
      const pending = await database.viewChangeReaction.findUnique({ where: { id: reactionId } });
      if (!pending) return;
      if (pending.settleUntil.getTime() > Date.now()) {
        this.schedule(pending.id, pending.settleUntil);
        return;
      }
      const now = new Date();
      await Promise.all([
        pending.attentionStatus === "queued"
          ? database.viewChangeReaction.updateMany({
              where: { id: reactionId, attentionStatus: "queued" },
              data: { attentionStatus: "running", attentionStartedAt: now },
            })
          : Promise.resolve(),
        pending.knowledgeStatus === "queued"
          ? database.viewChangeReaction.updateMany({
              where: { id: reactionId, knowledgeStatus: "queued" },
              data: { knowledgeStatus: "running", knowledgeStartedAt: now },
            })
          : Promise.resolve(),
      ]);

      const reaction = await database.viewChangeReaction.findUnique({
        where: { id: reactionId },
        include: { execution: true },
      });
      if (!reaction) return;
      if (reaction.attentionStatus !== "running" && reaction.knowledgeStatus !== "running") return;
      const viewModule = this.dependencies.registry.getView(reaction.viewKey);
      if (!viewModule) throw new Error(`View ${reaction.viewKey} 未加载`);

      const eventRows = await database.domainEventOutbox.findMany({
        where: { viewKey: reaction.viewKey, stateVersion: reaction.stateVersion },
        orderBy: { occurredAt: "asc" },
      });
      const snapshot = await this.dependencies.readPort.query({
        viewKey: reaction.viewKey,
        actor: { actorId: reaction.actorId ?? undefined, permissions: ["view.read"] },
      });
      const changes = storedChanges(reaction.execution.changeSetJson);
      const execution: ViewChangeExecution = {
        id: reaction.execution.id,
        commandKey: reaction.execution.commandKey,
        input: reaction.execution.inputJson,
        result: reaction.execution.resultSummaryJson,
        stateVersionBefore: reaction.execution.stateVersionBefore.toString(),
        stateVersionAfter: reaction.execution.stateVersionAfter.toString(),
        changes,
      };
      const events: ViewChangeEvent[] = eventRows.map((event) => ({
        type: event.eventType,
        version: event.eventVersion,
        payload: event.payloadJson,
        stateVersion: event.stateVersion.toString(),
      }));
      const impactedCardIds = targetCardIds(reaction.targetsJson);
      const reactionSnapshot = {
        ...snapshot,
        cards: snapshot.cards.filter((card) => impactedCardIds.has(card.id)),
      };
      // This is the immutable pre-change knowledge snapshot persisted with the command.
      // Both workers receive it concurrently, so reconciliation cannot corroborate itself.
      const priorObjects = storedObjects(reaction.priorObjectsJson);
      const guidance = storedStrings(reaction.guidanceJson);

      const jobs: Promise<void>[] = [];
      if (reaction.attentionStatus === "running") {
        jobs.push(this.dependencies.evaluate({
          viewModule,
          snapshot: reactionSnapshot,
          executions: [execution],
          events,
          objects: priorObjects,
          conversation: [],
          attentionPolicy: reaction.attentionPolicy as ViewReactionAttentionPolicy,
          reactionGuidance: guidance,
        }).then(async (decision) => {
          const attentionStatus = decision.action === "request_confirmation"
            ? "needs_confirmation"
            : decision.action;
          await database.viewChangeReaction.update({
            where: { id: reaction.id },
            data: {
              attentionStatus,
              message: decision.message || null,
              reason: decision.reason,
              attentionCompletedAt: new Date(),
            },
          });
          console.info("[view.reaction.attention]", JSON.stringify({
            viewKey: reaction.viewKey,
            reactionId: reaction.id,
            status: attentionStatus,
            reason: decision.reason,
          }));
        }).catch(async (error: unknown) => {
          await database.viewChangeReaction.update({
            where: { id: reaction.id },
            data: {
              attentionStatus: "failed",
              attentionErrorMessage: error instanceof Error ? error.message : String(error),
              attentionCompletedAt: new Date(),
            },
          });
          console.error("[view.reaction.attention]", error);
        }));
      }
      if (reaction.knowledgeStatus === "running") {
        jobs.push(this.enqueueKnowledge(reaction.viewKey, async () => {
          try {
            const newerReconciliation = await database.viewChangeReaction.count({
              where: {
                viewKey: reaction.viewKey,
                stateVersion: { gt: reaction.stateVersion },
                knowledgePolicy: "reconcile",
                knowledgeStatus: { not: "failed" },
              },
            });
            if (newerReconciliation) {
              await database.viewChangeReaction.update({
                where: { id: reaction.id },
                data: { knowledgeStatus: "completed", knowledgeCompletedAt: new Date() },
              });
              console.info("[view.reaction.knowledge]", JSON.stringify({
                viewKey: reaction.viewKey,
                reactionId: reaction.id,
                skipped: "superseded",
              }));
              return;
            }
            const maintained = await this.dependencies.reconcileHigherMemory({
              viewModule,
              snapshot: reactionSnapshot,
              executions: [execution],
              events,
              objects: priorObjects,
            });
            await database.viewChangeReaction.update({
              where: { id: reaction.id },
              data: { knowledgeStatus: "completed", knowledgeCompletedAt: new Date() },
            });
            console.info("[view.reaction.knowledge]", JSON.stringify({
              viewKey: reaction.viewKey,
              reactionId: reaction.id,
              maintained,
            }));
          } catch (error) {
            await database.viewChangeReaction.update({
              where: { id: reaction.id },
              data: {
                knowledgeStatus: "failed",
                knowledgeErrorMessage: error instanceof Error ? error.message : String(error),
                knowledgeCompletedAt: new Date(),
              },
            });
            console.error("[view.reaction.knowledge]", error);
          }
        }));
      }
      await Promise.all(jobs);
    } catch (error) {
      console.error("[view.reaction]", error);
      const completedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      await Promise.all([
        database.viewChangeReaction.updateMany({
          where: { id: reactionId, attentionStatus: { in: ["queued", "running"] } },
          data: {
            attentionStatus: "failed",
            attentionErrorMessage: message,
            attentionCompletedAt: completedAt,
          },
        }),
        database.viewChangeReaction.updateMany({
          where: { id: reactionId, knowledgeStatus: { in: ["queued", "running"] } },
          data: {
            knowledgeStatus: "failed",
            knowledgeErrorMessage: message,
            knowledgeCompletedAt: completedAt,
          },
        }),
      ]).catch(() => undefined);
    }
  }
}
