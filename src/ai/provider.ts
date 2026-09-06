import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z, type ZodType } from "zod";

export type StructuredOutputMode = "json_schema" | "json_object" | "text_json";
export type StructuredOutputThinkingMode = "inherit" | "enabled" | "disabled";

const STRUCTURED_OUTPUT_MODES = new Set<StructuredOutputMode>([
  "json_schema",
  "json_object",
  "text_json",
]);
const STRUCTURED_OUTPUT_THINKING_MODES = new Set<StructuredOutputThinkingMode>([
  "inherit",
  "enabled",
  "disabled",
]);

type CompatibleResponseBody = {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
    };
  }>;
};

function completeJsonObject(value: string): string | undefined {
  const trimmed = value.trim();
  const unfenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim()
    ?? trimmed;
  try {
    const parsed = JSON.parse(unfenced) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return JSON.stringify(parsed);
  } catch {
    return undefined;
  }
}

function requestsStructuredOutput(init?: RequestInit): boolean {
  if (typeof init?.body !== "string") return false;
  try {
    const body = JSON.parse(init.body) as { response_format?: { type?: unknown } };
    return body.response_format?.type === "json_object" ||
      body.response_format?.type === "json_schema";
  } catch {
    return false;
  }
}

/**
 * Some OpenAI-compatible reasoning gateways return the requested JSON object in
 * `reasoning_content` while leaving the standard `content` field null. Promote it
 * only when the entire field is one complete JSON object. Mixed chain-of-thought
 * plus JSON must fail normally instead of being mistaken for the final answer.
 */
export function createStructuredOutputCompatibleFetch(
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!requestsStructuredOutput(init)) return response;
    if (!response.headers.get("content-type")?.includes("application/json")) return response;

    let body: CompatibleResponseBody;
    try {
      body = await response.clone().json() as CompatibleResponseBody;
    } catch {
      return response;
    }
    let changed = false;
    for (const choice of body.choices ?? []) {
      const message = choice.message;
      const structuredReasoning = typeof message?.reasoning_content === "string"
        ? completeJsonObject(message.reasoning_content)
        : undefined;
      if (
        message &&
        (message.content === null || message.content === undefined) &&
        structuredReasoning
      ) {
        message.content = structuredReasoning;
        changed = true;
      }
    }
    if (!changed) return response;

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

export function normalizeOpenAIBaseURL(value: string): string {
  const url = new URL(value.trim());
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function resolveStructuredOutputMode(
  value: string | undefined,
  fallback: StructuredOutputMode = "json_object",
): StructuredOutputMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (STRUCTURED_OUTPUT_MODES.has(normalized as StructuredOutputMode)) {
    return normalized as StructuredOutputMode;
  }
  throw new Error(
    `结构化输出模式 ${value} 无效；仅支持 json_schema、json_object、text_json`,
  );
}

export function configuredStructuredOutputMode(
  kind: "text" | "vision" = "text",
): StructuredOutputMode {
  const value = kind === "vision"
    ? process.env.AI_VISION_STRUCTURED_OUTPUT_MODE ?? process.env.AI_STRUCTURED_OUTPUT_MODE
    : process.env.AI_STRUCTURED_OUTPUT_MODE;
  return resolveStructuredOutputMode(value);
}

export function resolveStructuredOutputThinkingMode(
  value: string | undefined,
  _baseURL: string | undefined,
): StructuredOutputThinkingMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized) {
    if (STRUCTURED_OUTPUT_THINKING_MODES.has(normalized as StructuredOutputThinkingMode)) {
      return normalized as StructuredOutputThinkingMode;
    }
    throw new Error(
      `结构化输出 thinking 模式 ${value} 无效；仅支持 inherit、enabled、disabled`,
    );
  }
  return "enabled";
}

