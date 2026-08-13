import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryRetrievalResult } from "@/memory/types";
import type { SemanticViewState } from "@/semantic-view/types";

const providerState = vi.hoisted(() => ({ model: undefined as unknown }));
const retrieverState = vi.hoisted(() => ({ retrieve: vi.fn() }));
const proposalState = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn() }));
const sourceDocumentState = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("@/ai/provider", () => ({
  getChatModel: () => providerState.model,
}));

vi.mock("@/memory/retriever", () => ({
  getMemoryRetriever: () => ({
    mode: "fixture" as const,
    retrieve: retrieverState.retrieve,
  }),
}));

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
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 5,
    text: 5,
    reasoning: undefined,
  },
};

function toolCallStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "provisional" },
        {
          type: "text-delta" as const,
          id: "provisional",
          delta: "尚未验证的中间结论 [A999]",
        },
        { type: "text-end" as const, id: "provisional" },
        {
          type: "tool-call" as const,
          toolCallId: "call-search-memory",
          toolName: "searchMemory",
          input: JSON.stringify({ query: "测试记忆" }),
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

function viewToolCallStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "call-read-semantic-view",
          toolName: "readSemanticView",
          input: JSON.stringify({ viewKey: "society_information" }),
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

function sourceFullToolCallStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "call-read-source-document",
          toolName: "readSourceDocument",
          input: JSON.stringify({
            mode: "full",
            assertionRef: "A1",
            maxCharacters: 120_000,
          }),
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

function answerStep(text = "工具找到了可验证的组织记忆 [A1]。") {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "answer" },
        {
          type: "text-delta" as const,
          id: "answer",
          delta: text,
        },
        { type: "text-end" as const, id: "answer" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function proposalToolCallStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "call-propose-view-change",
          toolName: "proposeViewChange",
          input: JSON.stringify({
            viewKey: "society_information",
            reason: "用户正在讨论社团星级的展示方式。",
            changes: [{
              type: "CREATE_CARD",
              cardRef: "society",
              sourceObjectId: "00000000-0000-4000-8000-000000000001",
              cardTypeKey: "SocietyCard",
            }, {
              type: "SET_CONTENT_DIMENSION",
              card: "new:society",
              name: "社团星级",
              contentMarkdown: "三星级社团",
              supportingAssertionIds: [
                "00000000-0000-4000-8000-000000000011",
              ],
            }],
          }),
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

function directProposalToolCallStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "call-direct-view-change",
          toolName: "proposeViewChange",
          input: JSON.stringify({
            viewKey: "society_information",
            reason: "用户明确要求修改正式社团星级。",
            changes: [{
              type: "SET_CONTENT_DIMENSION",
              card: "00000000-0000-4000-8000-000000000091",
              name: "社团星级",
              contentMarkdown: "五星",
            }],
          }),
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

function assertionQueueToolCallStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "call-queue-chat-assertion",
          toolName: "queueChatAssertionCapture",
          input: JSON.stringify({
            reason: "用户陈述了新的活动安排",
          }),
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

function fixtureRetrieval(): MemoryRetrievalResult {
  return {
    query: "测试记忆",
    mode: "fixture",
    compilationId: "00000000-0000-4000-8000-000000000020",
    seedMap: {
      facets: [{ id: "facet-0", text: "测试记忆", source: "query" }],
      objects: [{
        ref: "O1",
        id: "00000000-0000-4000-8000-000000000001",
        globalObjectKey: "fixture-global-object",
        canonicalName: "测试记忆",
        surfaceForms: ["测试记忆"],
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
        renderedStatement:
          "测试记忆说明：这是一条用于验证检索、引用和流式传输链路的临时内容。",
        contextDependent: false,
        matchedBy: [],
        matchedFacets: ["facet-0"],
        sources: [{
          sourceTitle: "聊天框架测试 fixture",
          sourceSha256: "fixture",
          sourceNodeId: "fixture-region",
          sourceRegionLabel: "fixture",
          sourceBlockId: "fixture-block-1",
          ordinal: 0,
          pages: [],
        }],
      }],
      connections: [{ assertionRef: "A1", objectRef: "O1" }],
    },
  };
}

function fixtureView(): SemanticViewState {
  return {
    viewKey: "society_information",
    viewLabel: "社团信息",
    viewDescription: "正式社团信息",
    compilationId: "00000000-0000-4000-8000-000000000090",
    compatible: true,
    cardTypes: [{
      key: "SocietyCard",
      label: "社团",
      meaning: "社团本身",
      seedContentDimensions: ["社团星级", "成立时间", "宗旨", "简介"],
      slots: [],
    }],
    cards: [{
      id: "00000000-0000-4000-8000-000000000091",
      viewKey: "society_information",
      cardTypeKey: "SocietyCard",
      cardTypeLabel: "社团",
      objectId: "00000000-0000-4000-8000-000000000001",
      objectName: "测试社团",
      seedContentDimensions: ["社团星级", "成立时间", "宗旨", "简介"],
      contentDimensions: [{
        id: "00000000-0000-4000-8000-000000000092",
        name: "社团星级",
        contentMarkdown: "四星",
      }],
      slots: [],
    }],
  };
}

function chatRequest(
  text: string,
  pageContext?: {
    activeViewKey?: "society_information";
    activePresentation: "overview" | "cards" | "full_chat";
  },
): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(pageContext ? { pageContext } : {}),
      messages: [{
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text }],
      }],
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  retrieverState.retrieve.mockResolvedValue(fixtureRetrieval());
  sourceDocumentState.read.mockResolvedValue({
    document: {
      id: "00000000-0000-4000-8000-000000000020",
      title: "测试原文",
      sha256: "fixture",
      parser: "mineru",
      pageCount: 1,
      blockCount: 1,
    },
    selection: {
      mode: "full",
      label: "完整原文",
      startOrder: 0,
      endOrder: 0,
    },
    blocks: [{
      sourceBlockId: "fixture-block-1",
      order: 0,
      blockType: "text",
      headingLevel: null,
      headingPath: ["测试"],
      pages: [1],
      markdown: "原文补充了 Assertion 没有覆盖的限定条件。",
    }],
    requestedMaxCharacters: 120_000,
    returnedCharacters: 28,
    isFullDocument: true,
    isCompleteSelection: true,
  });
  proposalState.read.mockResolvedValue(fixtureView());
  proposalState.create.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000099",
    viewKey: "society_information",
    status: "pending",
    reason: "用户正在讨论社团星级的展示方式。",
    createdAt: "2026-08-11T00:00:00.000Z",
    changes: [{
      type: "SET_CONTENT_DIMENSION",
      title: "设置「社团星级」",
      cardSelector: "00000000-0000-4000-8000-000000000091",
      cardId: "00000000-0000-4000-8000-000000000091",
      cardTypeKey: "SocietyCard",
      cardLabel: "测试记忆 · 社团卡片",
      dimensionName: "社团星级",
      before: null,
      after: "三星级社团",
      supports: [],
    }],
  });
});

