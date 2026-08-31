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

const STALE_REACTION_AFTER_MS = 10 * 60 * 1_000;

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

type ViewKnowledgeReconciliationInput = {
  viewModule: NonNullable<ReturnType<ExtensionRegistry["getView"]>>;
  snapshot: Awaited<ReturnType<ViewReadPort["query"]>>;
  executions: readonly ViewChangeExecution[];
  events: readonly ViewChangeEvent[];
  objects: readonly ViewRelatedObject[];
};

export type ObjectHigherMemoryReconciler = (
  input: ViewKnowledgeReconciliationInput,
) => Promise<number>;

export type ViewHigherMemoryReconciler = (
  input: ViewKnowledgeReconciliationInput,
) => Promise<number>;

function storedChanges(value: Prisma.JsonValue): ViewChange[] {
  return Array.isArray(value) ? value as ViewChange[] : [];
}

function storedEvents(value: Prisma.JsonValue, stateVersion: string): ViewChangeEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    if (typeof item.type !== "string" || typeof item.version !== "string") return [];
    return [{
      type: item.type,
      version: item.version,
      payload: "payload" in item ? item.payload : null,
      stateVersion,
    }];
  });
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
    reconcileObjectHigherMemory: ObjectHigherMemoryReconciler;
    reconcileViewHigherMemory: ViewHigherMemoryReconciler;
  }) {}

  async enqueue(input: { reactionId: string }): Promise<boolean> {
    const reaction = await this.dependencies.database.viewChangeReaction.findUnique({
      where: { id: input.reactionId },
      select: { id: true, settleUntil: true, attentionStatus: true, knowledgeStatus: true },
    });
    if (!reaction) return false;
    if (reaction.attentionStatus !== "queued" && reaction.knowledgeStatus !== "queued") {
      return false;
    }
    this.schedule(reaction.id, reaction.settleUntil);
    return true;
  }

  async resumePending(input: { viewKey: string }): Promise<number> {
    const staleBefore = new Date(Date.now() - STALE_REACTION_AFTER_MS);
    await Promise.all([
      this.dependencies.database.viewChangeReaction.updateMany({
        where: {
          viewKey: input.viewKey,
          attentionStatus: "running",
          OR: [
            { attentionStartedAt: null },
            { attentionStartedAt: { lt: staleBefore } },
          ],
        },
        data: {
          attentionStatus: "queued",
          attentionStartedAt: null,
          attentionErrorMessage: null,
        },
      }),
      this.dependencies.database.viewChangeReaction.updateMany({
        where: {
          viewKey: input.viewKey,
          knowledgeStatus: "running",
          OR: [
            { knowledgeStartedAt: null },
            { knowledgeStartedAt: { lt: staleBefore } },
          ],
        },
        data: {
          knowledgeStatus: "queued",
          knowledgeStartedAt: null,
          knowledgeErrorMessage: null,
        },
      }),
    ]);
    const reactions = await this.dependencies.database.viewChangeReaction.findMany({
      where: {
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
    let attentionClaimed = false;
    let knowledgeClaimed = false;
    let claimStartedAt: Date | undefined;
    try {
      const pending = await database.viewChangeReaction.findUnique({ where: { id: reactionId } });
      if (!pending) return;
      if (pending.settleUntil.getTime() > Date.now()) {
        this.schedule(pending.id, pending.settleUntil);
        return;
      }
      claimStartedAt = new Date();
      const startedAt = claimStartedAt;
      const [attentionClaim, knowledgeClaim] = await Promise.all([
        pending.attentionStatus === "queued"
          ? database.viewChangeReaction.updateMany({
              where: { id: reactionId, attentionStatus: "queued" },
              data: { attentionStatus: "running", attentionStartedAt: startedAt },
            })
          : Promise.resolve({ count: 0 }),
        pending.knowledgeStatus === "queued"
          ? database.viewChangeReaction.updateMany({
              where: { id: reactionId, knowledgeStatus: "queued" },
              data: { knowledgeStatus: "running", knowledgeStartedAt: startedAt },
            })
          : Promise.resolve({ count: 0 }),
      ]);
      attentionClaimed = attentionClaim.count === 1;
      knowledgeClaimed = knowledgeClaim.count === 1;
      if (!attentionClaimed && !knowledgeClaimed) return;

      const reaction = await database.viewChangeReaction.findUnique({
        where: { id: reactionId },
        include: { execution: true },
      });
      if (!reaction) return;
      const viewModule = this.dependencies.registry.getView(reaction.viewKey);
      if (!viewModule) throw new Error(`View ${reaction.viewKey} 未加载`);

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
      const events = storedEvents(
        reaction.execution.eventsJson,
        reaction.execution.stateVersionAfter.toString(),
      );
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
      if (attentionClaimed) {
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
          await database.viewChangeReaction.updateMany({
            where: {
              id: reaction.id,
              attentionStatus: "running",
              attentionStartedAt: startedAt,
            },
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
          await database.viewChangeReaction.updateMany({
            where: {
              id: reaction.id,
              attentionStatus: "running",
              attentionStartedAt: startedAt,
            },
            data: {
              attentionStatus: "failed",
              attentionErrorMessage: error instanceof Error ? error.message : String(error),
              attentionCompletedAt: new Date(),
            },
          });
          console.error("[view.reaction.attention]", error);
        }));
      }
      if (knowledgeClaimed) {
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
              await database.viewChangeReaction.updateMany({
                where: {
                  id: reaction.id,
                  knowledgeStatus: "running",
                  knowledgeStartedAt: startedAt,
                },
                data: { knowledgeStatus: "completed", knowledgeCompletedAt: new Date() },
              });
              console.info("[view.reaction.knowledge]", JSON.stringify({
                viewKey: reaction.viewKey,
                reactionId: reaction.id,
                skipped: "superseded",
              }));
              return;
            }
            const [objectMemories, viewMemories] = await Promise.all([
              this.dependencies.reconcileObjectHigherMemory({
                viewModule,
                snapshot: reactionSnapshot,
                executions: [execution],
                events,
                objects: priorObjects,
              }),
              this.dependencies.reconcileViewHigherMemory({
                viewModule,
                snapshot,
                executions: [execution],
                events,
                objects: priorObjects,
              }),
            ]);
            await database.viewChangeReaction.updateMany({
              where: {
                id: reaction.id,
                knowledgeStatus: "running",
                knowledgeStartedAt: startedAt,
              },
              data: { knowledgeStatus: "completed", knowledgeCompletedAt: new Date() },
            });
            console.info("[view.reaction.knowledge]", JSON.stringify({
              viewKey: reaction.viewKey,
              reactionId: reaction.id,
              objectMemories,
              viewMemories,
            }));
          } catch (error) {
            await database.viewChangeReaction.updateMany({
              where: {
                id: reaction.id,
                knowledgeStatus: "running",
                knowledgeStartedAt: startedAt,
              },
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
        attentionClaimed && claimStartedAt
          ? database.viewChangeReaction.updateMany({
              where: {
                id: reactionId,
                attentionStatus: "running",
                attentionStartedAt: claimStartedAt,
              },
              data: {
                attentionStatus: "failed",
                attentionErrorMessage: message,
                attentionCompletedAt: completedAt,
              },
            })
          : Promise.resolve(),
        knowledgeClaimed && claimStartedAt
          ? database.viewChangeReaction.updateMany({
              where: {
                id: reactionId,
                knowledgeStatus: "running",
                knowledgeStartedAt: claimStartedAt,
              },
              data: {
                knowledgeStatus: "failed",
                knowledgeErrorMessage: message,
                knowledgeCompletedAt: completedAt,
              },
            })
          : Promise.resolve(),
      ]).catch(() => undefined);
    }
  }
}
