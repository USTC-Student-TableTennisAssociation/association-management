import { z } from "zod";
import { describe, expect, it } from "vitest";

import { zodContractSchema } from "@/contracts";
import { ToolRuntime, ToolRuntimeError } from "@/runtime/tool-runtime/tool-runtime";

describe("ToolRuntime Skill requirements", () => {
  it("requires both a compatible Capability Contract and a Provider", () => {
    const runtime = new ToolRuntime();
    runtime.registerContract({
      key: "calendar.read",
      version: "1.2.0",
      description: "Read calendar",
      semanticContract: "Read matching events",
      inputSchema: zodContractSchema(z.object({})),
      outputSchema: zodContractSchema(z.object({ events: z.array(z.string()) })),
      sideEffect: "none",
      allowedCallers: ["agent"],
      requiredPermissions: ["tool.calendar.read"],
    });

    expect(() => runtime.assertRequirementsAvailable([{
      key: "calendar.read",
      versions: "^1.0.0",
    }])).toThrow(ToolRuntimeError);

    runtime.registerProvider({
      id: "calendar-provider",
      version: "1.0.0",
      implementations: [{
        capability: { key: "calendar.read", version: "1.2.0" },
        execute: async () => ({ events: [] }),
      }],
    });
    expect(() => runtime.assertRequirementsAvailable([{
      key: "calendar.read",
      versions: "^1.0.0",
    }])).not.toThrow();
    expect(() => runtime.assertRequirementsAvailable([{
      key: "calendar.read",
      versions: "^2.0.0",
    }])).toThrow(/Capability 不可用/);
  });
});
