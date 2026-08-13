import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EchoDebugTrace } from "@/ai/debug-trace";
import { getChatModel } from "@/ai/provider";
import { getDatabase } from "@/db";
import { captureChatAssertions, localDateAt } from "@/memory/chat-assertion";
import { embedMemoryQueries } from "@/memory/embedding-client";
import { createMemoryExploreToolset } from "@/memory/explore-toolset";
import type { MemoryRetrievalResult } from "@/memory/types";

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return { ...original, generateText: vi.fn() };
});
vi.mock("@/ai/provider", () => ({ getChatModel: vi.fn() }));
vi.mock("@/db", () => ({ getDatabase: vi.fn() }));
vi.mock("@/memory/embedding-client", () => ({ embedMemoryQueries: vi.fn() }));
vi.mock("@/memory/explore-toolset", () => ({
  createMemoryExploreToolset: vi.fn(() => ({})),
}));

const compilationId = "00000000-0000-4000-8000-000000000010";
const objectId = "00000000-0000-4000-8000-000000000020";

function retrieval(): MemoryRetrievalResult {
  return {
    query: "乒协星级",
    mode: "object-assertion",
    compilationId,
    seedMap: {
      facets: [],
      objects: [{
        ref: "O1",
        id: objectId,
        globalObjectKey: "table-tennis-association",
        canonicalName: "中国科学技术大学学生乒乓球协会",
        surfaceForms: ["乒协"],
        matchedBy: [],
        matchedFacets: [],
        supportingAssertions: [],
        lexicalMatch: true,
        semanticMatch: false,
      }],
      assertions: [],
      connections: [],
    },
  };
}

function input() {
  return {
    clientMessageId: "user-current",
    submittedAt: "2026-08-13T02:00:00.000Z",
    timezone: "Asia/Shanghai",
    semanticContext: {
      conversation: [
        { messageId: "user-context", role: "user" as const, text: "我说的是乒协。" },
        { messageId: "assistant-context", role: "assistant" as const, text: "目前记录是三星。" },
        {
          messageId: "user-current",
          role: "user" as const,
          text: "其实25-26学年变成4星社团了呢！",
          submittedAt: "2026-08-13T02:00:00.000Z",
        },
      ],
      systemInstruction: "主模型系统提示",
      modelCalls: [{
        callId: "main-call",
        callNumber: 1,
        instructions: "主模型系统提示",
        messages: "完整模型输入",
        output: "reasoning 与工具调用",
      }],
      toolExecutions: [],
      finalAnswer: "我理解了。",
    },
    retrieval: retrieval(),
    queueDecision: { reason: "用户纠正了乒协的学年星级" },
  };
}

function mockDatabase() {
  const transaction = {
    memoryCompilation: {
      findFirst: vi.fn().mockResolvedValue({
        id: compilationId,
        assertionEmbeddingIndex: { indexedAssertionCount: 10 },
      }),
    },
    memoryAssertion: { count: vi.fn().mockResolvedValue(10), createMany: vi.fn() },
    memoryGlobalObject: { count: vi.fn().mockResolvedValue(1) },
    memoryActor: { upsert: vi.fn() },
    memoryChatEvidence: {
      upsert: vi.fn()
        .mockResolvedValueOnce({ id: "00000000-0000-4000-8000-000000000031" })
        .mockResolvedValueOnce({ id: "00000000-0000-4000-8000-000000000032" }),
    },
    memoryChatAssertionCapture: { create: vi.fn() },
    memoryAssertionChatEvidenceLink: { createMany: vi.fn() },
    memoryGlobalAssertionLiteralReference: { createMany: vi.fn() },
    memoryAssertionEmbeddingIndex: { update: vi.fn() },
    $executeRaw: vi.fn(),
  };
  const database = {
    memoryChatAssertionCapture: { findFirst: vi.fn().mockResolvedValue(null) },
    memoryCompilation: {
      findFirst: vi.fn().mockResolvedValue({
        id: compilationId,
        assertionEmbeddingIndex: {
          modelKey: "BAAI/bge-m3",
          modelRevision: "test",
          dimension: 1024,
          indexedAssertionCount: 10,
        },
      }),
    },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
  };
  vi.mocked(getDatabase).mockReturnValue(database as never);
  return { database, transaction };
}

function mockTrace() {
  return {
    enabled: true,
    appendSection: vi.fn().mockResolvedValue(undefined),
    appendJsonSection: vi.fn().mockResolvedValue(undefined),
    appendError: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  } satisfies EchoDebugTrace;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChatModel).mockReturnValue({} as never);
});

