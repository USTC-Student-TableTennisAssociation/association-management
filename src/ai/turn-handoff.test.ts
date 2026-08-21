import { describe, expect, it } from "vitest";

import { resolveTurnHandoff } from "@/ai/turn-handoff";

describe("resolveTurnHandoff", () => {
  const currentUserText = "测试活动可能在明天举行，地点还没有确定。";

  it("accepts a valid request for Assertion review", () => {
    expect(resolveTurnHandoff({
      currentUserText,
      handoff: {
        reviewNeeded: true,
        candidateQuotes: ["可能在明天举行", "地点还没有确定"],
      },
    })).toEqual({
      handoffIsValid: true,
      reviewNeeded: true,
      candidateQuotes: ["可能在明天举行", "地点还没有确定"],
      reviewSource: "handoff",
    });
  });

  it("respects a valid explicit decision to skip review", () => {
    expect(resolveTurnHandoff({
      currentUserText: "这个活动是什么时候举行？",
      handoff: { reviewNeeded: false, candidateQuotes: [] },
    })).toEqual({
      handoffIsValid: true,
      reviewNeeded: false,
      candidateQuotes: [],
      reviewSource: "handoff",
    });
  });

  it("falls back to constrained Assertion review when handoff is missing", () => {
    expect(resolveTurnHandoff({ currentUserText })).toEqual({
      handoffIsValid: false,
      reviewNeeded: true,
      candidateQuotes: [],
      reviewSource: "fallback",
    });
  });

  it("does not review a pure question when handoff is missing", () => {
    expect(resolveTurnHandoff({
      currentUserText: "Echo正式闭环人工测试赛-20260821的时间、地点和当前状态是什么？",
    })).toEqual({
      handoffIsValid: false,
      reviewNeeded: false,
      candidateQuotes: [],
      reviewSource: "question_guard",
    });
  });

  it("still reviews a mixed declarative update and question", () => {
    expect(resolveTurnHandoff({
      currentUserText: "活动已经确定在周五举行。具体地点在哪里？",
    })).toEqual({
      handoffIsValid: false,
      reviewNeeded: true,
      candidateQuotes: [],
      reviewSource: "fallback",
    });
  });

  it("falls back when a proposed quote is not verbatim user text", () => {
    expect(resolveTurnHandoff({
      currentUserText,
      handoff: {
        reviewNeeded: true,
        candidateQuotes: ["地点已经确定"],
      },
    })).toEqual({
      handoffIsValid: false,
      reviewNeeded: true,
      candidateQuotes: [],
      reviewSource: "fallback",
    });
  });
});