function configuredStructuredOutputThinkingMode(
  kind: "text" | "vision",
  baseURL: string | undefined,
): StructuredOutputThinkingMode {
  const value = kind === "vision"
    ? process.env.AI_VISION_THINKING_MODE ??
      process.env.AI_THINKING_MODE ??
      process.env.AI_VISION_STRUCTURED_OUTPUT_THINKING_MODE ??
      process.env.AI_STRUCTURED_OUTPUT_THINKING_MODE
    : process.env.AI_THINKING_MODE ??
      process.env.AI_STRUCTURED_OUTPUT_THINKING_MODE;
  return resolveStructuredOutputThinkingMode(value, baseURL);
}

export function transformStructuredOutputRequestBody(
  body: Record<string, unknown>,
  input: {
    mode: StructuredOutputMode;
    thinkingMode: StructuredOutputThinkingMode;
  },
): Record<string, unknown> {
  const transformed = { ...body };
  if (input.mode === "text_json") delete transformed.response_format;
  if (input.thinkingMode !== "inherit") {
    transformed.thinking = { type: input.thinkingMode };
  }
  return transformed;
}

export function withStructuredOutputGuidance<T>(input: {
  prompt: string;
  schema: ZodType<T>;
  name: string;
  kind?: "text" | "vision";
  mode?: StructuredOutputMode;
}): string {
  const mode = input.mode ?? configuredStructuredOutputMode(input.kind);
  if (mode === "json_schema") return input.prompt;
  const jsonSchema = z.toJSONSchema(input.schema);
  return [
    input.prompt,
    "[响应格式]",
    `只输出一个 JSON 根对象，不要输出 Markdown、代码围栏或解释。本次协议标识是 ${input.name}，它不是外层字段；根对象必须直接包含 Schema 中定义的属性。`,
    `JSON 必须通过以下 JSON Schema：${JSON.stringify(jsonSchema)}`,
  ].join("\n\n");
}

function getCompatibleModel(input: {
  modelId: string | undefined;
  missingMessage: string;
  providerName: string;
  apiKey?: string;
  baseURL?: string;
  structuredOutputMode: StructuredOutputMode;
  structuredOutputThinkingMode: StructuredOutputThinkingMode;
}) {
  const modelId = input.modelId?.trim();

  if (!modelId) {
    throw new Error(input.missingMessage);
  }

  const provider = createOpenAICompatible({
    name: input.providerName,
    apiKey: input.apiKey?.trim(),
    baseURL: normalizeOpenAIBaseURL(
      input.baseURL?.trim() || "https://api.openai.com/v1",
    ),
    includeUsage: true,
    supportsStructuredOutputs: input.structuredOutputMode === "json_schema",
    transformRequestBody: (body) => transformStructuredOutputRequestBody(body, {
      mode: input.structuredOutputMode,
      thinkingMode: input.structuredOutputThinkingMode,
    }),
    fetch: createStructuredOutputCompatibleFetch(),
  });

  return provider(modelId);
}

export function getChatModel() {
  return getCompatibleModel({
    modelId: process.env.AI_MODEL,
    missingMessage: "AI_MODEL is not configured",
    providerName: "club-ai",
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_API_BASE_URL,
    structuredOutputMode: configuredStructuredOutputMode("text"),
    structuredOutputThinkingMode: configuredStructuredOutputThinkingMode(
      "text",
      process.env.AI_API_BASE_URL,
    ),
  });
}

export function getVisionModel() {
  return getCompatibleModel({
    modelId: process.env.AI_VISION_MODEL,
    missingMessage: "AI_VISION_MODEL is not configured",
    providerName: "club-ai-vision",
    apiKey: process.env.AI_VISION_API_KEY?.trim() || process.env.AI_API_KEY,
    baseURL: process.env.AI_VISION_API_BASE_URL?.trim() || process.env.AI_API_BASE_URL,
    structuredOutputMode: configuredStructuredOutputMode("vision"),
    structuredOutputThinkingMode: configuredStructuredOutputThinkingMode(
      "vision",
      process.env.AI_VISION_API_BASE_URL?.trim() || process.env.AI_API_BASE_URL,
    ),
  });
}