describe("Chat Assertion capture agent", () => {
  it("uses the server instant to derive the organization-local date", () => {
    expect(localDateAt(new Date("2026-08-12T16:30:00.000Z"), "Asia/Shanghai"))
      .toBe("2026-08-13");
  });

  it("passes full semantic context and reusable retrieval to a searchable extractor", async () => {
    mockDatabase();
    vi.mocked(generateText).mockResolvedValue({
      output: { assertions: [] },
    } as never);

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toBe(0);

    expect(createMemoryExploreToolset).toHaveBeenCalledWith(expect.objectContaining({
      resultTokenBudget: 32_000,
    }));
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      tools: {},
      toolChoice: "auto",
      prompt: expect.stringContaining("完整模型输入"),
    }));
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain("initialRetrieval");
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain("采用最小规范化");
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      "不能改成“获评四星级社团”",
    );
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      "必须把提供该主语的历史 user 消息也列入 evidence",
    );
  });

  it("publishes one Assertion linked to multiple exact user Evidence messages", async () => {
    const { database, transaction } = mockDatabase();
    vi.mocked(generateText).mockResolvedValue({
      output: {
        assertions: [{
          globalStatementTemplateMarkdown:
            `{{object:${objectId}}}在2025-2026学年变成4星社团。`,
          objectIds: [objectId],
          evidence: [
            { messageId: "user-context", quotes: ["乒协"] },
            { messageId: "user-current", quotes: ["25-26学年变成4星社团"] },
          ],
        }],
      },
    } as never);
    vi.mocked(embedMemoryQueries).mockResolvedValue({
      model: "BAAI/bge-m3",
      modelRevision: "test",
      dimension: 1024,
      vectors: [Array.from({ length: 1024 }, () => 0.1)],
    });

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toBe(1);

    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.memoryChatEvidence.upsert).toHaveBeenCalledTimes(2);
    expect(transaction.memoryChatAssertionCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        queuedByMessageId: "user-current",
        queueReason: "用户纠正了乒协的学年星级",
      }),
    });
    expect(transaction.memoryAssertion.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        chatCaptureId: expect.any(String),
        statementTemplateMarkdown:
          "中国科学技术大学学生乒乓球协会在2025-2026学年变成4星社团。",
      })],
    });
    expect(transaction.memoryAssertionChatEvidenceLink.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ evidenceQuotes: ["乒协"], ordinal: 0 }),
        expect.objectContaining({ evidenceQuotes: ["25-26学年变成4星社团"], ordinal: 1 }),
      ]),
    });
  });

  it("rejects an assertion that omits the current user message or uses assistant text", async () => {
    const { database, transaction } = mockDatabase();
    vi.mocked(generateText).mockResolvedValue({
      output: {
        assertions: [{
          globalStatementTemplateMarkdown: `{{object:${objectId}}}目前是三星社团。`,
          objectIds: [objectId],
          evidence: [{ messageId: "assistant-context", quotes: ["目前记录是三星"] }],
        }],
      },
    } as never);

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toBe(0);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(transaction.memoryChatEvidence.upsert).not.toHaveBeenCalled();
  });

  it("rejects an Object whose subject appears only in assistant/context interpretation", async () => {
    const { database, transaction } = mockDatabase();
    vi.mocked(generateText).mockResolvedValue({
      output: {
        assertions: [{
          globalStatementTemplateMarkdown:
            `{{object:${objectId}}}在2025-2026学年是四星社团。`,
          objectIds: [objectId],
          evidence: [{
            messageId: "user-current",
            quotes: ["25-26学年变成4星社团"],
          }],
        }],
      },
    } as never);

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toBe(0);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(transaction.memoryChatEvidence.upsert).not.toHaveBeenCalled();
  });

  it("rejects a template that repeats the Object name outside its placeholder", async () => {
    const { database, transaction } = mockDatabase();
    vi.mocked(generateText).mockResolvedValue({
      output: {
        assertions: [{
          globalStatementTemplateMarkdown:
            `中国科学技术大学学生乒乓球协会（{{object:${objectId}}}）在2025-2026学年是四星社团。`,
          objectIds: [objectId],
          evidence: [
            { messageId: "user-context", quotes: ["乒协"] },
            { messageId: "user-current", quotes: ["25-26学年变成4星社团"] },
          ],
        }],
      },
    } as never);

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toBe(0);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(transaction.memoryChatEvidence.upsert).not.toHaveBeenCalled();
  });
});
