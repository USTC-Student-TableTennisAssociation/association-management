import { activityOperationsPlugin } from "@/plugins/activity-operations/manifest";
import { societyInformationPlugin } from "@/plugins/society-information/manifest";
import { getDatabase } from "@/db";
import { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";
import { builtinToolCapabilityContracts } from "@/contracts/tool/capability-contracts/builtin";
import { InstalledViewService } from "@/view-runtime/application/installed-views";
import { ViewCommandBus } from "@/view-runtime/application/command-bus";
import { PrismaViewReadPort } from "@/view-runtime/application/view-read-port";
import { ViewAIAttentionCoordinator } from "@/view-runtime/application/view-ai-attention";
import { observeViewChanges } from "@/ai/view-change-observer";
import {
  appendAssistantTextMessage,
  loadChatMessages,
} from "@/chat/persistence";

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
export const viewAIAttentionCoordinator = new ViewAIAttentionCoordinator({
  database,
  registry: extensionRegistry,
  readPort: viewReadPort,
  evaluate: observeViewChanges,
  appendMessage: (input) => appendAssistantTextMessage(input, database),
  loadConversation: (input) => loadChatMessages(
    input.actor,
    input.conversationId,
    database,
  ),
});

export function createBuiltinToolRuntime(): ToolRuntime {
  const runtime = new ToolRuntime();
  builtinToolCapabilityContracts.forEach((contract) => runtime.registerContract(contract));
  extensionRegistry.listToolProviders().forEach((provider) => runtime.registerProvider(provider));
  return runtime;
}

export const toolRuntime = createBuiltinToolRuntime();
