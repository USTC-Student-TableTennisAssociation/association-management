import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatPageContext } from "@/ai/types";
import type { MemoryRetrievalResult } from "@/memory/types";
import type { SemanticViewState } from "@/semantic-view/types";

const providerState = vi.hoisted(() => ({ model: undefined as unknown }));
const authState = vi.hoisted(() => ({ current: vi.fn() }));
const retrieverState = vi.hoisted(() => ({ retrieve: vi.fn() }));
const proposalState = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn() }));
const sourceDocumentState = vi.hoisted(() => ({ read: vi.fn() }));
const assertionCaptureState = vi.hoisted(() => ({ capture: vi.fn() }));
const chatPersistenceState = vi.hoisted(() => ({ save: vi.fn() }));
const ambientMemoryState = vi.hoisted(() => ({ load: vi.fn() }));
const assertionReceiptState = vi.hoisted(() => ({
  list: vi.fn(),
  queue: vi.fn(),
  running: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));
const databaseState = vi.hoisted(() => ({
  memoryGlobalObjectFindMany: vi.fn(),
  viewHigherMemoryFindUnique: vi.fn(),
  memoryAssertionFindMany: vi.fn(),
  libraryNodeFindMany: vi.fn(),
}));

vi.mock("@/ai/provider", () => ({ getChatModel: () => providerState.model }));
vi.mock("@/auth/session", () => ({ currentAuthUser: authState.current }));
vi.mock("@/chat/persistence", () => ({ saveChatMessage: chatPersistenceState.save }));
vi.mock("@/db", () => ({
  getDatabase: () => ({
    memoryGlobalObject: { findMany: databaseState.memoryGlobalObjectFindMany },
    semanticViewHigherMemory: { findUnique: databaseState.viewHigherMemoryFindUnique },
    memoryAssertion: { findMany: databaseState.memoryAssertionFindMany },
    libraryNode: { findMany: databaseState.libraryNodeFindMany },
  }),
}));
vi.mock("@/memory/retriever", () => ({
  getMemoryRetriever: () => ({ mode: "fixture" as const, retrieve: retrieverState.retrieve }),
}));
vi.mock("@/memory/chat-assertion", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/memory/chat-assertion")>();
  return { ...original, captureChatAssertions: assertionCaptureState.capture };
});
vi.mock("@/memory/chat-assertion-receipt", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/memory/chat-assertion-receipt")>();
  return {
    ...original,
    listChatAssertionReceipts: assertionReceiptState.list,
    queueChatAssertionReceipt: assertionReceiptState.queue,
    markChatAssertionReceiptRunning: assertionReceiptState.running,
    completeChatAssertionReceipt: assertionReceiptState.complete,
    failChatAssertionReceipt: assertionReceiptState.fail,
  };
});
vi.mock("@/memory/ambient-higher-memory", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/memory/ambient-higher-memory")>();
  return { ...original, loadAmbientHigherMemories: ambientMemoryState.load };
});
vi.mock("@/memory/source-document", () => ({
  readSourceDocumentSelection: sourceDocumentState.read,
  sourceDocumentLimits: {
    defaultCharacters: 48_000,
    minCharacters: 2_000,
    maxCharacters: 120_000,
    maxContextBlocks: 200,
  },
}));
vi.mock("@/semantic-view/service", () => ({
  createViewProposal: proposalState.create,
  getSemanticView: proposalState.read,
  supportedCardTypeSummary: () => [],
  SemanticViewValidationError: class SemanticViewValidationError extends Error {},
}));

import { POST } from "@/app/api/chat/route";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function answerStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: text },
        { type: "text-end" as const, id: "answer" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
    }),
  };
}

function toolStep(toolName: string, input: unknown, id = toolName) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: `call-${id}`,
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function searchStep() {
  return toolStep("searchMemory", { query: "场地申请要求", targetHints: ["场地申请"] });
}

