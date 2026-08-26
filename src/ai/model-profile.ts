export type ModelProfile = {
  contextWindowTokens: number;
  preferredInputTokens: number;
  maxOutputTokens: number;
  safetyTokens: number;
  historyMaxTokens: number;
  memoryMaxTokens: number;
  maxRequestBytes: number;
  maxRetries: number;
  modelFirstChunkTimeoutMs: number;
  modelChunkTimeoutMs: number;
};

type Environment = Record<string, string | undefined>;

function environmentInteger(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }

  return value;
}

export function createModelProfile(
  environment: Environment = process.env,
): ModelProfile {
  const contextWindowTokens = environmentInteger(
    environment,
    "AI_CONTEXT_WINDOW_TOKENS",
    200_000,
    16_384,
    2_000_000,
  );
  const maxOutputTokens = environmentInteger(
    environment,
    "AI_MAX_OUTPUT_TOKENS",
    16_384,
    1_024,
    131_072,
  );
  const safetyTokens = environmentInteger(
    environment,
    "AI_CONTEXT_SAFETY_TOKENS",
    12_000,
    1_024,
    131_072,
  );
  const hardInputTokens =
    contextWindowTokens - maxOutputTokens - safetyTokens;
  if (hardInputTokens <= 0) {
    throw new Error(
      "AI_CONTEXT_WINDOW_TOKENS 必须大于输出预留与上下文安全余量之和",
    );
  }

  const preferredInputTokens = environmentInteger(
    environment,
    "AI_PREFERRED_INPUT_TOKENS",
    Math.min(128_000, hardInputTokens),
    1_024,
    hardInputTokens,
  );

  return {
    contextWindowTokens,
    preferredInputTokens,
    maxOutputTokens,
    safetyTokens,
    historyMaxTokens: environmentInteger(
      environment,
      "AI_HISTORY_MAX_TOKENS",
      40_000,
      0,
      hardInputTokens,
    ),
    memoryMaxTokens: environmentInteger(
      environment,
      "AI_MEMORY_MAX_TOKENS",
      64_000,
      0,
      hardInputTokens,
    ),
    maxRequestBytes: environmentInteger(
      environment,
      "AI_MAX_REQUEST_BYTES",
      2_000_000,
      256_000,
      10_000_000,
    ),
    maxRetries: environmentInteger(
      environment,
      "AI_MAX_RETRIES",
      2,
      0,
      5,
    ),
    modelFirstChunkTimeoutMs: environmentInteger(
      environment,
      "AI_MODEL_FIRST_CHUNK_TIMEOUT_MS",
      1_800_000,
      1_000,
      1_800_000,
    ),
    modelChunkTimeoutMs: environmentInteger(
      environment,
      "AI_MODEL_CHUNK_TIMEOUT_MS",
      1_800_000,
      1_000,
      1_800_000,
    ),
  };
}
