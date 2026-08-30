import { getDatabase } from "@/db";
import { installedPluginManifests } from "@/generated/installed-plugins";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";
import { builtinToolCapabilityContracts } from "@/contracts/tool/capability-contracts/builtin";
import { InstalledViewService } from "@/view-runtime/application/installed-views";
import { ViewCommandBus } from "@/view-runtime/application/command-bus";
import { PrismaViewReadPort } from "@/view-runtime/application/view-read-port";
import { ViewChangeCoordinator } from "@/view-runtime/application/view-change-coordinator";
import { observeViewChanges } from "@/ai/view-change-observer";
import { reconcileObjectHigherMemoryFromViewChange } from "@/memory/object-higher-memory-reconciliation";
import { reconcileViewHigherMemoryFromViewChange } from "@/memory/view-higher-memory-reconciliation";

export function createInstalledExtensionRegistry(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  installedPluginManifests.forEach((plugin) => registry.registerPlugin(plugin));
  return registry;
}

export const extensionRegistry = createInstalledExtensionRegistry();
const database = getDatabase();
export const installedViewService = new InstalledViewService(database, extensionRegistry);
export const viewReadPort = new PrismaViewReadPort(
  extensionRegistry,
  installedViewService,
  database,
);
export const viewChangeCoordinator = new ViewChangeCoordinator({
  database,
  registry: extensionRegistry,
  readPort: viewReadPort,
  evaluate: observeViewChanges,
  reconcileObjectHigherMemory: reconcileObjectHigherMemoryFromViewChange,
  reconcileViewHigherMemory: reconcileViewHigherMemoryFromViewChange,
});
export const viewCommandBus = new ViewCommandBus(
  database,
  extensionRegistry,
  installedViewService,
  viewChangeCoordinator,
);

export function createToolRuntime(): ToolRuntime {
  const runtime = new ToolRuntime();
  builtinToolCapabilityContracts.forEach((contract) => runtime.registerContract(contract));
  extensionRegistry.listToolCapabilityContracts().forEach((contract) =>
    runtime.registerContract(contract)
  );
  extensionRegistry.listToolProviders().forEach((provider) => runtime.registerProvider(provider));
  return runtime;
}

export const toolRuntime = createToolRuntime();
