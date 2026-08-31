import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import type {
  ActorContext,
  CommandDefinition,
  ViewCardState,
  ViewChange,
  ViewModule,
} from "@/contracts";
import type { ViewReaction } from "@sydaris/plugin-sdk";
import { parseViewSettings } from "@/view-runtime/application/installed-views";
import type { InstalledViewService } from "@/view-runtime/application/installed-views";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import {
  ViewConflictError,
  ViewNotFoundError,
  ViewRuntimeError,
} from "@/view-runtime/domain/errors";
import { diffViewCards } from "@/view-runtime/application/view-change-set";
import {
  resolveViewPostCommitReaction,
  targetsForViewChanges,
} from "@/view-runtime/application/view-change-policy";
import {
  configuredViewReactionSettleMs,
  presentViewChangeReaction,
} from "@/view-runtime/application/view-change-reaction";
import { PrismaCardGraphTransaction } from "@/view-runtime/persistence/prisma-card-graph";

type Initiator = "human" | "ai" | "system";

export type DispatchViewCommandInput = {
  viewKey: string;
  commandKey: string;
  commandVersion?: string;
  input: unknown;
  actor: ActorContext;
  initiator: Initiator;
  skillId?: string;
  expectedStateVersion?: string;
};

export type ViewCommandDispatchResult =
  | {
      kind: "proposed";
      proposalId: string;
      viewKey: string;
      stateVersion: string;
    }
  | {
      kind: "executed";
      executionId: string;
      viewKey: string;
      stateVersion: string;
      summary?: unknown;
      reaction?: ViewReaction;
    };

export type ViewCommandProposalDecisionResult =
  | ViewCommandDispatchResult
  | { kind: "rejected"; proposalId: string }
  | { kind: "already_applied"; proposalId: string; viewKey: string };

export type ViewPostCommitScheduler = {
  enqueue(input: { reactionId: string }): Promise<boolean>;
};

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function commandFor(
  view: ViewModule,
  commandKey: string,
  commandVersion?: string,
): CommandDefinition {
  const command = view.commands.find((candidate) =>
    candidate.key === commandKey &&
    (commandVersion === undefined || candidate.version === commandVersion)
  );
  if (!command) {
    throw new ViewRuntimeError(
      `View ${view.manifest.key} 没有声明 Command ${commandKey}` +
        `${commandVersion ? `@${commandVersion}` : ""}`,
    );
  }
  return command;
}

function requirePermissions(actor: ActorContext, required: readonly string[]): void {
  const missing = required.filter((permission) => !actor.permissions.includes(permission));
  if (missing.length) throw new ViewRuntimeError(`缺少 View Command 权限：${missing.join(", ")}`);
}

function requireInitiator(
  command: CommandDefinition,
  initiator: Initiator,
): void {
  if (!command.allowedInitiators.includes(initiator)) {
    throw new ViewRuntimeError(
      `Command ${command.key} 不允许 ${initiator} 调用`,
    );
  }
}

function retryableStateConflict(error: unknown): error is ViewConflictError {
  return error instanceof ViewConflictError && error.message === "View stateVersion 已变化";
}

function relatedObjectIdsForChanges(
  changes: readonly ViewChange[],
  cardsBefore: readonly ViewCardState[],
  cardsAfter: readonly ViewCardState[],
): string[] {
  const cardIds = new Set<string>();
  const objectIds = new Set<string>();
  changes.forEach((change) => {
    if (change.kind === "card_created" || change.kind === "card_deleted") {
      cardIds.add(change.card.id);
      change.card.relatedObjectIds.forEach((id) => objectIds.add(id));
      return;
    }
    cardIds.add(change.cardId);
    if (change.kind === "slot") {
      change.before.forEach((id) => cardIds.add(id));
      change.after.forEach((id) => cardIds.add(id));
    }
    if (change.kind === "related_objects") {
      change.before.forEach((id) => objectIds.add(id));
      change.after.forEach((id) => objectIds.add(id));
    }
  });
  [...cardsBefore, ...cardsAfter].forEach((card) => {
    if (!cardIds.has(card.id)) return;
    card.relatedObjectIds.forEach((id) => objectIds.add(id));
  });
  return [...objectIds];
}

