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
import type { ViewChangeEvidenceEnvelope } from "@/view-runtime/application/view-change-evidence";

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
  evidence: ViewChangeEvidenceEnvelope;
}) => Promise<ViewChangeAttentionDecision>;

type ViewKnowledgeReconciliationInput = {
  viewModule: NonNullable<ReturnType<ExtensionRegistry["getView"]>>;
  snapshot: Awaited<ReturnType<ViewReadPort["query"]>>;
  executions: readonly ViewChangeExecution[];
  events: readonly ViewChangeEvent[];
  objects: readonly ViewRelatedObject[];
  signal?: AbortSignal;
};

export type ViewChangeEvidenceRetriever = (input: {
  viewModule: NonNullable<ReturnType<ExtensionRegistry["getView"]>>;
  executions: readonly ViewChangeExecution[];
  objects: readonly ViewRelatedObject[];
}) => Promise<ViewChangeEvidenceEnvelope>;

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
  private readonly knowledgeRuns = new Map<string, {
    reactionId: string;
    stateVersion: bigint;
    controller: AbortController;
  }>();

  constructor(private readonly dependencies: {
    database: PrismaClient;
    registry: ExtensionRegistry;
    readPort: ViewReadPort;
    evaluate: ViewAttentionEvaluator;
    retrieveEvidence: ViewChangeEvidenceRetriever;
    reconcileObjectHigherMemory: ObjectHigherMemoryReconciler;
    reconcileViewHigherMemory: ViewHigherMemoryReconciler;
  }) {}

  async enqueue(input: { reactionId: string }): Promise<boolean> {
    const reaction = await this.dependencies.database.viewChangeReaction.findUnique({
      where: { id: input.reactionId },
      select: {
        id: true,
        viewKey: true,
        stateVersion: true,
        settleUntil: true,
        attentionStatus: true,
        knowledgeStatus: true,
      },
    });
    if (!reaction) return false;
    if (reaction.attentionStatus !== "queued" && reaction.knowledgeStatus !== "queued") {
      return false;
    }
    if (reaction.knowledgeStatus === "queued") {
      await this.supersedeOlderKnowledge(reaction);
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

  async retryAttention(input: {
    reactionId: string;
    viewKey: string;
    actorId: string;
  }): Promise<boolean> {
    const settleUntil = new Date();
    const reset = await this.dependencies.database.viewChangeReaction.updateMany({
      where: {
        id: input.reactionId,
        viewKey: input.viewKey,
        actorId: input.actorId,
        attentionStatus: "failed",
      },
      data: {
        attentionStatus: "queued",
        evidenceStatus: "not_checked",
        message: null,
        reason: null,
        attentionErrorMessage: null,
        attentionStartedAt: null,
        attentionCompletedAt: null,
        settleUntil,
        seenAt: null,
      },
    });
    if (reset.count !== 1) return false;
    this.schedule(input.reactionId, settleUntil);
    return true;
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.knowledgeRuns.forEach(({ controller }) => controller.abort(
      new Error("View Change Coordinator 已停止"),
    ));
    this.knowledgeRuns.clear();
  }

  private schedule(reactionId: string, settleUntil: Date): void {
    const existing = this.timers.get(reactionId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, settleUntil.getTime() - Date.now());
    this.timers.set(reactionId, setTimeout(() => void this.flush(reactionId), delay));
  }

  private async supersedeOlderKnowledge(input: {
    id: string;
    viewKey: string;
    stateVersion: bigint;
  }): Promise<void> {
    const running = this.knowledgeRuns.get(input.viewKey);
    if (running && running.stateVersion < input.stateVersion) {
      running.controller.abort(new Error("已有更新的 View 状态，停止旧 Higher Memory 维护"));
    }
    await this.dependencies.database.viewChangeReaction.updateMany({
      where: {
        id: { not: input.id },
        viewKey: input.viewKey,
        stateVersion: { lt: input.stateVersion },
        knowledgePolicy: "reconcile",
        knowledgeStatus: { in: ["queued", "running"] },
      },
      data: {
        knowledgeStatus: "completed",
        knowledgeCompletedAt: new Date(),
        knowledgeErrorMessage: null,
      },
    });
  }

  private beginKnowledgeRun(input: {
    reactionId: string;
    viewKey: string;
    stateVersion: bigint;
  }) {
    const existing = this.knowledgeRuns.get(input.viewKey);
    if (existing && existing.stateVersion >= input.stateVersion) return undefined;
    existing?.controller.abort(new Error("已有更新的 View 状态，停止旧 Higher Memory 维护"));
    const run = { ...input, controller: new AbortController() };
    this.knowledgeRuns.set(input.viewKey, run);
    return run;
  }

  private finishKnowledgeRun(viewKey: string, reactionId: string): void {
    if (this.knowledgeRuns.get(viewKey)?.reactionId === reactionId) {
      this.knowledgeRuns.delete(viewKey);
    }
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
        jobs.push((async () => {
          const evidence = await this.dependencies.retrieveEvidence({
            viewModule,
            executions: [execution],
            objects: priorObjects,
          });
          await database.viewChangeReaction.updateMany({
            where: {
              id: reaction.id,
              attentionStatus: "running",
              attentionStartedAt: startedAt,
            },
            data: {
              evidenceJson: JSON.parse(JSON.stringify(evidence)) as Prisma.InputJsonValue,
            },
          });
          const decision = await this.dependencies.evaluate({
            viewModule,
            snapshot: reactionSnapshot,
            executions: [execution],
            events,
            objects: priorObjects,
            conversation: [],
            attentionPolicy: reaction.attentionPolicy as ViewReactionAttentionPolicy,
            reactionGuidance: guidance,
            evidence,
          });
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
              evidenceStatus: decision.evidenceStatus,
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
            evidenceStatus: decision.evidenceStatus,
          }));
        })().catch(async (error: unknown) => {
          await database.viewChangeReaction.updateMany({
            where: {
              id: reaction.id,
              attentionStatus: "running",
              attentionStartedAt: startedAt,
            },
            data: {
              attentionStatus: "failed",
              evidenceStatus: "failed",
              attentionErrorMessage: error instanceof Error ? error.message : String(error),
              attentionCompletedAt: new Date(),
            },
          });
          console.error("[view.reaction.attention]", error);
        }));
      }
      if (knowledgeClaimed) {
        const run = this.beginKnowledgeRun({
          reactionId: reaction.id,
          viewKey: reaction.viewKey,
          stateVersion: reaction.stateVersion,
        });
        if (!run) {
          jobs.push(database.viewChangeReaction.updateMany({
            where: { id: reaction.id, knowledgeStatus: "running" },
            data: { knowledgeStatus: "completed", knowledgeCompletedAt: new Date() },
          }).then(() => undefined));
        } else jobs.push((async () => {
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
            run.controller.signal.throwIfAborted();
            const [objectMemories, viewMemories] = await Promise.all([
              this.dependencies.reconcileObjectHigherMemory({
                viewModule,
                snapshot: reactionSnapshot,
                executions: [execution],
                events,
                objects: priorObjects,
                signal: run.controller.signal,
              }),
              this.dependencies.reconcileViewHigherMemory({
                viewModule,
                snapshot,
                executions: [execution],
                events,
                objects: priorObjects,
                signal: run.controller.signal,
              }),
            ]);
            run.controller.signal.throwIfAborted();
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
            const superseded = run.controller.signal.aborted;
            await database.viewChangeReaction.updateMany({
              where: {
                id: reaction.id,
                knowledgeStatus: "running",
                knowledgeStartedAt: startedAt,
              },
              data: {
                knowledgeStatus: superseded ? "completed" : "failed",
                knowledgeErrorMessage: superseded
                  ? null
                  : error instanceof Error ? error.message : String(error),
                knowledgeCompletedAt: new Date(),
              },
            });
            if (!superseded) console.error("[view.reaction.knowledge]", error);
          } finally {
            this.finishKnowledgeRun(reaction.viewKey, reaction.id);
          }
        })());
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
                evidenceStatus: "failed",
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
