import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryRetrievalResult } from "@/memory/types";

const providerState = vi.hoisted(() => ({ model: undefined as unknown }));
const retrieverState = vi.hoisted(() => ({ retrieve: vi.fn() }));

vi.mock("@/ai/provider", () => ({
  getChatModel: () => providerState.model,
}));

vi.mock("@/memory/retriever", () => ({
  getMemoryRetriever: () => ({
    mode: "fixture" as const,
    retrieve: retrieverState.retrieve,
  }),
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

function fixtureRetrieval(): MemoryRetrievalResult {
  return {
    query: "测试记忆",
    mode: "fixture",
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

function chatRequest(text: string): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
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
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("本轮开始时尚未执行搜索");
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
      "没有找到足以支持回答的组织事实",
    );
    expect(body).toContain("你好！");
    expect(body).not.toContain("data-memorySearch");
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