async function runtimeView(
  database: PrismaClient,
  registry: ExtensionRegistry,
  viewKey: string,
): Promise<{
  viewModule: ViewModule;
  installed: {
    stateVersion: bigint;
    status: "enabled" | "incompatible";
    pluginVersion: string;
    schemaVersion: string;
    settingsJson: Prisma.JsonValue;
  };
}> {
  const viewModule = registry.getView(viewKey);
  if (!viewModule) throw new ViewNotFoundError(viewKey);
  const installed = await database.installedView.findUnique({
    where: { viewKey },
    select: {
      stateVersion: true,
      status: true,
      pluginVersion: true,
      schemaVersion: true,
      settingsJson: true,
    },
  });
  if (!installed || installed.status !== "enabled") throw new ViewNotFoundError(viewKey);
  if (installed.schemaVersion !== viewModule.manifest.schemaVersion) {
    throw new ViewRuntimeError(`View ${viewKey} Schema 与已加载 View 不一致`);
  }
  return { viewModule, installed };
}

export class ViewCommandBus {
  constructor(
    private readonly database: PrismaClient,
    private readonly registry: ExtensionRegistry,
    private readonly installedViews: InstalledViewService,
    private readonly postCommit: ViewPostCommitScheduler,
  ) {}

  async dispatch(input: DispatchViewCommandInput): Promise<ViewCommandDispatchResult> {
    await this.installedViews.synchronize();
    const { viewModule, installed } = await runtimeView(this.database, this.registry, input.viewKey);
    const command = commandFor(viewModule, input.commandKey, input.commandVersion);
    requireInitiator(command, input.initiator);
    requirePermissions(input.actor, command.requiredPermissions ?? []);
    const parsedInput = command.inputSchema.parse(input.input);
    const expected = input.expectedStateVersion === undefined
      ? installed.stateVersion
      : BigInt(input.expectedStateVersion);
    if (expected !== installed.stateVersion) throw new ViewConflictError();

    const settings = parseViewSettings(installed.settingsJson);
    if (
      (input.initiator === "ai") &&
      settings.aiWritePolicy === "approval_required"
    ) {
      const proposal = await this.database.viewCommandProposal.create({
        data: {
          viewKey: input.viewKey,
          commandKey: command.key,
          commandVersion: command.version,
          inputJson: json(parsedInput),
          expectedStateVersion: expected,
          proposedByActorId: input.actor.actorId,
          skillId: input.skillId,
        },
        select: { id: true },
      });
      return {
        kind: "proposed",
        proposalId: proposal.id,
        viewKey: input.viewKey,
        stateVersion: expected.toString(),
      };
    }
    return this.executeNow({
      ...input,
      input: parsedInput,
      commandVersion: command.version,
      expectedStateVersion: expected.toString(),
    });
  }

