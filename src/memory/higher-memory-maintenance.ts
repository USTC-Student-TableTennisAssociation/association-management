import type { DebugTrace } from "@/ai/debug-trace";
import { maintainAmbientHigherMemories } from "@/memory/ambient-higher-memory";
import type { ChatAssertionSemanticContext } from "@/memory/chat-assertion";
import {
  ambientScopesFromQueueDecision,
  objectHigherMemoryQueueDecision,
  type HigherMemoryQueueDecision,
} from "@/memory/higher-memory-queue";
import { maintainObjectHigherMemories } from "@/memory/object-higher-memory";
import type { MemoryRetrievalResult } from "@/memory/types";

export type HigherMemoryMaintenanceInput = {
  clientMessageId: string;
  submittedAt: string;
  timezone: string;
  semanticContext: ChatAssertionSemanticContext;
  retrieval: MemoryRetrievalResult;
  queueDecision: HigherMemoryQueueDecision;
  existingObjectMemoriesOnly?: boolean;
};

export type HigherMemoryMaintenanceResult = {
  objectMemories: number;
  ambientMemories: number;
};

function isTimeoutFailure(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) return false;
  seen.add(error);
  if (typeof error === "object") {
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    const detail = `${String(candidate.name ?? "")} ${String(candidate.message ?? "")}`;
    if (/(?:timeout|timed out)/iu.test(detail)) return true;
    if (isTimeoutFailure(candidate.cause, seen)) return true;
    if (Array.isArray(candidate.errors) && candidate.errors.some((item) =>
      isTimeoutFailure(item, seen)
    )) return true;
  }
  return false;
}

async function runWithOneTimeoutRetry<T>(
  label: string,
  operation: () => Promise<T>,
  trace?: DebugTrace,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTimeoutFailure(error)) throw error;
    await trace?.appendSection(
      `${label} 超时重试`,
      "第一次模型调用超时；旧 Higher Memory 尚未改变，正在进行唯一一次完整重试。",
    );
    return operation();
  }
}

export async function maintainHigherMemories(
  input: HigherMemoryMaintenanceInput,
  trace?: DebugTrace,
): Promise<HigherMemoryMaintenanceResult> {
  const objectDecision = objectHigherMemoryQueueDecision(input.queueDecision);
  const ambientScopes = ambientScopesFromQueueDecision(input.queueDecision);
  let objectMemories = 0;
  let ambientMemories = 0;

  if (objectDecision) {
    objectMemories = await runWithOneTimeoutRetry(
      "Object Higher Memory",
      () => maintainObjectHigherMemories({
        ...input,
        queueDecision: objectDecision,
        existingOnly: input.existingObjectMemoriesOnly,
      }, trace),
      trace,
    );
  }
  if (ambientScopes.length) {
    ambientMemories = await runWithOneTimeoutRetry(
      "Ambient Higher Memory",
      () => maintainAmbientHigherMemories({
        clientMessageId: input.clientMessageId,
        submittedAt: input.submittedAt,
        timezone: input.timezone,
        semanticContext: input.semanticContext,
        retrieval: input.retrieval,
        scopes: ambientScopes,
        reason: input.queueDecision.reason,
      }, trace),
      trace,
    );
  }
  return { objectMemories, ambientMemories };
}
