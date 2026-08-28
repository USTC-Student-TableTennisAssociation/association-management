import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { createAgentToolProviderToolset } from "@/agent-runtime/tool-provider-toolset";
import { zodContractSchema } from "@/contracts";
import { ToolRuntime } from "@/runtime/tool-runtime/tool-runtime";

function runtime(
  sideEffect: "none" | "external_irreversible" = "none",
  allowedCallers: readonly ("agent" | "view" | "automation")[] = ["agent"],
) {
  const subject = new ToolRuntime();
  subject.registerContract({
    key: sideEffect === "none" ? "calendar.read" : "email.send",
    version: "1.0.0",
    description: "Test capability",
    semanticContract: "Return only provider data",
    inputSchema: zodContractSchema(z.object({ query: z.string() })),
    outputSchema: zodContractSchema(z.object({ result: z.string() })),
    sideEffect,
    allowedCallers,
    requiredPermissions: [sideEffect === "none" ? "tool.calendar.read" : "tool.email.send"],
  });
  const execute = vi.fn(async () => ({ result: "ok" }));
  subject.registerProvider({
    id: "test-provider",
    version: "1.0.0",
    implementations: [{
      capability: {
        key: sideEffect === "none" ? "calendar.read" : "email.send",
        version: "1.0.0",
      },
      execute,
    }],
  });
  return { subject, execute };
}

describe("global Tool Provider AI adapter", () => {
  it("exposes an installed read-only Provider to every chat", async () => {
    const { subject, execute: providerExecute } = runtime();
    const toolset = createAgentToolProviderToolset({
      runtime: subject,
      actor: { actorId: "actor-1", permissions: ["tool.calendar.read"] },
    });
    expect(toolset.toolNames).toEqual(["external_test_provider_calendar_read"]);
    const execute = toolset.tools.external_test_provider_calendar_read.execute as unknown as (
      input: { query: string },
    ) => Promise<unknown>;
    await expect(execute({ query: "today" })).resolves.toEqual({ result: "ok" });
    expect(providerExecute).toHaveBeenCalledWith(
      {
        caller: { kind: "agent", actorId: "actor-1" },
        permissions: ["tool.calendar.read"],
      },
      { query: "today" },
    );
  });

  it("keeps an internal read-only Provider out of AI chat", () => {
    const { subject } = runtime("none", ["view", "automation"]);
    const toolset = createAgentToolProviderToolset({
      runtime: subject,
      actor: { permissions: ["tool.calendar.read"] },
    });
    expect(toolset.toolNames).toEqual([]);
  });

  it("keeps side-effecting Providers out of AI chat until an approval UI exists", () => {
    const { subject } = runtime("external_irreversible");
    const toolset = createAgentToolProviderToolset({
      runtime: subject,
      actor: { permissions: ["tool.email.send"] },
    });
    expect(toolset.toolNames).toEqual([]);
  });
});