  async decideProposal(input: {
    proposalId: string;
    decision: "approve" | "reject";
    actor: ActorContext;
  }): Promise<ViewCommandProposalDecisionResult> {
    await this.installedViews.synchronize();
    const proposal = await this.database.viewCommandProposal.findUnique({
      where: { id: input.proposalId },
    });
    if (!proposal) throw new ViewRuntimeError("View Command Proposal 不存在");
    const canApproveAny = input.actor.permissions.includes("view.approve");
    const ownsProposal = Boolean(
      input.actor.actorId && proposal.proposedByActorId === input.actor.actorId,
    );
    if (!canApproveAny && !ownsProposal) {
      throw new ViewRuntimeError("只能处理自己创建的 View Command Proposal");
    }
    if (proposal.status === "applied" && input.decision === "approve") {
      return { kind: "already_applied", proposalId: proposal.id, viewKey: proposal.viewKey };
    }
    if (proposal.status === "rejected" && input.decision === "reject") {
      return { kind: "rejected", proposalId: proposal.id };
    }
    if (proposal.status === "failed") {
      throw new ViewRuntimeError(
        proposal.failureReason
          ? `View Command Proposal 执行失败：${proposal.failureReason}`
          : "View Command Proposal 执行失败",
      );
    }
    if (proposal.status !== "pending") {
      throw new ViewRuntimeError("View Command Proposal 已按另一决定处理");
    }
    if (input.decision === "reject") {
      const updated = await this.database.viewCommandProposal.updateMany({
        where: { id: proposal.id, status: "pending" },
        data: { status: "rejected", decidedAt: new Date() },
      });
      if (updated.count !== 1) throw new ViewConflictError("Proposal 已被其他请求处理");
      return { kind: "rejected", proposalId: proposal.id };
    }

    try {
      const viewModule = this.registry.getView(proposal.viewKey);
      if (!viewModule) throw new ViewNotFoundError(proposal.viewKey);
      const command = commandFor(viewModule, proposal.commandKey, proposal.commandVersion);
      requireInitiator(command, "ai");
      const parsedInput = command.inputSchema.parse(proposal.inputJson);
      const conflictPolicy = command.proposalApprovalConflictPolicy?.(parsedInput) ?? "exact";
      const commandInput = {
        viewKey: proposal.viewKey,
        commandKey: proposal.commandKey,
        commandVersion: proposal.commandVersion,
        input: parsedInput,
        actor: input.actor,
        initiator: "ai" as const,
        ...(proposal.skillId ? { skillId: proposal.skillId } : {}),
        expectedStateVersion: proposal.expectedStateVersion.toString(),
      };
      const attempts = conflictPolicy === "revalidate_latest" ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await this.executeNow(commandInput, {
            proposalId: proposal.id,
            rebaseToLatest: conflictPolicy === "revalidate_latest",
          });
        } catch (error) {
          if (
            conflictPolicy === "revalidate_latest" &&
            attempt === 0 &&
            retryableStateConflict(error)
          ) continue;
          throw error;
        }
      }
      throw new ViewConflictError();
    } catch (error) {
      await this.database.viewCommandProposal.updateMany({
        where: { id: proposal.id, status: "pending" },
        data: {
          status: "failed",
          decidedAt: new Date(),
          failureReason: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  private async executeNow(
    input: DispatchViewCommandInput & { commandVersion: string },
    options: { proposalId?: string; rebaseToLatest?: boolean } = {},
  ): Promise<ViewCommandDispatchResult> {
    const viewModule = this.registry.getView(input.viewKey);
    if (!viewModule) throw new ViewNotFoundError(input.viewKey);
    const command = commandFor(viewModule, input.commandKey, input.commandVersion);
    requireInitiator(command, input.initiator);
    requirePermissions(input.actor, command.requiredPermissions ?? []);
    const parsedInput = command.inputSchema.parse(input.input);
    const requestedStateVersion = input.expectedStateVersion === undefined
      ? undefined
      : BigInt(input.expectedStateVersion);

    const result: ViewCommandDispatchResult = await this.database.$transaction(async (transaction) => {
      const installed = await transaction.installedView.findUnique({
        where: { viewKey: input.viewKey },
      });
      if (!installed || installed.status !== "enabled") throw new ViewNotFoundError(input.viewKey);
      const stateVersionBefore = options.rebaseToLatest
        ? installed.stateVersion
        : requestedStateVersion ?? installed.stateVersion;
      if (!options.rebaseToLatest && installed.stateVersion !== stateVersionBefore) {
        throw new ViewConflictError();
      }
      if (options.proposalId) {
        const pending = await transaction.viewCommandProposal.findFirst({
          where: { id: options.proposalId, status: "pending" },
          select: { id: true },
        });
        if (!pending) throw new ViewConflictError("Proposal 已被处理");
      }

      const graph = new PrismaCardGraphTransaction(transaction, viewModule);
      const cardsBefore = await graph.queryCards();
      const outcome = await command.execute({
        viewKey: input.viewKey,
        actor: input.actor,
        initiator: input.initiator,
        ...(input.skillId ? { skillId: input.skillId } : {}),
        expectedStateVersion: stateVersionBefore.toString(),
        transaction: graph,
      }, parsedInput);
      for (const invariant of viewModule.invariants) await invariant.validate(graph);
      const cardsAfter = await graph.queryCards();
      const changeSet = diffViewCards(cardsBefore, cardsAfter);

      const nextStateVersion = changeSet.length
        ? stateVersionBefore + BigInt(1)
        : stateVersionBefore;
      const advanced = await transaction.installedView.updateMany({
        where: { viewKey: input.viewKey, stateVersion: stateVersionBefore },
        data: { stateVersion: nextStateVersion },
      });
      if (advanced.count !== 1) throw new ViewConflictError();

      const eventDefinitions = [];
      const events = [];
      for (const event of outcome.events ?? []) {
        const definition = viewModule.events.find(
          (candidate) => candidate.key === event.type && candidate.version === event.version,
        );
        if (!definition) {
          throw new ViewRuntimeError(
            `Command 产生了未声明的 Event ${event.type}@${event.version}`,
          );
        }
        eventDefinitions.push(definition);
        events.push({
          type: event.type,
          version: event.version,
          payload: definition.payloadSchema.parse(event.payload),
        });
      }

      const execution = await transaction.viewCommandExecution.create({
        data: {
          viewKey: input.viewKey,
          commandKey: command.key,
          commandVersion: command.version,
          inputJson: json(parsedInput),
          actorId: input.actor.actorId,
          initiator: input.initiator,
          skillId: input.skillId,
          stateVersionBefore,
          stateVersionAfter: nextStateVersion,
          resultSummaryJson: outcome.summary === undefined ? Prisma.JsonNull : json(outcome.summary),
          changeSetJson: json(changeSet),
          eventsJson: json(events),
        },
        select: { id: true },
      });
      if (options.proposalId) {
        await transaction.viewCommandProposal.update({
          where: { id: options.proposalId },
          data: {
            status: "applied",
            executionId: execution.id,
            decidedAt: new Date(),
            appliedAt: new Date(),
          },
        });
      }
      let reaction: ViewReaction | undefined;
      if (changeSet.length) {
        const resolved = resolveViewPostCommitReaction({
          viewModule,
          changes: changeSet,
          eventDefinitions,
          initiator: input.initiator,
        });
        if (resolved.attention !== "never" || resolved.knowledge !== "none") {
          const objectIds = relatedObjectIdsForChanges(changeSet, cardsBefore, cardsAfter);
          const priorObjects = objectIds.length
            ? await transaction.memoryGlobalObject.findMany({
                where: { id: { in: objectIds } },
                orderBy: { canonicalName: "asc" },
                select: {
                  id: true,
                  canonicalName: true,
                  higherMemory: { select: { cognitiveMemory: true } },
                },
              })
            : [];
          const delay = resolved.timing === "immediate"
            ? 0
            : resolved.settleMs ?? configuredViewReactionSettleMs();
          const row = await transaction.viewChangeReaction.create({
            data: {
              executionId: execution.id,
              viewKey: input.viewKey,
              actorId: input.actor.actorId,
              stateVersion: nextStateVersion,
              targetsJson: json(targetsForViewChanges(changeSet)),
              priorObjectsJson: json(priorObjects.map((object) => ({
                id: object.id,
                canonicalName: object.canonicalName,
                ...(object.higherMemory
                  ? { cognitiveMemory: object.higherMemory.cognitiveMemory }
                  : {}),
              }))),
              attentionPolicy: resolved.attention,
              attentionStatus: resolved.attention === "never" ? "not_required" : "queued",
              knowledgePolicy: resolved.knowledge,
              knowledgeStatus: resolved.knowledge === "none" ? "not_required" : "queued",
              guidanceJson: json(resolved.guidance),
              settleUntil: new Date(Date.now() + delay),
            },
          });
          reaction = presentViewChangeReaction(row);
        }
      }
      return {
        kind: "executed",
        executionId: execution.id,
        viewKey: input.viewKey,
        stateVersion: nextStateVersion.toString(),
        ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
        ...(reaction ? { reaction } : {}),
      };
    });
    if (result.kind === "executed" && result.reaction) {
      try {
        await this.postCommit.enqueue({ reactionId: result.reaction.id });
      } catch (error) {
        console.error("[view.post-commit.enqueue]", error);
      }
    }
    return result;
  }
}
