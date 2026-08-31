import "dotenv/config";

import { generateText, stepCountIs } from "ai";
import { afterAll, describe, expect, it } from "vitest";

import { buildCapabilityInstructions } from "@/ai/capability-instructions";
import { TURN_KERNEL_INSTRUCTIONS } from "@/ai/capability-gates";
import { getChatModel } from "@/ai/provider";
import { getDatabase } from "@/db";
import {
  inspectKnowledgeEnvironment,
  type KnowledgeEnvironmentInventory,
} from "@/knowledge-environment/inventory";
import { createKnowledgeEnvironmentTool } from "@/knowledge-environment/toolset";
import { extensionRegistry } from "@/shell/composition-root";

const runLive = process.env.RUN_LIVE_KNOWLEDGE_ENVIRONMENT === "1";
const runModelLive = process.env.RUN_LIVE_KNOWLEDGE_ENVIRONMENT_MODEL === "1";

describe.runIf(runLive)("knowledge environment live chain", () => {
  const database = getDatabase();

  afterAll(async () => {
    await database.$disconnect();
  });

  it("reads all three inventory providers from the configured PostgreSQL database", async () => {
    const inventory = await inspectKnowledgeEnvironment(
      { includeExamples: false },
      { database, registry: extensionRegistry },
    );

    expect(inventory.sharedBrain?.measurement).toBe("exact");
    expect(inventory.library?.measurement).toBe("exact");
    expect(inventory.businessViews?.measurement).toBe("exact");
    expect(inventory.businessViews?.registered).toBeGreaterThan(0);
    console.info("[knowledge-environment.database.live]", JSON.stringify(inventory));
  }, 120_000);

  it.runIf(runModelLive)("lets the real chat model autonomously call the inventory tool", async () => {
    let observedInventory: KnowledgeEnvironmentInventory | undefined;
    const inspectTool = createKnowledgeEnvironmentTool({
      dependencies: { database, registry: extensionRegistry },
      onInspect: (inventory) => {
        observedInventory = inventory;
      },
    });
    const result = await generateText({
      model: getChatModel(),
      system: [
        TURN_KERNEL_INSTRUCTIONS,
        buildCapabilityInstructions({
          preferredKnowledgeLayer: "unknown",
          toolNames: ["inspectKnowledgeEnvironment"],
        }),
      ].join("\n\n"),
      prompt: "请根据你实际可访问的内容，说明当前工作环境的知识规模与分层状态。",
      tools: { inspectKnowledgeEnvironment: inspectTool },
      toolChoice: "auto",
      stopWhen: stepCountIs(3),
      temperature: 0.1,
      maxOutputTokens: 4_000,
      timeout: { totalMs: 1_800_000, stepMs: 1_800_000, toolMs: 120_000 },
    });
    const toolNames = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => call.toolName)
    );

    expect(toolNames).toContain("inspectKnowledgeEnvironment");
    expect(observedInventory).toBeDefined();
    expect(observedInventory?.sharedBrain?.objectExamples).toBeUndefined();
    expect(observedInventory?.library?.fileExamples).toBeUndefined();
    expect(result.text.trim().length).toBeGreaterThan(0);
    console.info("[knowledge-environment.model.live]", JSON.stringify({
      toolNames,
      inventory: observedInventory,
      answer: result.text,
    }));
  }, 1_800_000);
});
