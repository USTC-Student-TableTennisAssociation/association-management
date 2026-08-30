import { beforeEach, describe, expect, it, vi } from "vitest";

const aiState = vi.hoisted(() => ({ generateText: vi.fn() }));
const databaseState = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return { ...original, generateText: aiState.generateText };
});
vi.mock("@/ai/provider", () => ({ getChatModel: () => ({}) }));
vi.mock("@/db", () => ({ getDatabase: () => databaseState.database }));

import {
  actorHigherMemoryQualityIssue,
  buildActorPrivateMemoryContext,
  loadActorPrivateMemory,
  maintainActorHigherMemories,
} from "@/memory/actor-higher-memory";

const actorId = "00000000-0000-4000-8000-000000000001";
const maintainedAt = new Date("2026-08-27T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  const transaction = {
    memoryActor: { count: vi.fn().mockResolvedValue(1) },
    memoryActorHigherMemory: {
      upsert: vi.fn().mockResolvedValue({ id: "actor-memory-1" }),
    },
  };
  databaseState.database = {
    memoryActorHigherMemory: {
      findMany: vi.fn().mockResolvedValue([{
        scope: "interaction",
        contentMarkdown: "当前用户希望 Sydaris 在回答不确定问题时先说明证据边界。",
        maintainedAt,
      }]),
    },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction)
    ),
    __transaction: transaction,
  };
  aiState.generateText.mockResolvedValue({
    toolCalls: [{
      toolName: "submitActorHigherMemory",
      input: {
        memories: [{
          scope: "interaction",
          contentMarkdown: "用户明确要求在讨论不确定事项时先说明证据边界，再给出可执行建议；这一约定适用于后续协作，但不能覆盖正式事实核验。",
        }],
      },
    }],
  });
});

describe("Actor Higher Memory", () => {
  it("loads only one Actor's natural-language Higher Memory", async () => {
    const memory = await loadActorPrivateMemory(actorId);
    expect(memory.higherMemories).toEqual([
      expect.objectContaining({ scope: "interaction" }),
    ]);
    const context = buildActorPrivateMemoryContext(memory);
    expect(context).toContain("只属于当前登录 Actor");
    expect(context).toContain("当前用户希望 Sydaris 在回答不确定问题时先说明证据边界");
    expect(context).toContain("不得向其他 Actor 暴露");
  });

  it("uses only user messages plus existing private state when rebuilding", async () => {
    await expect(maintainActorHigherMemories({
      actorId,
      actorDisplayName: "测试用户",
      clientMessageId: "message-current",
      submittedAt: "2026-08-27T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      semanticContext: {
        conversation: [{
          messageId: "message-current",
          role: "user",
          text: "以后讨论不确定事项时，请先说明证据边界。",
        }, {
          messageId: "assistant-current",
          role: "assistant",
          text: "助手臆测：用户永远只喜欢一种交流方式。",
        }],
        systemInstruction: "secret system prompt",
        modelCalls: [],
        toolExecutions: [],
        finalAnswer: "assistant final answer",
      },
      queueDecision: {
        scopes: ["interaction"],
        reason: "用户明确设置了长期互动约定",
      },
    })).resolves.toBe(1);

    const call = aiState.generateText.mock.calls[0][0];
    expect(call.prompt).toContain("以后讨论不确定事项时，请先说明证据边界");
    expect(call.prompt).toContain("当前用户希望 Sydaris 在回答不确定问题时先说明证据边界");
    expect(call.prompt).toContain("发起者、动作和接受者或对象");
    expect(call.prompt).not.toContain("助手臆测：用户永远只喜欢一种交流方式");
    expect(call.prompt).not.toContain("secret system prompt");

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
        triggerMessageId: "message-current",
      }),
      update: expect.objectContaining({
        contentMarkdown: expect.stringContaining("证据边界"),
      }),
    });
  });

  it("rejects secrets and raw contact details from synthesized memory", () => {
    expect(actorHigherMemoryQualityIssue(
      "用户的 access_token: abcdefghijklmnop，应当下轮继续使用。",
    )).toMatch(/秘密/);
    expect(actorHigherMemoryQualityIssue(
      "用户联系电话是 13800138000。",
    )).toMatch(/联系方式/);
  });
});
