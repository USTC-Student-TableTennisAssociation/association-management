import type { ModelMessage } from "ai";

import type { ModelProfile } from "@/ai/model-profile";
import type { AmbientHigherMemorySnapshot } from "@/memory/ambient-higher-memory";
import {
  emptyActorPrivateMemory,
  type ActorPrivateMemorySnapshot,
} from "@/memory/actor-higher-memory";
import {
  buildSystemPrompt,
  buildSystemPromptParts,
  type MemoryPromptState,
} from "@/ai/prompts";
import {
  buildEvidenceContext,
  countSeedMapItems,
  sliceSeedMapAssertions,
} from "@/memory/context-builder";
import type { MemoryRetrievalResult } from "@/memory/types";

export type ContextReport = {
  estimatedTokens: {
    system: number;
    conversation: number;
    memory: number;
    currentMessage: number;
    totalInput: number;
  };
  selected: {
    conversationMessages: number;
    memoryItems: number;
  };
  dropped: {
    conversationMessages: number;
    memoryItems: number;
  };
  limits: {
    contextWindow: number;
    preferredInput: number;
    hardInput: number;
    history: number;
    memory: number;
    outputReserve: number;
    safetyReserve: number;
  };
};

export type PreparedContext = {
  system: string;
  messages: ModelMessage[];
  retrieval: MemoryRetrievalResult;
  report: ContextReport;
};

export class ContextPackingError extends Error {
  constructor(
    message: string,
    readonly code: "current_message_too_large" | "missing_current_message",
  ) {
    super(message);
    this.name = "ContextPackingError";
  }
}

type HistoryTurn = {
  messages: ModelMessage[];
  estimatedTokens: number;
};