function openBusinessStep(viewKey: "society_information" | "activity_operations") {
  return toolStep("openBusinessContext", {
    viewKey,
    focus: "当前对象的正式状态",
    targetHints: ["这个对象"],
  });
}

function openArtifactsStep(title: string) {
  return toolStep("openArtifacts", { title });
}

function fixtureRetrieval(): MemoryRetrievalResult {
  return {
    query: "场地申请要求",
    mode: "fixture",
    compilationId: "00000000-0000-4000-8000-000000000020",
    seedMap: {
      facets: [{ id: "facet-0", text: "场地申请", source: "query" }],
      objects: [{
        ref: "O1",
        id: "00000000-0000-4000-8000-000000000001",
        globalObjectKey: "venue-application",
        canonicalName: "校内场地申请",
        surfaceForms: ["场地申请"],
        matchedBy: [],
        matchedFacets: ["facet-0"],
        supportingAssertions: ["A1"],
        lexicalMatch: true,
        semanticMatch: true,
      }],
      assertions: [{
        ref: "A1",
        id: "00000000-0000-4000-8000-000000000011",
        kind: "grounded",
        dereferenceRequired: false,
        sourceNodeId: "fixture-region",
        sourceClaimId: "fixture-claim",
        renderedStatement: "校内体育馆申请需要提前提交材料。",
        contextDependent: false,
        matchedBy: [],
        matchedFacets: ["facet-0"],
        sources: [{
          sourceTitle: "生存手册",
          sourceSha256: "fixture",
          sourceNodeId: "fixture-region",
          sourceRegionLabel: "场地申请",
          sourceBlockId: "fixture-block-1",
          ordinal: 0,
          pages: [8],
        }],
      }],
      connections: [{ assertionRef: "A1", objectRef: "O1" }],
    },
  };
}

function fixtureView(viewKey: "society_information" | "activity_operations"): SemanticViewState {
  const activity = viewKey === "activity_operations";
  return {
    viewKey,
    viewLabel: activity ? "Activity Operations" : "社团信息",
    viewDescription: "正式状态",
    compilationId: "00000000-0000-4000-8000-000000000090",
    compatible: true,
    cardTypes: [{
      key: activity ? "GuideNodeCard" : "SocietyCard",
      label: activity ? "指南节点" : "社团",
      meaning: "正式业务对象",
      seedContentDimensions: ["说明"],
      slots: [],
    }],
    cards: [{
      id: activity
        ? "00000000-0000-4000-8000-000000000093"
        : "00000000-0000-4000-8000-000000000091",
      viewKey,
      cardTypeKey: activity ? "GuideNodeCard" : "SocietyCard",
      cardTypeLabel: activity ? "指南节点" : "社团",
      objectName: activity ? "校内场地申请操作指南" : "测试社团",
      seedContentDimensions: ["说明"],
      contentDimensions: [{
        id: "00000000-0000-4000-8000-000000000094",
        name: "说明",
        contentMarkdown: activity ? "按行政要求准备材料。" : "四星社团。",
      }],
      slots: [],
    }],
  };
}

function emptyFixtureView(
  viewKey: "society_information" | "activity_operations",
): SemanticViewState {
  return { ...fixtureView(viewKey), cards: [] };
}

