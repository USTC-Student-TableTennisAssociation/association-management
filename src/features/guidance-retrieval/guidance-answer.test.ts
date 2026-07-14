import { describe, expect, it } from "vitest";

import type { GuidanceContextItem } from "./guidance-context";
import {
  buildGuidanceAnswerUserPrompt,
  guidanceAnswerSystemPrompt,
} from "./guidance-answer";

const context: GuidanceContextItem[] = [
  {
    id: "guideline-test-1",
    title: "无二课审批不开展活动",
    kind: "rule",
    status: "draft",
    authority: "pending_confirmation",
    isMandatory: true,
    contentMarkdown: "活动未获得审批前不得开展。",
    score: 12,
  },
];

describe("指导层 AI 回答协议", () => {
  it("在用户提示词中保留问题和指导卡片信息", () => {
    const prompt = buildGuidanceAnswerUserPrompt(
      "活动还没审批，可以先举办吗？",
      context,
    );

    expect(prompt).toContain("活动还没审批，可以先举办吗？");
    expect(prompt).toContain("guideline-test-1");
    expect(prompt).toContain("无二课审批不开展活动");
    expect(prompt).toContain("pending_confirmation");
  });

  it("系统提示词要求返回引用并限制草稿权威性", () => {
    expect(guidanceAnswerSystemPrompt).toContain("guidelineId");
    expect(guidanceAnswerSystemPrompt).toContain("citations");
    expect(guidanceAnswerSystemPrompt).toContain("pending_confirmation");
    expect(guidanceAnswerSystemPrompt).toContain("待确认");
    expect(guidanceAnswerSystemPrompt).toContain("只返回 JSON");
  });
});