/**
 * 厂商 tokenizer 不同；第一阶段用 UTF-8 字节数 / 3 做保守估算。
 * 汉字通常占 3 字节，按约 1 token/字估算；ASCII 按约 3 字符/token 估算。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 3));
}

export function estimateMessageTokens(message: ModelMessage): number {
  return estimateTokens(JSON.stringify(message)) + 4;
}

function createHistoryTurns(messages: ModelMessage[]): {
  turns: HistoryTurn[];
  orphanedMessages: number;
} {
  const turns: HistoryTurn[] = [];
  let current: ModelMessage[] | null = null;
  let orphanedMessages = 0;

  for (const message of messages) {
    if (message.role === "user") {
      if (current) {
        turns.push({
          messages: current,
          estimatedTokens: current.reduce(
            (total, item) => total + estimateMessageTokens(item),
            0,
          ),
        });
      }
      current = [message];
    } else if (current) {
      current.push(message);
    } else {
      orphanedMessages += 1;
    }
  }

  if (current) {
    turns.push({
      messages: current,
      estimatedTokens: current.reduce(
        (total, item) => total + estimateMessageTokens(item),
        0,
      ),
    });
  }

  return { turns, orphanedMessages };
}

function splitCurrentMessage(messages: ModelMessage[]): {
  history: ModelMessage[];
  current: ModelMessage;
} {
  const current = messages.at(-1);
  if (!current || current.role !== "user") {
    throw new ContextPackingError(
      "最后一条有效消息必须来自用户。",
      "missing_current_message",
    );
  }

  return { history: messages.slice(0, -1), current };
}

function selectRecentHistory(
  history: ModelMessage[],
  maximumTokens: number,
): { turns: HistoryTurn[]; orphanedMessages: number } {
  const grouped = createHistoryTurns(history);
  const selected: HistoryTurn[] = [];
  let usedTokens = 0;

  for (let index = grouped.turns.length - 1; index >= 0; index -= 1) {
    const turn = grouped.turns[index];
    if (usedTokens + turn.estimatedTokens > maximumTokens) break;
    selected.unshift(turn);
    usedTokens += turn.estimatedTokens;
  }

  return { turns: selected, orphanedMessages: grouped.orphanedMessages };
}

function selectMemories(
  retrieval: MemoryRetrievalResult,
  maximumTokens: number,
): MemoryRetrievalResult {
  const higherMemoryOnly = {
    ...retrieval,
    seedMap: sliceSeedMapAssertions(retrieval.seedMap, 0),
  };
  if (estimateTokens(buildEvidenceContext(higherMemoryOnly)) > maximumTokens) {
    return higherMemoryOnly;
  }
  let assertionCount = 0;

  for (let count = 1; count <= retrieval.seedMap.assertions.length; count += 1) {
    const candidate = {
      ...retrieval,
      seedMap: sliceSeedMapAssertions(retrieval.seedMap, count),
    };
    if (estimateTokens(buildEvidenceContext(candidate)) > maximumTokens) break;
    assertionCount = count;
  }

  return {
    ...retrieval,
    seedMap: sliceSeedMapAssertions(retrieval.seedMap, assertionCount),
  };
}

function contextTokenCounts(
  system: string,
  historyTurns: HistoryTurn[],
  current: ModelMessage,
  retrieval: MemoryRetrievalResult,
  memoryState: MemoryPromptState,
  ambientHigherMemories: AmbientHigherMemorySnapshot[],
  actorPrivateMemory: ActorPrivateMemorySnapshot,
) {
  const promptParts = buildSystemPromptParts(
    retrieval,
    memoryState,
    ambientHigherMemories,
    actorPrivateMemory,
  );
  const systemTokens = estimateTokens(promptParts.base);
  const memoryTokens = promptParts.memory
    ? estimateTokens(promptParts.memory) + estimateTokens("\n\n")
    : 0;
  const conversationTokens = historyTurns.reduce(
    (total, turn) => total + turn.estimatedTokens,
    0,
  );
  const currentMessageTokens = estimateMessageTokens(current);

  return {
    system: systemTokens,
    conversation: conversationTokens,
    memory: memoryTokens,
    currentMessage: currentMessageTokens,
    totalInput:
      systemTokens + memoryTokens + conversationTokens + currentMessageTokens,
    renderedSystem: system,
  };
}

export function packContext(input: {
  messages: ModelMessage[];
  retrieval: MemoryRetrievalResult;
  profile: ModelProfile;
  memoryState?: MemoryPromptState;
  ambientHigherMemories?: AmbientHigherMemorySnapshot[];
  actorPrivateMemory?: ActorPrivateMemorySnapshot;
}): PreparedContext {
  const memoryState = input.memoryState ?? "searched";
  const ambientHigherMemories = input.ambientHigherMemories ?? [];
  const actorPrivateMemory = input.actorPrivateMemory ?? emptyActorPrivateMemory();
  const { history, current } = splitCurrentMessage(input.messages);
  const hardInput =
    input.profile.contextWindowTokens -
    input.profile.maxOutputTokens -
    input.profile.safetyTokens;
  const emptyRetrieval = {
    ...input.retrieval,
    seedMap: sliceSeedMapAssertions(input.retrieval.seedMap, 0),
  };
  const mandatorySystem = buildSystemPrompt(
    emptyRetrieval,
    memoryState,
    ambientHigherMemories,
    actorPrivateMemory,
  );
  const mandatoryTokens =
    estimateTokens(mandatorySystem) + estimateMessageTokens(current);

  if (mandatoryTokens > hardInput) {
    throw new ContextPackingError(
      `当前消息与系统提示预计需要 ${mandatoryTokens} tokens，超过本模型 ${hardInput} tokens 的输入硬上限。`,
      "current_message_too_large",
    );
  }

  let retrieval = selectMemories(input.retrieval, input.profile.memoryMaxTokens);
  const historySelection = selectRecentHistory(
    history,
    input.profile.historyMaxTokens,
  );
  const targetInput = Math.min(
    hardInput,
    Math.max(input.profile.preferredInputTokens, mandatoryTokens),
  );

  let system = buildSystemPrompt(
    retrieval,
    memoryState,
    ambientHigherMemories,
    actorPrivateMemory,
  );
  let counts = contextTokenCounts(
    system,
    historySelection.turns,
    current,
    retrieval,
    memoryState,
    ambientHigherMemories,
    actorPrivateMemory,
  );

  while (counts.totalInput > targetInput && historySelection.turns.length > 0) {
    historySelection.turns.shift();
    counts = contextTokenCounts(
      system,
      historySelection.turns,
      current,
      retrieval,
      memoryState,
      ambientHigherMemories,
      actorPrivateMemory,
    );
  }

  while (counts.totalInput > targetInput && retrieval.seedMap.assertions.length > 0) {
    retrieval = {
      ...retrieval,
      seedMap: sliceSeedMapAssertions(
        retrieval.seedMap,
        retrieval.seedMap.assertions.length - 1,
      ),
    };
    system = buildSystemPrompt(
      retrieval,
      memoryState,
      ambientHigherMemories,
      actorPrivateMemory,
    );
    counts = contextTokenCounts(
      system,
      historySelection.turns,
      current,
      retrieval,
      memoryState,
      ambientHigherMemories,
      actorPrivateMemory,
    );
  }

  const selectedHistory = historySelection.turns.flatMap((turn) => turn.messages);

  return {
    system,
    messages: [...selectedHistory, current],
    retrieval,
    report: {
      estimatedTokens: {
        system: counts.system,
        conversation: counts.conversation,
        memory: counts.memory,
        currentMessage: counts.currentMessage,
        totalInput: counts.totalInput,
      },
      selected: {
        conversationMessages: selectedHistory.length,
        memoryItems: countSeedMapItems(retrieval.seedMap),
      },
      dropped: {
        conversationMessages: history.length - selectedHistory.length,
        memoryItems:
          countSeedMapItems(input.retrieval.seedMap) -
          countSeedMapItems(retrieval.seedMap),
      },
      limits: {
        contextWindow: input.profile.contextWindowTokens,
        preferredInput: input.profile.preferredInputTokens,
        hardInput,
        history: input.profile.historyMaxTokens,
        memory: input.profile.memoryMaxTokens,
        outputReserve: input.profile.maxOutputTokens,
        safetyReserve: input.profile.safetyTokens,
      },
    },
  };
}