function chatRequest(text: string, pageContext?: ChatPageContext): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: "00000000-0000-4000-8000-000000000081",
      ...(pageContext ? { pageContext } : {}),
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text }] }],
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.current.mockResolvedValue({
    userId: "00000000-0000-4000-8000-000000000070",
    loginName: "开发用户",
    role: "ADMIN",
    actor: { id: "00000000-0000-4000-8000-000000000001", displayName: "开发用户" },
    personObject: {
      id: "00000000-0000-4000-8000-000000000071",
      canonicalName: "开发用户",
      personCardId: "00000000-0000-4000-8000-000000000072",
    },
  });
  chatPersistenceState.save.mockResolvedValue(undefined);
  ambientMemoryState.load.mockResolvedValue([]);
  assertionReceiptState.list.mockResolvedValue([]);
  assertionReceiptState.queue.mockResolvedValue(undefined);
  assertionReceiptState.running.mockResolvedValue(undefined);
  assertionReceiptState.complete.mockResolvedValue(undefined);
  assertionReceiptState.fail.mockResolvedValue(undefined);
  retrieverState.retrieve.mockResolvedValue(fixtureRetrieval());
  proposalState.read.mockImplementation(async (viewKey) => fixtureView(viewKey));
  databaseState.memoryGlobalObjectFindMany.mockResolvedValue([]);
  databaseState.viewHigherMemoryFindUnique.mockResolvedValue(null);
  databaseState.memoryAssertionFindMany.mockResolvedValue([]);
  databaseState.libraryNodeFindMany.mockResolvedValue([]);
  sourceDocumentState.read.mockResolvedValue({
    document: {
      id: "00000000-0000-4000-8000-000000000020",
      title: "生存手册",
      sha256: "fixture",
      parser: "mineru",
      pageCount: 10,
      blockCount: 1,
    },
    selection: { mode: "full", label: "完整原文", startOrder: 0, endOrder: 0 },
    blocks: [{
      sourceBlockId: "fixture-block-1",
      order: 0,
      blockType: "text",
      headingLevel: null,
      headingPath: ["场地申请"],
      pages: [8],
      markdown: "原文给出了体育馆申请的行政要求。",
    }],
    requestedMaxCharacters: 120_000,
    returnedCharacters: 20,
    isFullDocument: true,
    isCompleteSelection: true,
  });
  assertionCaptureState.capture.mockResolvedValue({
    publishedAssertions: 1,
    publishedAssertionIds: ["00000000-0000-4000-8000-000000000051"],
    affectedObjectIds: ["00000000-0000-4000-8000-000000000052"],
    higherMemoryObjectIds: [],
    affectedObjects: [{
      id: "00000000-0000-4000-8000-000000000052",
      canonicalName: "雷岳鑫",
      resolution: "created",
    }],
  });
  proposalState.create.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000099",
    viewKey: "society_information",
    status: "pending",
    reason: "用户明确要求修改。",
    createdAt: "2026-08-18T00:00:00.000Z",
    changes: [],
  });
});

