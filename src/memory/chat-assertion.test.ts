import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EchoDebugTrace } from "@/ai/debug-trace";
import { getChatModel } from "@/ai/provider";
import { getDatabase } from "@/db";
import { captureChatAssertions, localDateAt } from "@/memory/chat-assertion";
import { embedMemoryQueries } from "@/memory/embedding-client";
import { createMemoryExploreToolset } from "@/memory/explore-toolset";
import { inspectObjectIdentity } from "@/memory/object-management-service";
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
vi.mock("@/memory/object-management-service", () => ({
  inspectObjectIdentity: vi.fn(),
}));

const compilationId = "00000000-0000-4000-8000-000000000010";
const objectId = "00000000-0000-4000-8000-000000000020";
const associationRef = "association";
const presidentRef = "new-president";
const emptyCaptureResult = {
  publishedAssertions: 0,
  publishedAssertionIds: [],
  affectedObjectIds: [],
  affectedObjects: [],
};

function existingAssociationBinding() {
  return {
    ref: associationRef,
    resolution: "existing" as const,
    globalObjectId: objectId,
  };
}

function newPresidentBinding(canonicalName = "雷岳鑫") {
  return {
    ref: presidentRef,
    resolution: "create" as const,
    canonicalName,
    surfaceForms: [canonicalName],
  };
}

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
    memoryGlobalObject: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(),
    },
    memoryActor: { upsert: vi.fn() },
    memoryChatEvidence: {
      upsert: vi.fn()
        .mockResolvedValueOnce({ id: "00000000-0000-4000-8000-000000000031" })
        .mockResolvedValueOnce({ id: "00000000-0000-4000-8000-000000000032" }),
    },
    memoryChatAssertionCapture: { create: vi.fn() },
    memoryChatObjectMention: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn() },
    memoryGlobalObjectSurfaceMembership: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    memoryObjectChangeProposal: { create: vi.fn() },
    memoryAssertionChatEvidenceLink: { createMany: vi.fn() },
    memoryAssertionObjectLink: { createMany: vi.fn() },
    memoryAssertionObjectOccurrence: { createMany: vi.fn() },
    memoryAssertionEmbeddingIndex: { update: vi.fn() },
    $queryRaw: vi.fn(),
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
    authUser: { findUnique: vi.fn().mockResolvedValue(null) },
    memoryGlobalObject: { findMany: vi.fn().mockResolvedValue([]) },
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