describe("POST /api/chat Explore", () => {
  it("answers a non-memory question without invoking Locate", async () => {
    const model = new MockLanguageModelV4({
      doStream: [answerStep("你好！我可以帮你整理思路或查询组织记忆。")],
    });
    providerState.model = model;

    const response = await POST(chatRequest("你好"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(retrieverState.retrieve).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].toolChoice).toEqual({ type: "auto" });
    expect((model.doStreamCalls[0].tools ?? []).map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "searchMemory",
        "followObject",
        "readSourceDocument",
        "readSemanticView",
        "proposeViewChange",
        "queueChatAssertionCapture",
      ]),
    );
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("本轮开始时尚未执行搜索");
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("本轮时间锚点");
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("组织时区：Asia/Shanghai");
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("每个具有时效性的组织结论");
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("无法确认今天是否仍然有效");
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("contextDependent=true");
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("Assertion 很零散");
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      "纯问候、闲聊、问题、假设",
    );
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
      "没有找到足以支持回答的组织事实",
    );
    expect(body).toContain("你好！");
    expect(body).not.toContain("data-memorySearch");
  });

  it("lets the main model explicitly queue a factual user statement without memory search", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        assertionQueueToolCallStep(),
        answerStep("明白了，这是一项计划中的迎新活动。"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("我们九月份准备举办迎新活动。"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(retrieverState.retrieve).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(2);
    expect(body).toContain('"toolName":"queueChatAssertionCapture"');
    expect(body).toContain("明白了，这是一项计划中的迎新活动");
    expect(body).not.toContain("data-memorySearch");
  });

  it("passes the active Business View presentation as soft context", async () => {
    const model = new MockLanguageModelV4({
      doStream: [answerStep("我会结合当前社团概览理解你的问题。")],
    });
    providerState.model = model;

    const response = await POST(chatRequest("这里为什么没有指导老师？", {
      activeViewKey: "society_information",
      activePresentation: "overview",
    }));

    await response.text();
    expect(response.status).toBe(200);
    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(prompt).toContain("society_information · 社团概览");
    expect(prompt).toContain("不能限制已有 Shared Brain retrieval");
  });

  it("answers from a sufficient formal View with V# and no Shared Brain search", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        viewToolCallStep(),
        answerStep("当前正式社团信息记录为四星 [V3]。"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("这个社团是几星？"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(proposalState.read).toHaveBeenCalledWith("society_information");
    expect(retrieverState.retrieve).not.toHaveBeenCalled();
    expect(body).toContain("当前正式社团信息记录为四星 [V3]");
    expect(body).toContain('"type":"data-viewReferences"');
    expect(body).toContain('"ref":"V3"');
    expect(body).not.toContain("data-memorySearch");
  });

  it("falls back to Shared Brain when the full View snapshot lacks the answer", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        viewToolCallStep(),
        toolCallStep(),
        answerStep("当前正式 View 没有记录成立时间 [V4]；底层材料提供了新事实 [A1]。"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("这个社团什么时候成立？"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(proposalState.read).toHaveBeenCalledTimes(1);
    expect(retrieverState.retrieve).toHaveBeenCalledTimes(1);
    expect(body).toContain('"type":"data-viewReferences"');
    expect(body).toContain('"ref":"V4"');
    expect(body).toContain('"answerUsedAssertionRefs":["A1"]');
  });

  it("streams a tool result into the next model step and finishes with a citable answer", async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallStep(), answerStep()],
    });
    providerState.model = model;

    const response = await POST(chatRequest("请查找组织记忆后回答。"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(retrieverState.retrieve).toHaveBeenCalledTimes(1);
    expect(retrieverState.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ query: "测试记忆" }),
    );
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
      "这是一条用于验证检索",
    );
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
      "这是一条用于验证检索、引用和流式传输链路的临时内容",
    );
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).not.toContain(
      "尚未验证的中间结论",
    );
    expect(body).toContain('\"toolName\":\"searchMemory\"');
    expect(body).toContain("工具找到了可验证的组织记忆 [A1]");
    expect(body).toContain('\"sourceClaimId\":\"fixture-claim\"');
    expect(body).toContain('\"answerUsedAssertionRefs\":[\"A1\"]');
    expect(body).not.toContain("SourceBlock markdown");
  });

  it("lets the same Chat AI read the full source and emit a real S# reference", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep(),
        sourceFullToolCallStep(),
        answerStep("原文给出了额外限定条件 [S1]。"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("如果 Assertion 太零散，请回看完整原文。"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(sourceDocumentState.read).toHaveBeenCalledWith(expect.objectContaining({
      compilationId: "00000000-0000-4000-8000-000000000020",
      selection: { mode: "full" },
      maxCharacters: 120_000,
    }));
    expect(body).toContain("原文给出了额外限定条件 [S1]");
    expect(body).toContain('\"type\":\"data-sourceReferences\"');
    expect(body).toContain('\"ref\":\"S1\"');
    expect(body).toContain('\"startBlockId\":\"fixture-block-1\"');
  });

  it("lets the same Chat AI emit a structured proposal after Shared Brain retrieval", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        viewToolCallStep(),
        toolCallStep(),
        proposalToolCallStep(),
        answerStep("我建议在 Overview 中单独展示社团星级 [A1]。"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("我觉得社团星级应该单独展示。"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(proposalState.read).toHaveBeenCalledTimes(1);
    expect(proposalState.create).toHaveBeenCalledWith(expect.objectContaining({
      allowedObjectIds: new Set(["00000000-0000-4000-8000-000000000001"]),
      allowedAssertionIds: new Set(["00000000-0000-4000-8000-000000000011"]),
    }));
    expect(body).toContain("data-viewProposal");
    expect(body).toContain("三星级社团");
    expect(body).toContain("只有用户点击批准后");
  });

  it("allows a user-confirmed View change without Assertion after reading the View", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        viewToolCallStep(),
        directProposalToolCallStep(),
        answerStep("我已把你的明确修改整理成待批准 Proposal。"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("把社团星级改成五星。"));
    await response.text();

    expect(response.status).toBe(200);
    expect(retrieverState.retrieve).not.toHaveBeenCalled();
    expect(proposalState.create).toHaveBeenCalledWith(expect.objectContaining({
      allowedAssertionIds: new Set(),
      payload: expect.objectContaining({
        changes: [expect.objectContaining({ supportingAssertionIds: [] })],
      }),
    }));
  });

  it("rejects a View Proposal when the model has not read that View first", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        directProposalToolCallStep(),
        answerStep("我需要先读取当前正式 View，暂未提出修改。"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("把社团星级改成五星。"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(proposalState.create).not.toHaveBeenCalled();
    expect(body).toContain('"type":"tool-output-error"');
  });

  it("lets the model explain a tool failure instead of failing the whole Chat API", async () => {
    retrieverState.retrieve.mockRejectedValue(new Error("database unavailable"));
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep(),
        answerStep("组织记忆当前无法检索，我不能据此编造答案。"),
      ],
    });
    providerState.model = model;

    const response = await POST(chatRequest("请查询协会的历史。"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(retrieverState.retrieve).toHaveBeenCalledTimes(1);
    expect(body).toContain("组织记忆当前无法检索");
    expect(body).toContain('"type":"tool-output-error"');
    expect(body).not.toContain("database unavailable");
    expect(body).not.toContain("data-memorySearch");
  });
});
