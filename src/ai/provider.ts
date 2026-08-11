import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export function normalizeOpenAIBaseURL(value: string): string {
  const url = new URL(value.trim());
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function getChatModel() {
  const modelId = process.env.AI_MODEL?.trim();

  if (!modelId) {
    throw new Error("AI_MODEL is not configured");
  }

  const provider = createOpenAICompatible({
    name: "club-ai",
    apiKey: process.env.AI_API_KEY?.trim(),
    baseURL: normalizeOpenAIBaseURL(
      process.env.AI_API_BASE_URL?.trim() || "https://api.openai.com/v1",
    ),
    includeUsage: true,
  });

  return provider(modelId);
}
