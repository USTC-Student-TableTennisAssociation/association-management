import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  readStructuredSubmission,
  requireStructuredSubmission,
  StructuredSubmissionError,
} from "@/ai/structured-submission";

const schema = z.object({ value: z.string().min(1) });

describe("structured submission", () => {
  it("reads and validates the named tool input", () => {
    expect(requireStructuredSubmission({
      toolCalls: [
        { toolName: "unrelated", input: {} },
        { toolName: "submitResult", input: { value: "ok" } },
      ],
      toolName: "submitResult",
      schema,
    })).toEqual({ value: "ok" });
  });

  it("allows an optional submission to be absent", () => {
    expect(readStructuredSubmission({
      toolCalls: [],
      toolName: "submitResult",
      schema,
    })).toBeUndefined();
  });

  it("rejects missing, duplicate, and schema-invalid submissions", () => {
    expect(() => requireStructuredSubmission({
      toolCalls: [],
      toolName: "submitResult",
      schema,
    })).toThrow(StructuredSubmissionError);

    expect(() => requireStructuredSubmission({
      toolCalls: [
        { toolName: "submitResult", input: { value: "one" } },
        { toolName: "submitResult", input: { value: "two" } },
      ],
      toolName: "submitResult",
      schema,
    })).toThrow("重复调用");

    expect(() => requireStructuredSubmission({
      toolCalls: [{ toolName: "submitResult", input: { value: "" } }],
      toolName: "submitResult",
      schema,
    })).toThrow(z.ZodError);
  });
});
