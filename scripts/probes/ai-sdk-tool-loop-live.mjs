/**
 * Explicit live compatibility probe for an OpenAI-compatible endpoint.
 *
 * This script intentionally does not load `.env` and does not read AI_API_KEY.
 * Supply a fresh, probe-only credential explicitly:
 *
 * SYDARIS_TOOL_PROBE_BASE_URL=https://example.com/v1 \
 * SYDARIS_TOOL_PROBE_MODEL=model-id \
 * SYDARIS_TOOL_PROBE_API_KEY=fresh-key \
 * node scripts/probes/ai-sdk-tool-loop-live.mjs
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

const requiredEnvironment = [
  "SYDARIS_TOOL_PROBE_BASE_URL",
  "SYDARIS_TOOL_PROBE_MODEL",
  "SYDARIS_TOOL_PROBE_API_KEY",
];
const missing = requiredEnvironment.filter(
  (name) => !process.env[name]?.trim(),
);

if (missing.length > 0) {
  console.error(
    `Refusing to run: set fresh probe-only variables: ${missing.join(", ")}`,
  );
  process.exitCode = 2;
} else {
  const baseURLValue = new URL(process.env.SYDARIS_TOOL_PROBE_BASE_URL.trim());
  baseURLValue.pathname = baseURLValue.pathname
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  const baseURL = baseURLValue.toString().replace(/\/$/, "");
  const modelId = process.env.SYDARIS_TOOL_PROBE_MODEL.trim();
  const apiKey = process.env.SYDARIS_TOOL_PROBE_API_KEY.trim();
  const marker = `sydaris-tool-probe-${Date.now()}`;
  const executions = [];

  const provider = createOpenAICompatible({
    name: "sydaris-tool-probe",
    baseURL,
    apiKey,
    includeUsage: true,
  });
  const tools = {
    probeTool: tool({
      description: "Return the exact marker supplied by the caller.",
      inputSchema: z.object({ marker: z.string() }),
      execute: async ({ marker: receivedMarker }) => {
        executions.push(receivedMarker);
        return { marker: receivedMarker, accepted: true };
      },
    }),
  };

  console.log(
    JSON.stringify({ event: "start", baseURL, modelId, marker }, null, 2),
  );

  const result = streamText({
    model: provider(modelId),
    tools,
    prompt:
      `Call probeTool exactly once with marker ${JSON.stringify(marker)}. ` +
      "After receiving its result, answer with only that marker.",
    stopWhen: stepCountIs(2),
    prepareStep: ({ stepNumber }) => ({
      // This probes both function-tool support and tool_choice handling.
      toolChoice: stepNumber === 0 ? "required" : "none",
    }),
    timeout: {
      totalMs: 360_000,
      stepMs: 180_000,
      chunkMs: 60_000,
      toolMs: 5_000,
    },
  });

  await result.consumeStream({
    onError: (error) => {
      console.error("stream error", error);
    },
  });

  const text = await result.text;
  const steps = await result.steps;
  const passed =
    executions.length === 1 &&
    executions[0] === marker &&
    text.trim() === marker &&
    steps.length === 2;

  console.log(
    JSON.stringify(
      {
        event: "result",
        passed,
        executions,
        text,
        steps: steps.map((step) => ({
          stepNumber: step.stepNumber,
          finishReason: step.finishReason,
          toolCalls: step.toolCalls.map((call) => call.toolName),
        })),
        usage: await result.usage,
      },
      null,
      2,
    ),
  );

  if (!passed) {
    process.exitCode = 1;
  }
}
