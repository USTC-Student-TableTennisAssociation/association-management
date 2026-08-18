import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { societyInformationPlugin } from "@/plugins/society-information/manifest";
import { getDatabase } from "@/db";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";
import { builtinToolCapabilityContracts } from "@/contracts/tool/capability-contracts/builtin";
import { InstalledViewService } from "@/view-runtime/application/installed-views";
import { ViewCommandBus } from "@/view-runtime/application/command-bus";
import { PrismaViewReadPort } from "@/view-runtime/application/view-read-port";

export function createBuiltinExtensionRegistry(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.registerPlugin(societyInformationPlugin);
  registry.registerPlugin(activityOperationsPlugin);
  return registry;
}

export const extensionRegistry = createBuiltinExtensionRegistry();
const database = getDatabase();
export const installedViewService = new InstalledViewService(database, extensionRegistry);
export const viewCommandBus = new ViewCommandBus(
  database,
  extensionRegistry,
  installedViewService,
);
export const viewReadPort = new PrismaViewReadPort(
  extensionRegistry,
  installedViewService,
  database,
);

export function createBuiltinToolRuntime(): ToolRuntime {
  const runtime = new ToolRuntime();
  builtinToolCapabilityContracts.forEach((contract) => runtime.registerContract(contract));
  extensionRegistry.listToolProviders().forEach((provider) => runtime.registerProvider(provider));
  return runtime;
}

export const toolRuntime = createBuiltinToolRuntime();
