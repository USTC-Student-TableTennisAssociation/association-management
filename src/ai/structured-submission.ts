import { tool } from "ai";
import { z } from "zod";

type SubmissionToolCall = {
  toolName: string;
  input: unknown;
};

export class StructuredSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredSubmissionError";
  }
}

export function structuredSubmissionTool<Schema extends z.ZodType>(input: {
  description: string;
  schema: Schema;
}) {
  return tool({
    description: input.description,
    inputSchema: input.schema,
  });
}

export function readStructuredSubmission<Schema extends z.ZodType>(input: {
  toolCalls: SubmissionToolCall[];
  toolName: string;
  schema: Schema;
}): z.output<Schema> | undefined {
  const submissions = input.toolCalls.filter(
    (call) => call.toolName === input.toolName,
  );
  if (!submissions.length) return undefined;
  if (submissions.length > 1) {
    throw new StructuredSubmissionError(
      `模型重复调用了结构化提交工具 ${input.toolName}`,
    );
  }
  return input.schema.parse(submissions[0].input);
}

export function requireStructuredSubmission<Schema extends z.ZodType>(input: {
  toolCalls: SubmissionToolCall[];
  toolName: string;
  schema: Schema;
}): z.output<Schema> {
  const submission = readStructuredSubmission(input);
  if (submission === undefined) {
    throw new StructuredSubmissionError(
      `模型没有调用结构化提交工具 ${input.toolName}`,
    );
  }
  return submission;
}
