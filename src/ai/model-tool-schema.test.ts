import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";

import {
  assertModelToolSet,
  createModelToolSchema,
} from "@/ai/model-tool-schema";

describe("model tool schema boundary", () => {
  it("keeps the wire contract portable while using a stricter runtime parser", async () => {
    const schema = createModelToolSchema({
      name: "envelopedTool",
      jsonSchema: {
        type: "object",
        properties: {
          mode: { type: "string" },
          input: { type: "object", additionalProperties: true },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      parse(value) {
        const request = value as { mode?: unknown; input?: unknown };
        if (request.mode !== "single" || !request.input) throw new Error("invalid domain input");
        return { mode: "single" as const, input: request.input };
      },
    });

    expect(await schema.validate?.({ mode: "single", input: { value: 1 } }))
      .toMatchObject({ success: true });
    expect(await schema.validate?.({ mode: "batch" }))
      .toMatchObject({ success: false });
  });

  it("rejects the exact assembled ToolSet before network I/O", async () => {
    const tools = {
      invalid: tool({
        description: "Invalid provider-facing union",
        inputSchema: jsonSchema({
          anyOf: [
            { type: "object", properties: { first: { type: "string" } } },
            { type: "object", properties: { second: { type: "string" } } },
          ],
        }),
      }),
    };

    await expect(assertModelToolSet(tools)).rejects.toThrow(/顶层分支/);
  });
});
