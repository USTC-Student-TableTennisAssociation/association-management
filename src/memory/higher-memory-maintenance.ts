import type { EchoDebugTrace } from "@/ai/debug-trace";
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
};

export type HigherMemoryMaintenanceResult = {
  objectMemories: number;
  ambientMemories: number;
};

export async function maintainHigherMemories(
  input: HigherMemoryMaintenanceInput,
  trace?: EchoDebugTrace,
): Promise<HigherMemoryMaintenanceResult> {
  const objectDecision = objectHigherMemoryQueueDecision(input.queueDecision);
  const ambientScopes = ambientScopesFromQueueDecision(input.queueDecision);
  let objectMemories = 0;
  let ambientMemories = 0;

  if (objectDecision) {
    objectMemories = await maintainObjectHigherMemories({
      ...input,
      queueDecision: objectDecision,
    }, trace);
  }
  if (ambientScopes.length) {
    ambientMemories = await maintainAmbientHigherMemories({
      clientMessageId: input.clientMessageId,
      submittedAt: input.submittedAt,
      timezone: input.timezone,
      semanticContext: input.semanticContext,
      retrieval: input.retrieval,
      scopes: ambientScopes,
      reason: input.queueDecision.reason,
    }, trace);
  }
  return { objectMemories, ambientMemories };
}
