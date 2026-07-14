import { describe, expect, it } from "vitest";

import { parseGuidanceAnswer } from "./guidance-answer-parser";

describe("指导层 AI 回答校验", () => {
  it("解析结构正确且引用真实卡片的回答", () => {
    const rawText = JSON.stringify({
      answer: "活动尚未审批，不应提前举办。",
      citations: [
        {
          guidelineId: "guideline-test-1",
          reason: "该卡片说明未审批不得开展活动。",
        },
      ],
      unresolved: [],
    });

    const result = parseGuidanceAnswer(
      rawText,
      new Set(["guideline-test-1"]),
    );

    expect(result).toEqual({
      answer: "活动尚未审批，不应提前举办。",
      citations: [
        {
          guidelineId: "guideline-test-1",
          reason: "该卡片说明未审批不得开展活动。",
        },
      ],
      unresolved: [],
    });
  });
    it("拒绝不是 JSON 的普通文字回答", () => {
    const result = parseGuidanceAnswer(
      "活动尚未审批，所以不应该提前举办。",
      new Set(["guideline-test-1"]),
    );

    expect(result).toBeNull();
  });
  //当AI伪造一个不存在的指导卡片时，应该拒绝该回答
    it("拒绝引用不存在指导卡片的回答", () => {
    const rawText = JSON.stringify({
      answer: "活动已经获得特别批准，可以直接举办。",
      citations: [
        {
          guidelineId: "fabricated-guideline",
          reason: "该卡片允许直接举办活动。",
        },
      ],
      unresolved: [],
    });

    const result = parseGuidanceAnswer(
      rawText,
      new Set(["guideline-test-1"]),
    );

    expect(result).toBeNull();
  });
    it("能够解析 Markdown 代码围栏中的 JSON", () => {
    const rawText = [
      "```json",
      JSON.stringify({
        answer: "活动尚未审批，不应提前举办。",
        citations: [
          {
            guidelineId: "guideline-test-1",
            reason: "该卡片说明未审批不得开展活动。",
          },
        ],
        unresolved: [],
      }),
      "```",
    ].join("\n");

    const result = parseGuidanceAnswer(
      rawText,
      new Set(["guideline-test-1"]),
    );

    expect(result?.answer).toBe(
      "活动尚未审批，不应提前举办。",
    );
    expect(result?.citations).toHaveLength(1);
  });
  //缺少有效回答正文时拒绝回答
    it("拒绝缺少或只有空白 answer 的回答", () => {
    const missingAnswer = JSON.stringify({
      citations: [],
      unresolved: [],
    });

    const blankAnswer = JSON.stringify({
      answer: "   ",
      citations: [],
      unresolved: [],
    });

    const allowedIds = new Set(["guideline-test-1"]);

    expect(
      parseGuidanceAnswer(missingAnswer, allowedIds),
    ).toBeNull();

    expect(
      parseGuidanceAnswer(blankAnswer, allowedIds),
    ).toBeNull();
  });
  //同一张指导卡片只保留一次引用
    it("同一张指导卡片只保留一次引用", () => {
    const rawText = JSON.stringify({
      answer: "活动尚未审批，不应提前举办。",
      citations: [
        {
          guidelineId: "guideline-test-1",
          reason: "未审批不得开展活动。",
        },
        {
          guidelineId: "guideline-test-1",
          reason: "这是活动开展前的审批门禁。",
        },
      ],
      unresolved: [],
    });

    const result = parseGuidanceAnswer(
      rawText,
      new Set(["guideline-test-1"]),
    );

    expect(result?.citations).toHaveLength(1);
  });
    it("拒绝引用理由为空的回答", () => {
    const rawText = JSON.stringify({
      answer: "活动尚未审批，不应提前举办。",
      citations: [
        {
          guidelineId: "guideline-test-1",
          reason: "   ",
        },
      ],
      unresolved: [],
    });

    const result = parseGuidanceAnswer(
      rawText,
      new Set(["guideline-test-1"]),
    );

    expect(result).toBeNull();
  });
    it("拒绝既无引用也未说明信息不足的回答", () => {
    const rawText = JSON.stringify({
      answer: "活动可以正常举办。",
      citations: [],
      unresolved: [],
    });

    const result = parseGuidanceAnswer(
      rawText,
      new Set(["guideline-test-1"]),
    );

    expect(result).toBeNull();
  });
  //接受没有引用但明确说明信息不足的回答
    it("接受没有引用但明确说明信息不足的回答", () => {
    const rawText = JSON.stringify({
      answer: "现有指导卡片无法确认应该选择哪家餐厅。",
      citations: [],
      unresolved: ["缺少聚餐餐厅选择方面的指导信息。"],
    });

    const result = parseGuidanceAnswer(
      rawText,
      new Set(["guideline-test-1"]),
    );

    expect(result).toEqual({
      answer: "现有指导卡片无法确认应该选择哪家餐厅。",
      citations: [],
      unresolved: ["缺少聚餐餐厅选择方面的指导信息。"],
    });
  });
});