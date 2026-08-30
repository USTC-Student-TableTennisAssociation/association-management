import { z } from "zod";

import type { AIInvocation } from "@sydaris/plugin-sdk";

const stableActionId = z.string().trim().min(1).max(160).regex(
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
  "AI actionId 必须是稳定的小写标识符",
);

export const echoAIInvocationSchema: z.ZodType<AIInvocation> = z.object({
  actionId: stableActionId,
  message: z.string().trim().min(1).max(1_000),
  skill: z.object({
    id: stableActionId,
    input: z.unknown(),
  }).strict().optional(),
}).strict();

