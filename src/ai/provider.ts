import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

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

function getCompatibleModel(input: {
  modelId: string | undefined;
  missingMessage: string;
  providerName: string;
  apiKey?: string;
  baseURL?: string;
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
    supportsStructuredOutputs: true,
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
  });
}

export function getVisionModel() {
  return getCompatibleModel({
    modelId: process.env.AI_VISION_MODEL,
    missingMessage: "AI_VISION_MODEL is not configured",
    providerName: "club-ai-vision",
    apiKey: process.env.AI_VISION_API_KEY?.trim() || process.env.AI_API_KEY,
    baseURL: process.env.AI_VISION_API_BASE_URL?.trim() || process.env.AI_API_BASE_URL,
  });
}
