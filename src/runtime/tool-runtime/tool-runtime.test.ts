import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { zodContractSchema } from "@/contracts";
import { ToolRuntime, ToolRuntimeError } from "@/runtime/tool-runtime/tool-runtime";

function runtime() {
  const runtime = new ToolRuntime();
  runtime.registerContract({
    key: "email.send",
    version: "1.0.0",
    description: "Send email",
    semanticContract: "Send exactly one declared message",
    inputSchema: zodContractSchema(z.object({ to: z.string().email(), body: z.string() })),
    outputSchema: zodContractSchema(z.object({ messageId: z.string() })),
    sideEffect: "external_irreversible",
    allowedCallers: ["agent"],
    requiredPermissions: ["tool.email.send"],
  });
  return runtime;
}

describe("ToolRuntime", () => {
  it("validates Provider input and output with Echo's Capability Contract", async () => {
    const execute = vi.fn(async () => ({ messageId: "message-1" }));
    const subject = runtime();
    subject.registerProvider({
      id: "gmail",
      version: "1.0.0",
      implementations: [{ capability: { key: "email.send", version: "1.0.0" }, execute }],
    });

    await expect(subject.execute({
      capabilityKey: "email.send",
      capabilityVersion: "1.0.0",
      providerId: "gmail",
      context: { caller: { kind: "agent" }, permissions: ["tool.email.send"] },
      value: { to: "person@example.com", body: "Hello" },
    })).resolves.toEqual({ messageId: "message-1" });
    expect(execute).toHaveBeenCalledWith(
      { caller: { kind: "agent" }, permissions: ["tool.email.send"] },
      { to: "person@example.com", body: "Hello" },
    );

    await expect(subject.execute({
      capabilityKey: "email.send",
      capabilityVersion: "1.0.0",
      providerId: "gmail",
      context: { caller: { kind: "agent" }, permissions: ["tool.email.send"] },
      value: { to: "not-an-email", body: "Hello" },
    })).rejects.toThrow();
  });

  it("rejects unknown contracts, Provider contract overrides, and missing permissions", async () => {
    const subject = runtime();
    expect(() => subject.registerProvider({
      id: "unknown-provider",
      version: "1.0.0",
      implementations: [{
        capability: { key: "provider.defined.schema", version: "1.0.0" },
        execute: async () => ({}),
      }],
    })).toThrow(ToolRuntimeError);

    expect(() => subject.registerProvider({
      id: "schema-overrider",
      version: "1.0.0",
      implementations: [{
        capability: { key: "email.send", version: "1.0.0" },
        inputSchema: z.object({}),
        execute: async () => ({ messageId: "x" }),
      } as never],
    })).toThrow(/cannot redeclare|\u4e0d能重新声明/i);

    subject.registerProvider({
      id: "gmail",
      version: "1.0.0",
      implementations: [{
        capability: { key: "email.send", version: "1.0.0" },
        execute: async () => ({ messageId: "x" }),
      }],
    });
    await expect(subject.execute({
      capabilityKey: "email.send",
      capabilityVersion: "1.0.0",
      providerId: "gmail",
      context: { caller: { kind: "agent" }, permissions: [] },
      value: { to: "person@example.com", body: "Hello" },
    })).rejects.toThrow(/permission|\u6743限/i);
  });

  it("enforces the declared caller boundary", async () => {
    const subject = runtime();
    subject.registerProvider({
      id: "gmail",
      version: "1.0.0",
      implementations: [{
        capability: { key: "email.send", version: "1.0.0" },
        execute: async () => ({ messageId: "x" }),
      }],
    });
    await expect(subject.execute({
      capabilityKey: "email.send",
      capabilityVersion: "1.0.0",
      providerId: "gmail",
      context: {
        caller: { kind: "view", viewKey: "competition_records" },
        permissions: ["tool.email.send"],
      },
      value: { to: "person@example.com", body: "Hello" },
    })).rejects.toThrow(/不允许 view 调用/);
  });
});
