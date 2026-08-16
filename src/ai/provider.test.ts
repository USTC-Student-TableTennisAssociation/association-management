import { describe, expect, it, vi } from "vitest";

import {
  createStructuredOutputCompatibleFetch,
  normalizeOpenAIBaseURL,
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
