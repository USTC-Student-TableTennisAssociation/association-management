import { jsonSchema, tool, type ToolSet } from "ai";

import type { ActorContext } from "@/contracts";
import { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";

function toolName(providerId: string, capabilityKey: string): string {
  const normalized = `${providerId}_${capabilityKey}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `external_${normalized}`;
}

/**
 * Exposes installed, read-only Tool Providers to every AI chat. Side-effecting
 * capabilities stay registered in ToolRuntime, but need a future approval UI
 * before they can be handed to the model.
 */
export function createAgentToolProviderToolset(input: {
  runtime: ToolRuntime;
  actor: ActorContext;
}) {
  const tools: ToolSet = {};
  for (const provider of input.runtime.listProviders()) {
    for (const implementation of provider.implementations) {
      const contract = input.runtime.getContract(
        implementation.capability.key,
        implementation.capability.version,
      );
      if (
        !contract ||
        contract.sideEffect !== "none" ||
        !contract.allowedCallers.includes("agent")
      ) continue;
      const name = toolName(provider.id, contract.key);
      if (tools[name]) {
        throw new Error(`全局 Tool 名称冲突：${name}`);
      }
      tools[name] = tool({
        description: [
          contract.description,
          contract.semanticContract,
          `Provider: ${provider.id}@${provider.version}`,
          "这是已安装 Plugin 提供的全局只读 Tool，可在任意聊天和 View 上下文中使用。",
        ].join("\n"),
        inputSchema: jsonSchema(contract.inputSchema.jsonSchema),
        execute: (value) => input.runtime.execute({
          capabilityKey: contract.key,
          capabilityVersion: contract.version,
          providerId: provider.id,
          context: {
            caller: {
              kind: "agent",
              ...(input.actor.actorId ? { actorId: input.actor.actorId } : {}),
            },
            permissions: input.actor.permissions,
          },
          value,
        }),
      });
    }
  }
  return {
    tools,
    toolNames: Object.keys(tools),
  };
}