describe("POST /api/chat Explore", () => {
  it("exposes focused gateways plus top-level semantic search on the first call", async () => {
    providerState.model = new MockLanguageModelV4({ doStream: [answerStep("改写完成。")] });
    const response = await POST(chatRequest("帮我改写这句话。"));
    await response.text();

    expect(response.status).toBe(200);
    expect(retrieverState.retrieve).not.toHaveBeenCalled();
    expect((providerState.model as MockLanguageModelV4).doStreamCalls[0].tools?.map((tool) => tool.name))
      .toEqual([
        "openBusinessContext",
        "openArtifacts",
        "openActions",
        "searchMemory",
        "readMemoryWriteStatus",
        "submitTurnHandoff",
      ]);
    expect((providerState.model as MockLanguageModelV4).doStreamCalls).toHaveLength(1);
  });

  it("does not start generation when the user message cannot be persisted", async () => {
    chatPersistenceState.save.mockRejectedValueOnce(new Error("database unavailable"));
    const model = new MockLanguageModelV4({ doStream: [answerStep("不应生成")] });
    providerState.model = model;
    const response = await POST(chatRequest("你好"));
    expect(response.status).toBe(503);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("unlocks source reads after a direct Shared Brain search", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        searchStep(),
        toolStep("readSourceDocument", {
          mode: "full",
          assertionRef: "A1",
          maxCharacters: 120_000,
        }),
        answerStep("原文给出了行政要求 [S1]。"),
      ],
    });
    providerState.model = model;
    const response = await POST(chatRequest("查一下场地申请要求，并回读来源。"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(sourceDocumentState.read).toHaveBeenCalledOnce();
    expect(model.doStreamCalls[1].tools?.map((tool) => tool.name)).toContain("readSourceDocument");
    expect(body).toContain('"type":"data-sourceReferences"');
  });

  it("recognizes full-width Assertion citations", async () => {
    const model = new MockLanguageModelV4({
      doStream: [searchStep(), answerStep("资料说明需要提前提交【A1】。")],
    });
    providerState.model = model;
    const response = await POST(chatRequest("场地申请要提前多久？"));
    const body = await response.text();
    expect(body).toContain('"answerUsedAssertionRefs":["A1"]');
  });

  it("uses the active playbook node for deictic questions", async () => {
    const model = new MockLanguageModelV4({
      doStream: [openBusinessStep("activity_operations"), answerStep("当前节点要求准备行政材料 [V3]。")],
    });
    providerState.model = model;
    const response = await POST(chatRequest("这个具体要准备什么？", {
      activeViewKey: "activity_operations",
      activePresentation: "playbook",
      activeCardId: "00000000-0000-4000-8000-000000000093",
      activeNodeId: "00000000-0000-4000-8000-000000000093",
      activeObjectName: "校内场地申请操作指南",
    }));
    const body = await response.text();

    const secondPrompt = JSON.stringify(model.doStreamCalls[1].prompt);
    expect(secondPrompt).toContain("校内场地申请操作指南");
    expect(secondPrompt).toContain("按行政要求准备材料");
    expect(body).toContain('"cardTypes"');
    expect(model.doStreamCalls[1].tools?.map((tool) => tool.name))
      .toContain("readSemanticView");
  });

  it("accepts a valid Handoff from the penultimate step and queues review", async () => {
    const quote = "今年继往开来准备在 10 月 18 日举办";
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep("submitTurnHandoff", { reviewNeeded: true, candidateQuotes: [quote] }),
        answerStep("收到，计划日期是 10 月 18 日。"),
      ],
    });
    providerState.model = model;
    const response = await POST(chatRequest(`${quote}了。`));
    await response.text();

    expect(assertionReceiptState.queue).toHaveBeenCalledWith(expect.objectContaining({
      execution: "background",
      queueReason: expect.stringContaining(quote),
    }));
  });

  it("can finish without an extra model call when answer and Handoff share a step", async () => {
    const quote = "比赛日期确定为 10 月 18 日";
    const model = new MockLanguageModelV4({
      doStream: [{
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "answer-with-handoff" },
            {
              type: "text-delta" as const,
              id: "answer-with-handoff",
              delta: "收到，日期已经明确。",
            },
            { type: "text-end" as const, id: "answer-with-handoff" },
            {
              type: "tool-call" as const,
              toolCallId: "call-final-handoff",
              toolName: "submitTurnHandoff",
              input: JSON.stringify({ reviewNeeded: true, candidateQuotes: [quote] }),
            },
            {
              type: "finish" as const,
              finishReason: { unified: "tool-calls" as const, raw: undefined },
              usage,
            },
          ],
        }),
      }],
    });
    providerState.model = model;
    const response = await POST(chatRequest(`${quote}。`));
    await response.text();

    expect(model.doStreamCalls).toHaveLength(1);
    expect(assertionReceiptState.queue).toHaveBeenCalledOnce();
  });

  it("does not write back when Handoff quotes are invalid", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep("submitTurnHandoff", {
          reviewNeeded: true,
          candidateQuotes: ["用户没有说过的内容"],
        }),
        answerStep("我会继续查找。"),
      ],
    });
    providerState.model = model;
    const response = await POST(chatRequest("请继续查找场地申请资料。"));
    await response.text();
    expect(assertionReceiptState.queue).not.toHaveBeenCalled();
  });

  it("does not treat a missing Handoff as permission to write memory", async () => {
    providerState.model = new MockLanguageModelV4({ doStream: [answerStep("没有查到足够证据。") ] });
    const response = await POST(chatRequest("还有别的资料吗？"));
    await response.text();
    expect(assertionReceiptState.queue).not.toHaveBeenCalled();
  });

  it("opens Business View actions before creating a Proposal", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        openBusinessStep("society_information"),
        toolStep("openActions", { area: "business_view", reason: "用户明确要求修改" }),
        toolStep("proposeViewChange", {
          viewKey: "society_information",
          reason: "用户明确要求修改正式社团星级。",
          changes: [{
            type: "SET_CONTENT_DIMENSION",
            card: "00000000-0000-4000-8000-000000000091",
            name: "说明",
            contentMarkdown: "五星社团",
          }],
        }),
        answerStep("已整理成待批准 Proposal。"),
      ],
    });
    providerState.model = model;
    const response = await POST(chatRequest("把这个社团的说明改成五星社团。"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(proposalState.create).toHaveBeenCalledOnce();
    expect(body).toContain("data-viewProposal");
  });

  it("loads graph-authoring guidance only after Business View actions are opened", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        openBusinessStep("activity_operations"),
        toolStep("openActions", {
          area: "business_view",
          reason: "需要建立建议型流程地图",
        }),
        toolStep("loadSkill", {
          skillKey: "business-view-graph-authoring",
          reason: "任务需要创建包含起点和路径的 Card/Slot 子图",
        }),
        toolStep("proposeViewChange", {
          viewKey: "activity_operations",
          reason: "修复当前操作指南说明。",
          changes: [{
            type: "SET_CONTENT_DIMENSION",
            card: "00000000-0000-4000-8000-000000000093",
            name: "说明",
            contentMarkdown: "按完整子图规划修复。",
          }],
        }),
        answerStep("已根据构图 Skill 形成待批准 Proposal。"),
      ],
    });
    providerState.model = model;
    const response = await POST(chatRequest("把这个操作指南修成一张完整流程图。"));
    await response.text();

    expect(model.doStreamCalls[0].tools?.map((tool) => tool.name))
      .not.toContain("loadSkill");
    expect(model.doStreamCalls[2].tools?.map((tool) => tool.name))
      .toContain("loadSkill");
    const postLoadPrompt = JSON.stringify(model.doStreamCalls[3].prompt);
    expect(postLoadPrompt).toContain("【Skill：Business View 子图构建】");
    expect(postLoadPrompt).toContain("实时 cardTypes 为准");
    expect(proposalState.create).toHaveBeenCalledOnce();
  });

  it("can publish a missing Object before a same-turn View Proposal", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        openBusinessStep("society_information"),
        toolStep("openActions", { area: "business_view", reason: "需要建立人物卡片" }),
        toolStep("queueChatAssertionCapture", {
          reason: "用户明确确认新会长并要求收录进正式档案",
          execution: "foreground_for_view",
        }),
        toolStep("proposeViewChange", {
          viewKey: "society_information",
          reason: "用户要求收录新会长。",
          changes: [{
            type: "CREATE_CARD",
            cardRef: "lei-yuexin",
            sourceObjectId: "00000000-0000-4000-8000-000000000052",
            cardTypeKey: "PersonCard",
          }],
        }),
        answerStep("已整理成人物档案 Proposal。"),
      ],
    });
    providerState.model = model;
    const response = await POST(chatRequest("雷岳鑫确实是会长，你可以收录进档案。"));
    await response.text();

    expect(assertionCaptureState.capture).toHaveBeenCalledOnce();
    expect(proposalState.create).toHaveBeenCalledWith(expect.objectContaining({
      allowedObjectIds: new Set(["00000000-0000-4000-8000-000000000052"]),
      allowedAssertionIds: new Set(["00000000-0000-4000-8000-000000000051"]),
    }));
  });

  it("lets the model explain a semantic search failure", async () => {
    retrieverState.retrieve.mockRejectedValue(new Error("database unavailable"));
    const model = new MockLanguageModelV4({
      doStream: [searchStep(), answerStep("组织记忆当前无法检索，我不能据此编造答案。")],
    });
    providerState.model = model;
    const response = await POST(chatRequest("请查询协会历史。"));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("组织记忆当前无法检索");
    expect(body).toContain('"type":"tool-output-error"');
    expect(body).not.toContain("database unavailable");
  });

  it("does not stream analysis when only a related file, not the exact target, was found", async () => {
    databaseState.libraryNodeFindMany.mockResolvedValue([{
      id: "00000000-0000-4000-8000-000000000061",
      name: "旧版操作手册参考材料.docx",
      originalRelativePath: "历史资料/旧版操作手册参考材料.docx",
      processingProfile: "deep",
      processingStatus: "ready",
      blob: {
        id: "00000000-0000-4000-8000-000000000062",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        processingRuns: [],
      },
    }]);
    const model = new MockLanguageModelV4({
      doStream: [
        openArtifactsStep("操作手册"),
        answerStep("当前手册复杂的主要原因是审批步骤过多，共包含五张申请表。"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("请分析当前操作手册为什么这么复杂。"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("不能替代目标正文");
    expect(body).toContain("[F1]");
    expect(body).not.toContain("当前手册复杂的主要原因");
    expect(body).not.toContain("五张申请表");
  });

  it("does not accept a View citation for a Library metadata claim", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep("openBusinessContext", {
          viewKey: "society_information",
          focus: "测试社团正式状态",
          targetHints: ["测试社团"],
        }),
        answerStep("资料库里存在《操作手册》，处理档位是 deep。[V1]"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("资料库里有哪些已发布项？"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("没有通过证据引用校验");
    expect(body).not.toContain("处理档位是 deep");
  });

  it("lets the model use the empty-View observation without rewriting its answer", async () => {
    proposalState.read.mockImplementation(async (viewKey) => emptyFixtureView(viewKey));
    const groundedAnswer =
      "我能看到 Activity Operations 业务视角；完整 View 当前共有 0 个 Card，没有收录校内场地申请，因此不存在可评价清晰度的既有条目。[V1]";
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep("openBusinessContext", {
          viewKey: "activity_operations",
          focus: "核对业务视角是否收录校内场地申请",
          targetHints: ["校内场地申请操作手册", "场地申请"],
        }),
        answerStep(groundedAnswer),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("你看不到业务视角吗？"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(groundedAnswer);
    expect(body).toContain("[V1]");
    expect(body).toContain('"type":"data-viewReferences"');
    expect(body).not.toContain("本轮只获得了部分可验证证据");
    expect(body).not.toContain("尚未作为正式业务条目收录");

    const secondPrompt = JSON.stringify(model.doStreamCalls[1].prompt);
    expect(secondPrompt).toContain('"predicate":"contains_matching_card"');
    expect(secondPrompt).toContain('"status":"absent"');
    expect(secondPrompt).toContain('"status":"not_applicable"');
  });

  it("does not let a later Shared Brain gap replace the empty-View conclusion", async () => {
    proposalState.read.mockImplementation(async (viewKey) => emptyFixtureView(viewKey));
    retrieverState.retrieve.mockResolvedValue({
      ...fixtureRetrieval(),
      seedMap: {
        facets: [],
        objects: [],
        assertions: [],
        connections: [],
      },
    });
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep("openBusinessContext", {
          viewKey: "activity_operations",
          focus: "核对校内场地申请在业务视角中的正式状态",
          targetHints: ["校内场地申请"],
        }),
        searchStep(),
        answerStep("业务视角已经写了完整流程，共有六个审批步骤。[A1]"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("我说的是业务视角的操作手册。"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("正式 View 目前是空的");
    expect(body).toContain("尚未作为正式业务条目收录");
    expect(body).not.toContain("六个审批步骤");
    expect(body).not.toContain("请先补齐对应证据");
  });
});
