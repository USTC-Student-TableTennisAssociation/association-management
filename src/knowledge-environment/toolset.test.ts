import type { PrismaClient } from "@/generated/prisma/client";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { describe, expect, it, vi } from "vitest";

import type { KnowledgeEnvironmentInventory } from "@/knowledge-environment/inventory";
import { createKnowledgeEnvironmentTool } from "@/knowledge-environment/toolset";

const executionOptions = {
  toolCallId: "inventory-call",
  messages: [],
  abortSignal: undefined,
  context: {},
};

describe("createKnowledgeEnvironmentTool", () => {
  it("executes the structured inventory and reports it through the callback", async () => {
    const database = {
      memoryGlobalObject: { count: vi.fn().mockResolvedValue(0) },
      memoryAssertion: { groupBy: vi.fn().mockResolvedValue([]) },
      memoryObjectHigherMemory: { count: vi.fn().mockResolvedValue(0) },
      memoryAmbientHigherMemory: { count: vi.fn().mockResolvedValue(0) },
      memoryAssertionEmbeddingIndex: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const registry = { listViews: vi.fn().mockReturnValue([]) } as unknown as Pick<
      ExtensionRegistry,
      "listViews"
    >;
    const onInspect = vi.fn();
    const inventoryTool = createKnowledgeEnvironmentTool({
      dependencies: { database, registry },
      onInspect,
    });

    const result = await inventoryTool.execute!(
      { layers: ["shared_brain"] },
      executionOptions,
    ) as KnowledgeEnvironmentInventory;

    expect(result).toMatchObject({
      scope: "current_authenticated_workspace",
      requestedLayers: ["shared_brain"],
      sharedBrain: {
        objects: 0,
        assertions: { total: 0 },
        vectorIndex: { status: "missing" },
      },
    });
    expect(onInspect).toHaveBeenCalledOnce();
    expect(onInspect).toHaveBeenCalledWith(result);
    expect(result.sharedBrain?.objectExamples).toBeUndefined();
  });
});
