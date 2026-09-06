import { describe, expect, it } from "vitest";

import {
  classifyCompilationFailure,
  compilationFailureStatusMessage,
  retryableModelOutputFailure,
} from "@/library/compilation-failure";

describe("library compilation failure policy", () => {
  it("stops immediately for a structured billing failure", () => {
    const failure = classifyCompilationFailure(new Error([
      "cold-start explore failed",
      'SYDARIS_FAILURE {"retryable":false,"category":"billing","message":"Client error 402","statusCode":402}',
    ].join("\n")));

    expect(failure).toMatchObject({ retryable: false, category: "billing", statusCode: 402 });
    expect(compilationFailureStatusMessage(failure)).toContain("余额不足");
  });

  it("keeps rate limits and remote outages retryable", () => {
    expect(classifyCompilationFailure({ statusCode: 429, message: "rate limited" })).toMatchObject({
      retryable: true,
      category: "rate_limit",
    });
    expect(classifyCompilationFailure(new Error("HTTP 503 upstream unavailable"))).toMatchObject({
      retryable: true,
      category: "remote_service",
    });
    expect(classifyCompilationFailure(new Error(
      "来源语义·region-0047·Object Fragment Construction流式传输连续失败",
    ))).toMatchObject({
      retryable: true,
      category: "transport",
    });
    expect(classifyCompilationFailure(new Error(
      "Cannot connect to API: Headers Timeout Error",
    ))).toMatchObject({
      retryable: true,
      category: "transport",
    });
    expect(classifyCompilationFailure(Object.assign(
      new Error("request headers timed out"),
      { code: "UND_ERR_HEADERS_TIMEOUT" },
    ))).toMatchObject({
      retryable: true,
      category: "transport",
    });
  });

  it("keeps a repeatedly invalid model result eligible for checkpoint reruns", () => {
    const failure = classifyCompilationFailure(retryableModelOutputFailure(
      new Error("纯文本 JSON clean retry 未通过 Schema"),
    ));
    const coldStartFailure = classifyCompilationFailure(new Error([
      "cold-start resolve-objects 失败（code=1）",
      'SYDARIS_FAILURE {"retryable":true,"category":"model_output","message":"SourceRegion 身份对齐连续失败"}',
    ].join("\n")));

    expect(failure).toMatchObject({
      retryable: true,
      category: "model_output",
      message: "纯文本 JSON clean retry 未通过 Schema",
    });
    expect(coldStartFailure).toMatchObject({
      retryable: true,
      category: "model_output",
      message: "SourceRegion 身份对齐连续失败",
    });
    expect(compilationFailureStatusMessage(failure)).toContain("重新生成完整结果");
  });

  it("fails closed for unknown programming and data errors", () => {
    expect(classifyCompilationFailure(new Error("invalid checkpoint schema"))).toMatchObject({
      retryable: false,
      category: "internal",
    });
  });
});
