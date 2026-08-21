import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import type {
  ActorContext,
  CommandDefinition,
  ViewModule,
} from "@/contracts";
import { parseViewSettings } from "@/view-runtime/application/installed-views";
import type { InstalledViewService } from "@/view-runtime/application/installed-views";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import {
  ViewConflictError,
  ViewNotFoundError,
  ViewRuntimeError,
} from "@/view-runtime/domain/errors";
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

async function runtimeView(
  database: PrismaClient,
  registry: ExtensionRegistry,
  viewKey: string,
): Promise<{
  viewModule: ViewModule;
  installed: {
    stateVersion: bigint;
    status: "enabled" | "disabled" | "incompatible";
    moduleVersion: string;
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
      moduleVersion: true,
      schemaVersion: true,
      settingsJson: true,
    },
  });
  if (!installed || installed.status !== "enabled") throw new ViewNotFoundError(viewKey);
  if (
    installed.moduleVersion !== viewModule.manifest.version ||
    installed.schemaVersion !== viewModule.manifest.schemaVersion
  ) {
    throw new ViewRuntimeError(`View ${viewKey} 安装版本与已加载 Module 不一致`);
  }
  return { viewModule, installed };
}

export class ViewCommandBus {
  constructor(
    private readonly database: PrismaClient,
    private readonly registry: ExtensionRegistry,
    private readonly installedViews: InstalledViewService,
  ) {}

  async dispatch(input: DispatchViewCommandInput): Promise<ViewCommandDispatchResult> {
    await this.installedViews.synchronize();
    const { viewModule, installed } = await runtimeView(this.database, this.registry, input.viewKey);
    const command = commandFor(viewModule, input.commandKey, input.commandVersion);
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
  }): Promise<ViewCommandDispatchResult | { kind: "rejected"; proposalId: string }> {
    await this.installedViews.synchronize();
    const proposal = await this.database.viewCommandProposal.findUnique({
      where: { id: input.proposalId },
    });
    if (!proposal || proposal.status !== "pending") {
      throw new ViewRuntimeError("View Command Proposal 不存在或已处理");
    }
    const canApproveAny = input.actor.permissions.includes("view.approve");
    const ownsProposal = Boolean(
      input.actor.actorId && proposal.proposedByActorId === input.actor.actorId,
    );
    if (!canApproveAny && !ownsProposal) {
      throw new ViewRuntimeError("只能处理自己创建的 View Command Proposal");
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
      return await this.executeNow({
        viewKey: proposal.viewKey,
        commandKey: proposal.commandKey,
        commandVersion: proposal.commandVersion,
        input: proposal.inputJson,
        actor: input.actor,
        initiator: "ai",
        ...(proposal.skillId ? { skillId: proposal.skillId } : {}),
        expectedStateVersion: proposal.expectedStateVersion.toString(),
      }, proposal.id);
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
    input: DispatchViewCommandInput & { commandVersion: string; expectedStateVersion: string },
    proposalId?: string,
  ): Promise<ViewCommandDispatchResult> {
    const viewModule = this.registry.getView(input.viewKey);
    if (!viewModule) throw new ViewNotFoundError(input.viewKey);
    const command = commandFor(viewModule, input.commandKey, input.commandVersion);
    requirePermissions(input.actor, command.requiredPermissions ?? []);
    const parsedInput = command.inputSchema.parse(input.input);
    const expectedStateVersion = BigInt(input.expectedStateVersion);

    return this.database.$transaction(async (transaction) => {
      const installed = await transaction.installedView.findUnique({
        where: { viewKey: input.viewKey },
      });
      if (!installed || installed.status !== "enabled") throw new ViewNotFoundError(input.viewKey);
      if (installed.stateVersion !== expectedStateVersion) throw new ViewConflictError();
      if (proposalId) {
        const pending = await transaction.viewCommandProposal.findFirst({
          where: { id: proposalId, status: "pending" },
          select: { id: true },
        });
        if (!pending) throw new ViewConflictError("Proposal 已被处理");
      }

      const graph = new PrismaCardGraphTransaction(transaction, viewModule);
      const outcome = await command.execute({
        viewKey: input.viewKey,
        actor: input.actor,
        initiator: input.initiator,
        ...(input.skillId ? { skillId: input.skillId } : {}),
        expectedStateVersion: input.expectedStateVersion,
        transaction: graph,
      }, parsedInput);
      for (const invariant of viewModule.invariants) await invariant.validate(graph);

      const nextStateVersion = expectedStateVersion + BigInt(1);
      const advanced = await transaction.installedView.updateMany({
        where: { viewKey: input.viewKey, stateVersion: expectedStateVersion },
        data: { stateVersion: nextStateVersion },
      });
      if (advanced.count !== 1) throw new ViewConflictError();

      const execution = await transaction.viewCommandExecution.create({
        data: {
          viewKey: input.viewKey,
          commandKey: command.key,
          commandVersion: command.version,
          inputJson: json(parsedInput),
          actorId: input.actor.actorId,
          initiator: input.initiator,
          skillId: input.skillId,
          stateVersionBefore: expectedStateVersion,
          stateVersionAfter: nextStateVersion,
          resultSummaryJson: outcome.summary === undefined ? Prisma.JsonNull : json(outcome.summary),
        },
        select: { id: true },
      });

      for (const event of outcome.events ?? []) {
        const definition = viewModule.events.find(
          (candidate) => candidate.key === event.type && candidate.version === event.version,
        );
        if (!definition) {
          throw new ViewRuntimeError(
            `Command 产生了未声明的 Event ${event.type}@${event.version}`,
          );
        }
        const payload = definition.payloadSchema.parse(event.payload);
        await transaction.domainEventOutbox.create({
          data: {
            eventType: event.type,
            eventVersion: event.version,
            viewKey: input.viewKey,
            stateVersion: nextStateVersion,
            payloadJson: json(payload),
            metadataJson: json({
              actorId: input.actor.actorId,
              initiator: input.initiator,
              skillId: input.skillId,
            }),
          },
        });
      }
      if (proposalId) {
        await transaction.viewCommandProposal.update({
          where: { id: proposalId },
          data: { status: "applied", decidedAt: new Date(), appliedAt: new Date() },
        });
      }
      return {
        kind: "executed",
        executionId: execution.id,
        viewKey: input.viewKey,
        stateVersion: nextStateVersion.toString(),
        ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
      };
    });
  }
}
