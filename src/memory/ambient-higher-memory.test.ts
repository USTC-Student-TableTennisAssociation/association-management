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
  ambientHigherMemoryQualityIssue,
  buildAmbientHigherMemoryContext,
  loadAmbientHigherMemories,
  maintainAmbientHigherMemories,
} from "@/memory/ambient-higher-memory";
import type { MemoryRetrievalResult } from "@/memory/types";

const maintainedAt = new Date("2026-08-15T00:00:00.000Z");

function retrieval(): MemoryRetrievalResult {
  return {
    query: "我们最近在准备比赛",
    mode: "object-assertion",
    seedMap: { facets: [], objects: [], assertions: [], connections: [] },
  };
}

function input() {
  return {
    clientMessageId: "message-current",
    submittedAt: "2026-08-15T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    semanticContext: {
      conversation: [{
        messageId: "message-current",
        role: "user" as const,
        text: "我们最近正在准备一场比赛，场地是当前重点。",
      }],
      systemInstruction: "main system",
      modelCalls: [],
      toolExecutions: [],
      finalAnswer: "明白，后续可以围绕场地继续推进。",
    },
    retrieval: retrieval(),
    scopes: ["identity" as const, "working_set" as const],
    reason: "本轮形成了环境与近期工作理解",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const upsert = vi.fn().mockResolvedValue({ id: "ambient-memory" });
  const transaction = { memoryAmbientHigherMemory: { upsert } };
  databaseState.database = {
    memoryAmbientHigherMemory: {
      findMany: vi.fn().mockResolvedValue([
        {
          scope: "working_set",
          contentMarkdown: "近期重点尚不明确。",
          maintainedAt,
        },
        {
          scope: "identity",
          contentMarkdown: "Sydaris 正在逐步理解当前环境。",
          maintainedAt,
        },
      ]),
    },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<void>) =>
      callback(transaction)
    ),
    __transaction: transaction,
  };
  aiState.generateText.mockResolvedValue({
    toolCalls: [{
      toolName: "submitAmbientHigherMemory",
      input: {
        memories: [{
          scope: "identity",
          contentMarkdown: "## 当前环境\n\nSydaris 正在逐步理解这个团队、长期工作方式及自身能承担的协作职责；目前主要根据真实对话延续共同工作，仍应通过后续互动和实际业务读取继续修正这种理解，不能预设环境类型或成员身份。",
        }, {
          scope: "working_set",
          contentMarkdown: "## 近期焦点\n\n近期主要在准备一场比赛，场地是当前重点；具体申请和确认状态可能继续变化，下一轮协作时应先了解最新进展，再根据仍未解决的风险决定是否需要协助准备材料、联系相关方或调整安排。",
        }],
      },
    }],
  });
});

describe("ambient Higher Memory", () => {
  it("rejects AI process diagnostics as durable environment memory", () => {
    expect(ambientHigherMemoryQualityIssue(
      "主模型没有 searchMemory 工具，所以 Shared Brain 缺少语义检索能力。",
    )).toMatch(/系统能力诊断/);
  });

  it("loads singleton scopes in identity/narrative/working-set order", async () => {
    await expect(loadAmbientHigherMemories()).resolves.toEqual([
      expect.objectContaining({ scope: "identity" }),
      expect.objectContaining({ scope: "working_set" }),
    ]);
  });

  it("renders ambient cognition as automatically loaded non-authoritative context", async () => {
    const context = buildAmbientHigherMemoryContext(await loadAmbientHigherMemories());
    expect(context).toContain("Environment Identity");
    expect(context).toContain("Shared Working Set");
    expect(context).toContain("无需先搜索");
    expect(context).toContain("Business View");
    expect(context).toContain("Object–Assertion 图");
  });

  it("always explains the architecture and explicit empty Ambient state", () => {
    const context = buildAmbientHigherMemoryContext([]);
    expect(context).toContain("本轮没有加载到 identity、narrative 或 working_set");
    expect(context).toContain("不代表 Higher Memory 架构不存在");
    expect(context).toContain("Object Higher Memory");
  });

  it("uses the real dialogue context without requiring another search and upserts both scopes", async () => {
    await expect(maintainAmbientHigherMemories(input())).resolves.toBe(2);

    const call = aiState.generateText.mock.calls[0][0];
    expect(call.tools).toHaveProperty("submitAmbientHigherMemory");
    expect(call.toolChoice).toEqual({
      type: "tool",
      toolName: "submitAmbientHigherMemory",
    });
    expect(call.prompt).toContain("我们最近正在准备一场比赛");
    expect(call.prompt).toContain("不得直接把未验证的用户陈述或 Assistant 最终回答当作事实");
    expect(call.prompt).toContain("严禁写入检索是否命中");
    expect(call.prompt).toContain("Object–Assertion 图");

    const transaction = (databaseState.database as {
      __transaction: { memoryAmbientHigherMemory: { upsert: ReturnType<typeof vi.fn> } };
    }).__transaction;
    expect(transaction.memoryAmbientHigherMemory.upsert).toHaveBeenCalledTimes(2);
    expect(transaction.memoryAmbientHigherMemory.upsert).toHaveBeenCalledWith({
      where: { scope: "working_set" },
      create: expect.objectContaining({
        scope: "working_set",
        triggerMessageId: "message-current",
        maintenanceReason: "本轮形成了环境与近期工作理解",
      }),
      update: expect.objectContaining({
        contentMarkdown: expect.stringContaining("场地"),
      }),
    });
  });

  it("keeps old memories when the agent has no useful replacement", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitAmbientHigherMemory",
        input: { memories: [] },
      }],
    });

    await expect(maintainAmbientHigherMemories(input())).resolves.toBe(0);

    const database = databaseState.database as { $transaction: ReturnType<typeof vi.fn> };
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("does not persist an agent output containing retrieval diagnostics", async () => {
    aiState.generateText.mockResolvedValue({
      toolCalls: [{
        toolName: "submitAmbientHigherMemory",
        input: {
          memories: [{
            scope: "working_set",
            contentMarkdown: "## 近期焦点\n\n主模型缺少 searchMemory 工具，因此当前检索路径没有覆盖 Shared Brain，后续需要继续修复系统能力；这只是本轮模型对工具调用过程的判断，不是团队近期工作的真实业务状态，也不应进入下一轮自动上下文。",
          }],
        },
      }],
    });

    await expect(maintainAmbientHigherMemories(input())).resolves.toBe(0);
    const database = databaseState.database as { $transaction: ReturnType<typeof vi.fn> };
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});
