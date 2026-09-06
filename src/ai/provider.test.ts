import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  configuredStructuredOutputMode,
  createStructuredOutputCompatibleFetch,
  normalizeOpenAIBaseURL,
  resolveStructuredOutputMode,
  resolveStructuredOutputThinkingMode,
  transformStructuredOutputRequestBody,
  withStructuredOutputGuidance,
} from "@/ai/provider";

describe("normalizeOpenAIBaseURL", () => {
  it("collapses duplicate path separators without changing the protocol", () => {
    expect(normalizeOpenAIBaseURL("https://api.example.test//v1/"))
      .toBe("https://api.example.test/v1");
  });

  it("removes trailing separators from nested base paths", () => {
    expect(normalizeOpenAIBaseURL("https://api.example.test/gateway///v1//"))
      .toBe("https://api.example.test/gateway/v1");
  });
});

describe("structured output capabilities", () => {
  it("defaults OpenAI-compatible providers to portable json_object mode", () => {
    expect(resolveStructuredOutputMode(undefined)).toBe("json_object");
    expect(resolveStructuredOutputMode(" json_schema ")).toBe("json_schema");
    expect(resolveStructuredOutputMode("text_json")).toBe("text_json");
    expect(() => resolveStructuredOutputMode("automatic")).toThrow("仅支持");
  });

  it("lets vision inherit the text capability unless explicitly overridden", () => {
    const previousText = process.env.AI_STRUCTURED_OUTPUT_MODE;
    const previousVision = process.env.AI_VISION_STRUCTURED_OUTPUT_MODE;
    process.env.AI_STRUCTURED_OUTPUT_MODE = "text_json";
    delete process.env.AI_VISION_STRUCTURED_OUTPUT_MODE;
    try {
      expect(configuredStructuredOutputMode("vision")).toBe("text_json");
      process.env.AI_VISION_STRUCTURED_OUTPUT_MODE = "json_schema";
      expect(configuredStructuredOutputMode("vision")).toBe("json_schema");
    } finally {
      if (previousText === undefined) delete process.env.AI_STRUCTURED_OUTPUT_MODE;
      else process.env.AI_STRUCTURED_OUTPUT_MODE = previousText;
      if (previousVision === undefined) delete process.env.AI_VISION_STRUCTURED_OUTPUT_MODE;
      else process.env.AI_VISION_STRUCTURED_OUTPUT_MODE = previousVision;
    }
  });

  it("adds local schema guidance when the provider only supports JSON objects", () => {
    const schema = z.object({ summary: z.string() });
    const portable = withStructuredOutputGuidance({
      prompt: "概括内容",
      schema,
      name: "summary_result",
      mode: "json_object",
    });
    expect(portable).toContain("本次协议标识是 summary_result，它不是外层字段");
    expect(portable).toContain('"summary"');
    expect(withStructuredOutputGuidance({
      prompt: "概括内容",
      schema,
      name: "summary_result",
      mode: "json_schema",
    })).toBe("概括内容");
  });

  it("enables thinking by default for every compatible endpoint and request", () => {
    expect(resolveStructuredOutputThinkingMode(
      undefined,
      "https://api.deepseek.com/v1",
    )).toBe("enabled");
    expect(resolveStructuredOutputThinkingMode(
      undefined,
      "https://gateway.example.test/v1",
    )).toBe("enabled");

    expect(transformStructuredOutputRequestBody({
      model: "deepseek-v4-flash",
      response_format: { type: "json_object" },
    }, {
      mode: "json_object",
      thinkingMode: "enabled",
    })).toMatchObject({
      response_format: { type: "json_object" },
      thinking: { type: "enabled" },
    });
    expect(transformStructuredOutputRequestBody({
      model: "deepseek-v4-flash",
    }, {
      mode: "json_object",
      thinkingMode: "enabled",
    })).toMatchObject({
      thinking: { type: "enabled" },
    });
  });

  it("removes response_format in text_json fallback mode", () => {
    expect(transformStructuredOutputRequestBody({
      response_format: { type: "json_object" },
    }, {
      mode: "text_json",
      thinkingMode: "inherit",
    })).not.toHaveProperty("response_format");
  });
});

describe("createStructuredOutputCompatibleFetch", () => {
  it("moves structured JSON from reasoning_content when content is null", async () => {
    const baseFetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: null,
          reasoning_content: '{"summary":"ok"}',
        },
      }],
    }), { headers: { "content-type": "application/json" } }));
    const compatibleFetch = createStructuredOutputCompatibleFetch(baseFetch as typeof fetch);

    const response = await compatibleFetch("https://api.example.test/chat/completions", {
      method: "POST",
      body: JSON.stringify({ response_format: { type: "json_object" } }),
    });

    expect(await response.json()).toMatchObject({
      choices: [{
        message: {
          content: '{"summary":"ok"}',
          reasoning_content: '{"summary":"ok"}',
        },
      }],
    });
  });

  it("does not expose reasoning_content for ordinary requests", async () => {
    const original = new Response(JSON.stringify({
      choices: [{ message: { content: null, reasoning_content: "private reasoning" } }],
    }), { headers: { "content-type": "application/json" } });
    const baseFetch = vi.fn(async () => original);
    const compatibleFetch = createStructuredOutputCompatibleFetch(baseFetch as typeof fetch);

    const response = await compatibleFetch("https://api.example.test/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(response).toBe(original);
  });

  it("does not promote analysis mixed with a structured JSON draft", async () => {
    const original = new Response(JSON.stringify({
      choices: [{
        message: {
          content: null,
          reasoning_content: 'I should analyze this first.\n{"summary":"ok"}',
        },
      }],
    }), { headers: { "content-type": "application/json" } });
    const baseFetch = vi.fn(async () => original);
    const compatibleFetch = createStructuredOutputCompatibleFetch(baseFetch as typeof fetch);

    const response = await compatibleFetch("https://api.example.test/chat/completions", {
      method: "POST",
      body: JSON.stringify({ response_format: { type: "json_object" } }),
    });

    expect(response).toBe(original);
  });

  it("accepts a complete fenced JSON object from reasoning_content", async () => {
    const baseFetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: null,
          reasoning_content: '```json\n{"summary":"ok"}\n```',
        },
      }],
    }), { headers: { "content-type": "application/json" } }));
    const compatibleFetch = createStructuredOutputCompatibleFetch(baseFetch as typeof fetch);

    const response = await compatibleFetch("https://api.example.test/chat/completions", {
      method: "POST",
      body: JSON.stringify({ response_format: { type: "json_object" } }),
    });

    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: '{"summary":"ok"}' } }],
    });
  });
});