function extractionResult(output: unknown) {
  return {
    toolCalls: [{
      toolName: "submitChatAssertionExtraction",
      input: output,
    }],
  } as never;
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
    vi.mocked(generateText).mockResolvedValue(extractionResult({
      objects: [],
      assertions: [],
    }));

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toEqual(emptyCaptureResult);

    expect(createMemoryExploreToolset).toHaveBeenCalledWith(expect.objectContaining({
      resultTokenBudget: 32_000,
    }));
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.objectContaining({
        inspectObjectIdentity: expect.any(Object),
        submitChatAssertionExtraction: expect.any(Object),
      }),
      toolChoice: "required",
      prompt: expect.stringContaining("完整模型输入"),
    }));
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain("initialRetrieval");
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain("采用最小规范化");
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      "不得改变谓词、事实强度、因果、范围、确定程度、时态或状态类型",
    );
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      "转述来源属于事实强度",
    );
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      "这类上下文不需要伪装成事实 Evidence",
    );
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      "最多进行一次身份检索",
    );
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      "语义相似但身份依据不同的其他 Object 不能视为同一 Object",
    );
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      "不能因为存在‘可能’就提交空结果",
    );
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      "只有‘如果/假设/要是……’等条件推演",
    );
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain(
      "当前确认句和包含完整事实的历史 user 原话",
    );

    const prepareStep = vi.mocked(generateText).mock.calls[0][0].prepareStep!;
    expect(prepareStep({ stepNumber: 0 } as never)).toEqual({});
    expect(prepareStep({ stepNumber: 1 } as never)).toEqual({
      activeTools: ["submitChatAssertionExtraction"],
      toolChoice: {
        type: "tool",
        toolName: "submitChatAssertionExtraction",
      },
    });
  });

  it("injects the authenticated actor Object so self-reference does not require a literal name", async () => {
    const { database } = mockDatabase();
    const actorObjectId = "00000000-0000-4000-8000-000000000099";
    database.authUser.findUnique.mockResolvedValue({
      actorObject: {
        id: actorObjectId,
        compilationId,
        globalObjectKey: "actor:current-user",
        canonicalName: "当前 Actor",
      },
    });
    const captureInput = input();
    captureInput.semanticContext.conversation[2].text = "我与示例对象建立了新的关系。";
    vi.mocked(generateText).mockResolvedValue(extractionResult({
      objects: [],
      assertions: [],
    }));

    await expect(captureChatAssertions(captureInput, mockTrace()))
      .resolves.toEqual(emptyCaptureResult);

    const prompt = vi.mocked(generateText).mock.calls[0][0].prompt;
    expect(prompt).toContain("conversationActorObject");
    expect(prompt).toContain(actorObjectId);
    expect(prompt).toContain("用户对自身的指称");
    expect(prompt).toContain("不要为说话者的代词或泛称创建新 Object");
    expect(prompt).toContain('"ref":"USER"');
    expect(prompt).toContain("所有引用关系都会自然成为 Object–Assertion 连接");
    expect(prompt).not.toContain("higherMemoryObjectRefs");
  });

  it("returns stable published IDs on a foreground retry without writing twice", async () => {
    const { database } = mockDatabase();
    const assertionId = "00000000-0000-4000-8000-000000000060";
    const personId = "00000000-0000-4000-8000-000000000061";
    database.memoryChatAssertionCapture.findFirst.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000062",
      assertions: [{
        id: assertionId,
        objectLinks: [{
          globalObject: { id: personId, canonicalName: "雷岳鑫" },
        }],
      }],
    });

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toEqual({
      publishedAssertions: 1,
      publishedAssertionIds: [assertionId],
      affectedObjectIds: [personId],
      affectedObjects: [{
        id: personId,
        canonicalName: "雷岳鑫",
        resolution: "existing",
      }],
    });

    expect(generateText).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("uses historical conversation to resolve the Object without persisting it as Evidence", async () => {
    const { database, transaction } = mockDatabase();
    vi.mocked(generateText).mockResolvedValue(extractionResult({
        objects: [existingAssociationBinding()],
        assertions: [{
          globalStatementTemplateMarkdown:
            `{{object:${associationRef}}}在2025-2026学年变成4星社团。`,
          objectRefs: [associationRef],
          evidence: [{ messageId: "user-current", quotes: ["25-26学年变成4星社团"] }],
        }],
    }));
    vi.mocked(embedMemoryQueries).mockResolvedValue({
      model: "BAAI/bge-m3",
      modelRevision: "test",
      dimension: 1024,
      vectors: [Array.from({ length: 1024 }, () => 0.1)],
    });

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toEqual(expect.objectContaining({
      publishedAssertions: 1,
      affectedObjectIds: [objectId],
      affectedObjects: [{
        id: objectId,
        canonicalName: "中国科学技术大学学生乒乓球协会",
        resolution: "existing",
      }],
    }));

    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.memoryChatEvidence.upsert).toHaveBeenCalledTimes(1);
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
      data: [expect.objectContaining({
        evidenceQuotes: ["25-26学年变成4星社团"],
        ordinal: 0,
      })],
    });
  });

  it("reviews and repairs a historical fact that omitted the current confirmation Evidence", async () => {
    const { transaction } = mockDatabase();
    const captureInput = input();
    captureInput.semanticContext.conversation[0].text = "乒协由雷岳鑫负责。";
    captureInput.semanticContext.conversation[2].text = "刚才说的负责人安排保持不变。";
    vi.mocked(generateText)
      .mockResolvedValueOnce(extractionResult({
        objects: [existingAssociationBinding()],
        assertions: [{
          globalStatementTemplateMarkdown: `{{object:${associationRef}}}由雷岳鑫负责。`,
          objectRefs: [associationRef],
          evidence: [{ messageId: "user-context", quotes: ["乒协由雷岳鑫负责"] }],
        }],
      }))
      .mockResolvedValueOnce(extractionResult({
        objects: [existingAssociationBinding()],
        assertions: [{
          globalStatementTemplateMarkdown: `{{object:${associationRef}}}由雷岳鑫负责。`,
          objectRefs: [associationRef],
          evidence: [
            { messageId: "user-context", quotes: ["乒协由雷岳鑫负责"] },
            { messageId: "user-current", quotes: ["刚才说的负责人安排保持不变"] },
          ],
        }],
      }));
    vi.mocked(embedMemoryQueries).mockResolvedValue({
      model: "BAAI/bge-m3",
      modelRevision: "test",
      dimension: 1024,
      vectors: [Array.from({ length: 1024 }, () => 0.1)],
    });

    await expect(captureChatAssertions(captureInput, mockTrace())).resolves.toEqual(
      expect.objectContaining({ publishedAssertions: 1 }),
    );
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateText).mock.calls[1][0].prompt).toContain(
      "没有把当前排队用户消息列为 Evidence",
    );
    expect(transaction.memoryAssertionChatEvidenceLink.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ ordinal: 0 }),
        expect.objectContaining({ ordinal: 1 }),
      ]),
    });
  });

  it("accepts an empty extraction without a lexical case-specific retry", async () => {
    const { database } = mockDatabase();
    const captureInput = input();
    captureInput.semanticContext.conversation[2].text =
      "乒协报名截止时间确定为2026年8月28日。";
    vi.mocked(generateText).mockResolvedValue(extractionResult({ objects: [], assertions: [] }));

    await expect(captureChatAssertions(captureInput, mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("reviews an unsupported existing identity and still rejects it when unrepaired", async () => {
    const { database } = mockDatabase();
    const captureInput = input();
    captureInput.semanticContext.conversation[0].text = "我说的是另一个活动。";
    captureInput.semanticContext.conversation[2].text =
      "Echo人工验收赛-C6确定在2026年8月31日举行。";
    vi.mocked(generateText).mockResolvedValue(extractionResult({
      objects: [existingAssociationBinding()],
      assertions: [{
        globalStatementTemplateMarkdown:
          `{{object:${associationRef}}}确定在2026年8月31日举行。`,
        objectRefs: [associationRef],
        evidence: [{
          messageId: "user-current",
          quotes: ["Echo人工验收赛-C6确定在2026年8月31日举行"],
        }],
      }],
    }));

    await expect(captureChatAssertions(captureInput, mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateText).mock.calls[1][0].prompt).toContain(
      "名称或可信 Surface 没有出现在任何 user 原话中",
    );
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("repairs one unambiguous literal Object in a correction template", async () => {
    const { transaction } = mockDatabase();
    const trace = mockTrace();
    const captureInput = input();
    const eventName = "“继往开来”乒乓球赛";
    captureInput.semanticContext.conversation[0].text =
      "我听说继往开来比赛可能会在2026年调整，但目前尚未确认，也没有收到正式通知。";
    captureInput.semanticContext.conversation[2].text =
      "刚才关于“继往开来比赛可能会在2026年调整”的信息只是系统测试样例，并非我掌握的真实组织消息。请记录这项纠正，不要再把原信息作为真实业务事实使用；保留历史来源，不要静默覆盖原记录。";
    captureInput.retrieval.seedMap.objects[0].canonicalName = eventName;
    captureInput.retrieval.seedMap.objects[0].surfaceForms = [
      eventName,
      "继往开来",
      "继往开来比赛",
    ];
    vi.mocked(generateText).mockResolvedValue(extractionResult({
      objects: [existingAssociationBinding()],
      assertions: [{
        globalStatementTemplateMarkdown:
          "据用户转述，此前关于“继往开来”乒乓球赛可能会在2026年调整的信息只是系统测试样例，并非用户掌握的真实组织消息。",
        objectRefs: [associationRef],
        evidence: [{
          messageId: "user-current",
          quotes: [
            "刚才关于“继往开来比赛可能会在2026年调整”的信息只是系统测试样例，并非我掌握的真实组织消息。",
          ],
        }],
      }],
    }));
    vi.mocked(embedMemoryQueries).mockResolvedValue({
      model: "BAAI/bge-m3",
      modelRevision: "test",
      dimension: 1024,
      vectors: [Array.from({ length: 1024 }, () => 0.1)],
    });

    await expect(captureChatAssertions(captureInput, trace)).resolves.toEqual(
      expect.objectContaining({
        publishedAssertions: 1,
        affectedObjectIds: [objectId],
      }),
    );
    expect(transaction.memoryAssertion.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        statementTemplateMarkdown:
          "据用户转述，此前关于“继往开来”乒乓球赛可能会在2026年调整的信息只是系统测试样例，并非用户掌握的真实组织消息。",
        globalStatementTemplateMarkdown:
          `据用户转述，此前关于{{object:${objectId}}}可能会在2026年调整的信息只是系统测试样例，并非用户掌握的真实组织消息。`,
      })],
    });
    expect(trace.appendSection).toHaveBeenCalledWith(
      "Assertion 候选校验",
      expect.stringContaining("自动补全 Object 占位符：1 条"),
    );
  });

  it("does not guess when an Object literal appears more than once", async () => {
    const { database, transaction } = mockDatabase();
    vi.mocked(generateText).mockResolvedValue(extractionResult({
      objects: [existingAssociationBinding()],
      assertions: [{
        globalStatementTemplateMarkdown:
          "中国科学技术大学学生乒乓球协会是社团；中国科学技术大学学生乒乓球协会需要换届。",
        objectRefs: [associationRef],
        evidence: [{
          messageId: "user-current",
          quotes: ["25-26学年变成4星社团"],
        }],
      }],
    }));

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(transaction.memoryAssertion.createMany).not.toHaveBeenCalled();
  });

  it("rejects an assertion that omits the current user message or uses assistant text", async () => {
    const { database, transaction } = mockDatabase();
    vi.mocked(generateText).mockResolvedValue(extractionResult({
        objects: [existingAssociationBinding()],
        assertions: [{
          globalStatementTemplateMarkdown: `{{object:${associationRef}}}目前是三星社团。`,
          objectRefs: [associationRef],
          evidence: [{ messageId: "assistant-context", quotes: ["目前记录是三星"] }],
        }],
    }));

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(transaction.memoryChatEvidence.upsert).not.toHaveBeenCalled();
  });

  it("rejects an Object whose subject appears only in assistant/context interpretation", async () => {
    const { database, transaction } = mockDatabase();
    const captureInput = input();
    captureInput.semanticContext.conversation[0].text = "我说的是刚才那个社团。";
    vi.mocked(generateText).mockResolvedValue(extractionResult({
        objects: [existingAssociationBinding()],
        assertions: [{
          globalStatementTemplateMarkdown:
            `{{object:${associationRef}}}在2025-2026学年是四星社团。`,
          objectRefs: [associationRef],
          evidence: [{
            messageId: "user-current",
            quotes: ["25-26学年变成4星社团"],
          }],
        }],
    }));

    await expect(captureChatAssertions(captureInput, mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(transaction.memoryChatEvidence.upsert).not.toHaveBeenCalled();
  });

  it("rejects a template that repeats the Object name outside its placeholder", async () => {
    const { database, transaction } = mockDatabase();
    vi.mocked(generateText).mockResolvedValue(extractionResult({
        objects: [existingAssociationBinding()],
        assertions: [{
          globalStatementTemplateMarkdown:
            `中国科学技术大学学生乒乓球协会（{{object:${associationRef}}}）在2025-2026学年是四星社团。`,
          objectRefs: [associationRef],
          evidence: [
            { messageId: "user-context", quotes: ["乒协"] },
            { messageId: "user-current", quotes: ["25-26学年变成4星社团"] },
          ],
        }],
    }));

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(transaction.memoryChatEvidence.upsert).not.toHaveBeenCalled();
  });

  it("atomically creates a new Object used by a relayed Assertion and preserves its literal Evidence name", async () => {
    const { transaction } = mockDatabase();
    const captureInput = input();
    captureInput.semanticContext.conversation[2].text =
      "我问了一下魏汉东，他说26-27会长是雷岳鑫";
    vi.mocked(generateText).mockResolvedValue(extractionResult({
        objects: [existingAssociationBinding(), newPresidentBinding()],
        assertions: [{
          globalStatementTemplateMarkdown:
            `魏汉东说{{object:${associationRef}}}2026-2027学年会长是{{object:${presidentRef}}}。`,
          objectRefs: [associationRef, presidentRef],
          evidence: [{
            messageId: "user-current",
            quotes: ["我问了一下魏汉东，他说26-27会长是雷岳鑫"],
          }],
        }],
    }));
    vi.mocked(embedMemoryQueries).mockResolvedValue({
      model: "BAAI/bge-m3",
      modelRevision: "test",
      dimension: 1024,
      vectors: [Array.from({ length: 1024 }, () => 0.1)],
    });

    const result = await captureChatAssertions(captureInput, mockTrace());
    expect(result.publishedAssertions).toBe(1);
    expect(result.affectedObjectIds).toHaveLength(2);
    expect(result.affectedObjectIds).toContain(objectId);

    const createdObject = transaction.memoryGlobalObject.createMany.mock.calls[0][0].data[0];
    expect(createdObject).toMatchObject({
      compilationId,
      canonicalName: "雷岳鑫",
      globalObjectKey: expect.stringMatching(/^chat-object:/),
    });
    expect(result.affectedObjectIds).toContain(createdObject.id);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.memoryChatObjectMention.createMany).toHaveBeenCalledWith({
      data: [{
        globalObjectId: createdObject.id,
        chatEvidenceId: "00000000-0000-4000-8000-000000000031",
        ordinal: 0,
        surfaceForm: "雷岳鑫",
        normalizedSurfaceForm: "雷岳鑫",
      }],
    });
    expect(transaction.memoryAssertion.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        statementTemplateMarkdown:
          "魏汉东说中国科学技术大学学生乒乓球协会2026-2027学年会长是雷岳鑫。",
        globalStatementTemplateMarkdown:
          `魏汉东说{{object:${objectId}}}2026-2027学年会长是{{object:${createdObject.id}}}。`,
      })],
    });
    expect(transaction.memoryAssertionObjectLink.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { assertionId: expect.any(String), globalObjectId: objectId },
        { assertionId: expect.any(String), globalObjectId: createdObject.id },
      ]),
    });
    expect(transaction.memoryAssertionObjectOccurrence.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ globalObjectId: objectId, ordinal: 0 }),
        expect.objectContaining({ globalObjectId: createdObject.id, ordinal: 1 }),
      ],
    });
    expect(transaction.memoryChatEvidence.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects Object creation when its literal name already matches an existing Object", async () => {
    const { database, transaction } = mockDatabase();
    database.memoryGlobalObject.findMany.mockResolvedValue([{
      id: "00000000-0000-4000-8000-000000000040",
      canonicalName: "雷岳鑫",
      surfaceMemberships: [],
      chatMentions: [],
    }]);
    const captureInput = input();
    captureInput.semanticContext.conversation[2].text =
      "我问了一下魏汉东，他说26-27会长是雷岳鑫";
    vi.mocked(generateText).mockResolvedValue(extractionResult({
        objects: [existingAssociationBinding(), newPresidentBinding()],
        assertions: [{
          globalStatementTemplateMarkdown:
            `魏汉东说{{object:${associationRef}}}2026-2027学年会长是{{object:${presidentRef}}}。`,
          objectRefs: [associationRef, presidentRef],
          evidence: [{
            messageId: "user-current",
            quotes: ["我问了一下魏汉东，他说26-27会长是雷岳鑫"],
          }],
        }],
    }));

    await expect(captureChatAssertions(captureInput, mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(transaction.memoryGlobalObject.createMany).not.toHaveBeenCalled();
    expect(embedMemoryQueries).not.toHaveBeenCalled();
  });

  it("does not reject a specific role merely because it contains an existing generic surface form", async () => {
    const { database, transaction } = mockDatabase();
    database.memoryGlobalObject.findMany.mockResolvedValue([{
      id: "00000000-0000-4000-8000-000000000042",
      canonicalName: "参考对象",
      surfaceMemberships: [{
        surfaceFormOrdinal: 1,
        objectFragment: { surfaceForms: ["参考对象", "对象"] },
      }],
      chatMentions: [],
    }]);
    const captureInput = input();
    captureInput.semanticContext.conversation[2].text =
      "乒协2026-2027学年设置器材负责人岗位。";
    vi.mocked(generateText).mockResolvedValue(extractionResult({
        objects: [{
          ref: presidentRef,
          resolution: "create",
          canonicalName: "器材负责人",
          surfaceForms: ["器材负责人"],
        }],
        assertions: [{
          globalStatementTemplateMarkdown:
            `乒协2026-2027学年设置{{object:${presidentRef}}}岗位。`,
          objectRefs: [presidentRef],
          evidence: [{
            messageId: "user-current",
            quotes: ["乒协2026-2027学年设置器材负责人岗位。"],
          }],
        }],
    }));
    vi.mocked(embedMemoryQueries).mockResolvedValue({
      model: "BAAI/bge-m3",
      modelRevision: "test",
      dimension: 1024,
      vectors: [Array.from({ length: 1024 }, () => 0.1)],
    });

    const result = await captureChatAssertions(captureInput, mockTrace());

    expect(result.publishedAssertions).toBe(1);
    expect(transaction.memoryGlobalObject.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ canonicalName: "器材负责人" })],
    });
  });

  it("atomically detaches an inspected generic Surface while publishing the new Object", async () => {
    const { database, transaction } = mockDatabase();
    const pollutedFragmentId = "00000000-0000-4000-8000-000000000044";
    database.memoryGlobalObject.findMany.mockResolvedValue([{
      id: objectId,
      canonicalName: "项目负责人",
      surfaceMemberships: [{
        surfaceFormOrdinal: 1,
        objectFragment: { surfaceForms: ["项目负责人", "负责人"] },
      }],
      chatMentions: [],
    }]);
    vi.mocked(inspectObjectIdentity).mockResolvedValue({
      compilationId,
      object: {
        id: objectId,
        canonicalName: "参考对象",
      },
      surfaces: [{
        id: `document:${pollutedFragmentId}:1`,
        kind: "document",
        surfaceForm: "对象",
        source: "文档 · 测试",
      }],
      references: [],
      dependencies: { higherMemory: false, relatedViewCards: [] },
    });
    const captureInput = input();
    captureInput.semanticContext.conversation[2].text =
      "对象甲已经建立。";
    vi.mocked(generateText).mockImplementation(async (options) => {
      const inspectTool = (options.tools as unknown as {
        inspectObjectIdentity: {
          execute: (input: { objectId: string }) => Promise<unknown>;
        };
      }).inspectObjectIdentity;
      await inspectTool.execute({ objectId });
      return extractionResult({
          objects: [{
            ref: presidentRef,
            resolution: "create",
            canonicalName: "对象甲",
            surfaceForms: ["对象甲"],
          }],
          surfaceCorrections: [{
            objectId,
            surfaceId: `document:${pollutedFragmentId}:1`,
            surfaceForm: "对象",
            reason: "泛称不能独立指向参考对象。",
          }],
          assertions: [{
            globalStatementTemplateMarkdown:
              `{{object:${presidentRef}}}已经建立。`,
            objectRefs: [presidentRef],
            evidence: [{
              messageId: "user-current",
              quotes: ["对象甲已经建立。"],
            }],
          }],
      });
    });
    vi.mocked(embedMemoryQueries).mockResolvedValue({
      model: "BAAI/bge-m3",
      modelRevision: "test",
      dimension: 1024,
      vectors: [Array.from({ length: 1024 }, () => 0.1)],
    });

    const result = await captureChatAssertions(captureInput, mockTrace());

    expect(result.publishedAssertions).toBe(1);
    expect(transaction.memoryGlobalObjectSurfaceMembership.deleteMany).toHaveBeenCalledWith({
      where: {
        globalObjectId: objectId,
        objectFragmentId: pollutedFragmentId,
        surfaceFormOrdinal: 1,
      },
    });
    expect(transaction.memoryGlobalObject.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ canonicalName: "对象甲" })],
    });
    expect(transaction.memoryObjectChangeProposal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "applied",
        payload: expect.objectContaining({
          changes: [{
            type: "REMOVE_SURFACE",
            objectId,
            surfaceId: `document:${pollutedFragmentId}:1`,
          }],
        }),
      }),
    });
  });

  it("still rejects creation when a canonical name exactly matches a real existing alias", async () => {
    const { database, transaction } = mockDatabase();
    database.memoryGlobalObject.findMany.mockResolvedValue([{
      id: "00000000-0000-4000-8000-000000000043",
      canonicalName: "中国科学技术大学",
      surfaceMemberships: [{
        surfaceFormOrdinal: 2,
        objectFragment: { surfaceForms: ["中国科学技术大学", "中国科大", "中科大"] },
      }],
      chatMentions: [],
    }]);
    const captureInput = input();
    captureInput.semanticContext.conversation[2].text = "中科大设有学生社团。";
    vi.mocked(generateText).mockResolvedValue(extractionResult({
        objects: [{
          ref: presidentRef,
          resolution: "create",
          canonicalName: "中科大",
          surfaceForms: ["中科大"],
        }],
        assertions: [{
          globalStatementTemplateMarkdown: `{{object:${presidentRef}}}设有学生社团。`,
          objectRefs: [presidentRef],
          evidence: [{ messageId: "user-current", quotes: ["中科大设有学生社团。"] }],
        }],
    }));

    await expect(captureChatAssertions(captureInput, mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(transaction.memoryGlobalObject.createMany).not.toHaveBeenCalled();
    expect(embedMemoryQueries).not.toHaveBeenCalled();
  });

  it("rolls back cleanly when a concurrent chat creates a conflicting Object before publication", async () => {
    const { database, transaction } = mockDatabase();
    transaction.memoryGlobalObject.findMany.mockResolvedValue([{
      id: "00000000-0000-4000-8000-000000000041",
      canonicalName: "雷岳鑫",
      surfaceMemberships: [],
      chatMentions: [],
    }]);
    const captureInput = input();
    captureInput.semanticContext.conversation[2].text =
      "我问了一下魏汉东，他说26-27会长是雷岳鑫";
    vi.mocked(generateText).mockResolvedValue(extractionResult({
        objects: [existingAssociationBinding(), newPresidentBinding()],
        assertions: [{
          globalStatementTemplateMarkdown:
            `魏汉东说{{object:${associationRef}}}2026-2027学年会长是{{object:${presidentRef}}}。`,
          objectRefs: [associationRef, presidentRef],
          evidence: [{
            messageId: "user-current",
            quotes: ["我问了一下魏汉东，他说26-27会长是雷岳鑫"],
          }],
        }],
    }));
    vi.mocked(embedMemoryQueries).mockResolvedValue({
      model: "BAAI/bge-m3",
      modelRevision: "test",
      dimension: 1024,
      vectors: [Array.from({ length: 1024 }, () => 0.1)],
    });

    await expect(captureChatAssertions(captureInput, mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.memoryChatAssertionCapture.create).not.toHaveBeenCalled();
    expect(transaction.memoryGlobalObject.createMany).not.toHaveBeenCalled();
    expect(transaction.memoryAssertion.createMany).not.toHaveBeenCalled();
  });

  it("rejects generic Object names and never leaves an orphan Object", async () => {
    const { database, transaction } = mockDatabase();
    const captureInput = input();
    captureInput.semanticContext.conversation[2].text = "乒协的新会长是会长";
    vi.mocked(generateText).mockResolvedValue(extractionResult({
        objects: [existingAssociationBinding(), newPresidentBinding("会长")],
        assertions: [{
          globalStatementTemplateMarkdown:
            `{{object:${associationRef}}}的新会长是{{object:${presidentRef}}}。`,
          objectRefs: [associationRef, presidentRef],
          evidence: [{ messageId: "user-current", quotes: ["乒协的新会长是会长"] }],
        }],
    }));

    await expect(captureChatAssertions(captureInput, mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(transaction.memoryGlobalObject.createMany).not.toHaveBeenCalled();
  });

  it("does not persist an unused create proposal when the extractor publishes no Assertion", async () => {
    const { database, transaction } = mockDatabase();
    vi.mocked(generateText).mockResolvedValue(extractionResult({
      objects: [newPresidentBinding()],
      assertions: [],
    }));

    await expect(captureChatAssertions(input(), mockTrace())).resolves.toEqual(emptyCaptureResult);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(transaction.memoryGlobalObject.createMany).not.toHaveBeenCalled();
  });
});
