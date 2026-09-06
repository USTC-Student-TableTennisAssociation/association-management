import {
  generateText,
  NoObjectGeneratedError,
  Output,
  tool,
  type LanguageModel,
  type OnLanguageModelCallEndCallback,
  type OnLanguageModelCallStartCallback,
  type TimeoutConfiguration,
} from "ai";
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

function parseStructuredText<Schema extends z.ZodType>(
  text: string,
  schema: Schema,
): z.output<Schema> | undefined {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim(),
    (() => {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
    })(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(candidate) as unknown);
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next conservative extraction. Never repair or invent fields.
    }
  }
  return undefined;
}

function structuredResultPrompt<Schema extends z.ZodType>(input: {
  prompt: string;
  schema: Schema;
  name: string;
}): string {
  return [
    input.prompt,
    "[响应格式]",
    `只输出一个 JSON 根对象，不要输出 Markdown、代码围栏或解释。本次协议标识是 ${input.name}，它不是外层字段。`,
    `JSON 必须通过以下 JSON Schema：${JSON.stringify(z.toJSONSchema(input.schema))}`,
  ].join("\n\n");
}

/**
 * One-shot schema generation is data production, not an executable tool call.
 * Keeping it tool-free avoids `thinking + forced tool_choice` incompatibilities
 * on OpenAI-compatible reasoning gateways. A clean text-JSON retry handles
 * providers whose native structured-output mode is temporarily unavailable.
 */
export async function generateStructuredResult<Schema extends z.ZodType>(input: {
  model: LanguageModel;
  schema: Schema;
  name: string;
  description: string;
  prompt: string;
  temperature?: number;
  abortSignal?: AbortSignal;
  timeout?: TimeoutConfiguration<Record<string, never>>;
  onLanguageModelCallStart?: OnLanguageModelCallStartCallback;
  onLanguageModelCallEnd?: OnLanguageModelCallEndCallback;
}): Promise<z.output<Schema>> {
  const requestPrompt = structuredResultPrompt({
    prompt: input.prompt,
    schema: input.schema,
    name: input.name,
  });
  let firstError: unknown;
  try {
    const result = await generateText({
      model: input.model,
      prompt: requestPrompt,
      output: Output.object({
        schema: input.schema,
        name: input.name,
        description: input.description,
      }),
      temperature: input.temperature,
      maxRetries: 0,
      abortSignal: input.abortSignal,
      timeout: input.timeout,
      onLanguageModelCallStart: input.onLanguageModelCallStart,
      onLanguageModelCallEnd: input.onLanguageModelCallEnd,
    });
    return input.schema.parse(result.output);
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const recovered = parseStructuredText(error.text ?? "", input.schema);
      if (recovered !== undefined) return recovered;
    }
    firstError = error;
  }

  const reason = firstError instanceof Error ? firstError.message : String(firstError);
  const fallbackPrompt = structuredResultPrompt({
    prompt: [
      input.prompt,
      `上一次输出未通过结构校验：${reason.slice(0, 1_000)}`,
      "请根据原始输入重新生成一份完整结果，不要续写、修补或解释上一次输出。",
    ].join("\n\n"),
    schema: input.schema,
    name: input.name,
  });
  const fallback = await generateText({
    model: input.model,
    prompt: fallbackPrompt,
    temperature: input.temperature,
    maxRetries: 0,
    abortSignal: input.abortSignal,
    timeout: input.timeout,
    onLanguageModelCallStart: input.onLanguageModelCallStart,
    onLanguageModelCallEnd: input.onLanguageModelCallEnd,
  });
  const fallbackText = fallback.text ?? "";
  for (const candidate of [fallbackText, fallback.reasoningText]) {
    if (!candidate) continue;
    const output = parseStructuredText(candidate, input.schema);
    if (output !== undefined) return output;
  }
  throw new StructuredSubmissionError(
    `结构化结果 ${input.name} 在 clean retry 后仍未通过 Schema；` +
      `firstError=${reason.slice(0, 1_000)}；rawResponse=${fallbackText.slice(0, 2_000)}；` +
      `reasoningChars=${fallback.reasoningText?.length ?? 0}`,
  );
}
