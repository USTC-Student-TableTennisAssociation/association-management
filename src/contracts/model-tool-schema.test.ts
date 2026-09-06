import { describe, expect, it } from "vitest";

import {
  assertModelToolInputSchema,
  modelToolSchemaIssues,
} from "@/contracts/model-tool-schema";

describe("Sydaris Model Tool ABI", () => {
  it("accepts a single explicit object envelope", () => {
    expect(() => assertModelToolInputSchema({
      type: "object",
      properties: {
        viewKey: { type: "string" },
        input: { type: "object", additionalProperties: true },
      },
      required: ["viewKey"],
      additionalProperties: false,
    }, "portableTool")).not.toThrow();
  });

  it("rejects a top-level union before it reaches a model provider", () => {
    const issues = modelToolSchemaIssues({
      anyOf: [
        { type: "object", properties: { first: { type: "string" } } },
        { type: "object", properties: { second: { type: "string" } } },
      ],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.type" }),
      expect.objectContaining({ path: "$.anyOf" }),
      expect.objectContaining({ path: "$.properties" }),
    ]));
  });

  it("rejects an unconstrained field emitted from unknown validators", () => {
    expect(() => assertModelToolInputSchema({
      type: "object",
      properties: { input: {} },
    }, "unknownInputTool")).toThrow(/无约束空 Schema/);
  });
});
