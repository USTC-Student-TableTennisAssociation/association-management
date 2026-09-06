import type { PrismaClient } from "@/generated/prisma/client";

import type {
  ActorContext,
  ViewOperationDefinition,
} from "@/contracts";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import type { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";
import type { InstalledViewService } from "@/view-runtime/application/installed-views";
import type { ViewCommandBus } from "@/view-runtime/application/command-bus";
import {
  ViewNotFoundError,
  ViewRuntimeError,
} from "@/view-runtime/domain/errors";
import { isVersionCompatible } from "@sydaris/plugin-sdk";

export type RunViewOperationInput = {
  viewKey: string;
  operationKey: string;
  operationVersion?: string;
  input: unknown;
  actor: ActorContext;
};

function requirePermissions(actor: ActorContext, required: readonly string[]): void {
  const missing = required.filter((permission) => !actor.permissions.includes(permission));
  if (missing.length) {
    throw new ViewRuntimeError(`缺少 View Operation 权限：${missing.join(", ")}`);
  }
}

function operationFor(
  operations: readonly ViewOperationDefinition[],
  key: string,
  version?: string,
): ViewOperationDefinition {
  const operation = operations.find((candidate) =>
    candidate.key === key && (version === undefined || candidate.version === version)
  );
  if (!operation) {
    throw new ViewRuntimeError(
      `View 没有声明 Operation ${key}${version ? `@${version}` : ""}`,
    );
  }
  return operation;
}

/** Executes a Plugin-owned server workflow through Runtime-controlled capabilities. */
export class ViewOperationRunner {
  constructor(
    private readonly database: PrismaClient,
    private readonly registry: ExtensionRegistry,
    private readonly installedViews: InstalledViewService,
    private readonly toolRuntime: ToolRuntime,
    private readonly commandBus: ViewCommandBus,
  ) {}

  async execute<Output = unknown>(input: RunViewOperationInput): Promise<Output> {
    await this.installedViews.synchronize();
    const view = this.registry.getView(input.viewKey);
    if (!view) throw new ViewNotFoundError(input.viewKey);
    const installed = await this.database.installedView.findUnique({
      where: { viewKey: input.viewKey },
      select: { status: true, schemaVersion: true },
    });
    if (!installed || installed.status !== "enabled") throw new ViewNotFoundError(input.viewKey);
    if (installed.schemaVersion !== view.manifest.schemaVersion) {
      throw new ViewRuntimeError(`View ${input.viewKey} Schema 与已加载 View 不一致`);
    }

    const operation = operationFor(
      view.operations ?? [],
      input.operationKey,
      input.operationVersion,
    );
    requirePermissions(input.actor, operation.requiredPermissions);
    this.toolRuntime.assertRequirementsAvailable(operation.requiresCapabilities);
    const parsedInput = operation.inputSchema.parse(input.input);

    const output = await operation.execute({
      viewKey: input.viewKey,
      actor: input.actor,
      executeTool: async (request) => {
        const declared = operation.requiresCapabilities.some((requirement) =>
          requirement.key === request.capabilityKey &&
          isVersionCompatible(request.capabilityVersion, requirement.versions)
        );
        if (!declared) {
          throw new ViewRuntimeError(
            `View Operation ${operation.key} 未声明 Capability ` +
              `${request.capabilityKey}@${request.capabilityVersion}`,
          );
        }
        const contract = this.toolRuntime.getContract(
          request.capabilityKey,
          request.capabilityVersion,
        );
        if (!contract) {
          throw new ViewRuntimeError(
            `View Operation ${operation.key} 的 Capability 不可用：` +
              `${request.capabilityKey}@${request.capabilityVersion}`,
          );
        }
        return this.toolRuntime.execute({
          capabilityKey: request.capabilityKey,
          capabilityVersion: request.capabilityVersion,
          providerId: request.providerId,
          context: {
            caller: { kind: "view", viewKey: input.viewKey },
            permissions: contract.requiredPermissions,
          },
          value: request.input,
        });
      },
      dispatchCommand: async (request) => {
        if (!operation.commands.includes(request.commandKey)) {
          throw new ViewRuntimeError(
            `View Operation ${operation.key} 未声明 Command ${request.commandKey}`,
          );
        }
        return this.commandBus.dispatch({
          viewKey: input.viewKey,
          commandKey: request.commandKey,
          commandVersion: request.commandVersion,
          expectedStateVersion: request.expectedStateVersion,
          input: request.input,
          actor: input.actor,
          initiator: "system",
        });
      },
    }, parsedInput);
    return operation.outputSchema.parse(output) as Output;
  }
}
