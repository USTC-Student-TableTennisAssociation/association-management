import { Prisma } from "@/generated/prisma/client";

import type { PrismaClient } from "@/generated/prisma/client";
import type { ViewSettings } from "@/contracts";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ViewRuntimeError } from "@/view-runtime/domain/errors";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function parseViewSettings(value: unknown): ViewSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ViewRuntimeError("View settings 格式无效");
  }
  const policy = (value as Record<string, unknown>).aiWritePolicy;
  if (policy !== "approval_required" && policy !== "auto_execute") {
    throw new ViewRuntimeError("View aiWritePolicy 无效");
  }
  return { aiWritePolicy: policy };
}

export class InstalledViewService {
  constructor(
    private readonly database: PrismaClient,
    private readonly registry: ExtensionRegistry,
  ) {}

  async synchronize(): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      for (const view of this.registry.listViews()) {
        const owner = this.registry.getViewOwner(view.manifest.key);
        if (!owner) throw new ViewRuntimeError(`View 没有 Plugin owner：${view.manifest.key}`);
        const existing = await transaction.installedView.findUnique({
          where: { viewKey: view.manifest.key },
          select: { schemaVersion: true },
        });
        if (!existing) {
          await transaction.installedView.create({
            data: {
              viewKey: view.manifest.key,
              moduleId: owner.pluginId,
              pluginVersion: owner.pluginVersion,
              schemaVersion: view.manifest.schemaVersion,
              status: "enabled",
              settingsJson: json(view.manifest.defaultSettings),
            },
          });
          continue;
        }
        await transaction.installedView.update({
          where: { viewKey: view.manifest.key },
          data: {
            moduleId: owner.pluginId,
            pluginVersion: owner.pluginVersion,
            status: existing.schemaVersion === view.manifest.schemaVersion
              ? "enabled"
              : "incompatible",
          },
        });
      }
    });
  }

  async updateSettings(input: {
    viewKey: string;
    settings: ViewSettings;
  }): Promise<void> {
    parseViewSettings(input.settings);
    if (!this.registry.getView(input.viewKey)) {
      throw new ViewRuntimeError(`View Module 未注册：${input.viewKey}`);
    }
    await this.synchronize();
    await this.database.installedView.update({
      where: { viewKey: input.viewKey },
      data: { settingsJson: json(input.settings) },
    });
  }
}
