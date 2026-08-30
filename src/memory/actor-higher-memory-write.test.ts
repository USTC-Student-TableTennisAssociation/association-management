import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("@/db", () => ({ getDatabase: () => databaseState.database }));

import { createActorHigherMemoryWriteToolset } from "@/memory/actor-higher-memory-write";

const actorId = "00000000-0000-4000-8000-000000000001";
const toolOptions = {
  toolCallId: "tool-call-actor-higher-memory",
  messages: [],
  abortSignal: undefined,
  context: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  const transaction = {
    memoryActor: { count: vi.fn().mockResolvedValue(1) },
    memoryActorHigherMemory: {
      upsert: vi.fn().mockResolvedValue({ id: "memory-1" }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  databaseState.database = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction)
    ),
    __transaction: transaction,
  };
});

describe("synchronous natural-language Actor Higher Memory writes", () => {
  it("stores the relationship as natural language rather than a semantic key", async () => {
    const toolset = createActorHigherMemoryWriteToolset({
      actorId,
      currentMessageId: "message-current",
      currentUserMessage: "方案审阅由我提出取舍，你负责整理理由。请跨会话记住。",
    });

    const result = await toolset.tool.execute!({
      revisions: [{
        action: "replace",
        scope: "interaction",
        contentMarkdown: "方案审阅中，当前用户负责提出取舍，Sydaris 负责整理理由；该协作约定需要跨会话延续。",
        evidenceQuote: "方案审阅由我提出取舍，你负责整理理由",
      }],
    }, toolOptions);

    expect(result).toMatchObject({
      committed: true,
      replacedScopes: ["interaction"],
    });
    expect(toolset.hasCommit()).toBe(true);
    expect(toolset.hasReplacementCommit()).toBe(true);
    const transaction = (databaseState.database as {
      __transaction: {
        memoryActorHigherMemory: { upsert: ReturnType<typeof vi.fn> };
      };
    }).__transaction;
    expect(transaction.memoryActorHigherMemory.upsert).toHaveBeenCalledWith({
      where: { actorId_scope: { actorId, scope: "interaction" } },
      create: expect.objectContaining({
        actorId,
        scope: "interaction",
        contentMarkdown: expect.stringContaining("当前用户负责提出取舍"),
        triggerMessageId: "message-current",
      }),
      update: expect.objectContaining({
        contentMarkdown: expect.stringContaining("Sydaris 负责整理理由"),
      }),
    });
  });

  it("rejects an evidence quote that is not in the current user message", async () => {
    const toolset = createActorHigherMemoryWriteToolset({
      actorId,
      currentMessageId: "message-current",
      currentUserMessage: "今天随便聊聊。",
    });

    await expect(toolset.tool.execute!({
      revisions: [{
        action: "replace",
        scope: "interaction",
        contentMarkdown: "方案审阅中，当前用户负责提出取舍，Sydaris 负责整理理由；该协作约定需要跨会话延续。",
        evidenceQuote: "方案审阅由我提出取舍，你负责整理理由",
      }],
    }, toolOptions)).resolves.toMatchObject({ committed: false });
    expect(toolset.hasCommit()).toBe(false);
  });

  it("clears a scope only from an explicit current request", async () => {
    const toolset = createActorHigherMemoryWriteToolset({
      actorId,
      currentMessageId: "message-current",
      currentUserMessage: "请忘记我们之前的方案审阅协作约定。",
    });

    await expect(toolset.tool.execute!({
      revisions: [{
        action: "clear",
        scope: "interaction",
        evidenceQuote: "请忘记我们之前的方案审阅协作约定",
      }],
    }, toolOptions)).resolves.toMatchObject({
      committed: true,
      clearedScopes: ["interaction"],
    });
    expect(toolset.hasReplacementCommit()).toBe(false);
  });
});
