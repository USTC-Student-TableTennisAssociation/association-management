import { describe, expect, it } from "vitest";

import type { ClubChatMessage } from "@/ai/types";
import {
  compactChatRequestMessages,
  finalStepMessageText,
  modelHistoryMessageText,
} from "@/ai/ui-message-text";

describe("finalStepMessageText", () => {
  it("shows only the final model step after tool exploration", () => {
    const message: ClubChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "临时结论 [A1]" },
        { type: "step-start" },
        { type: "text", text: "最终回答 [A2]" },
      ],
    };

    expect(finalStepMessageText(message)).toBe("最终回答 [A2]");
  });

  it("keeps ordinary user and single-step text", () => {
    const message: ClubChatMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "继往开来是什么活动？" }],
    };

    expect(finalStepMessageText(message)).toBe("继往开来是什么活动？");
  });

  it("keeps a View Command Proposal in later negotiation context", () => {
    const message: ClubChatMessage = {
      id: "assistant-proposal",
      role: "assistant",
      parts: [
        { type: "text", text: "我建议单独展示社团星级。" },
        {
          type: "data-viewCommandProposal",
          data: {
            proposalId: "00000000-0000-4000-8000-000000000099",
            viewKey: "society_information",
            commandKey: "society.update_profile",
            commandVersion: "1",
            stateVersion: "3",
            input: { cardId: "00000000-0000-4000-8000-000000000091", rating: "三星级社团" },
          },
        },
      ],
    };

    expect(modelHistoryMessageText(message)).toContain("society.update_profile@1");
    expect(modelHistoryMessageText(message)).toContain("历史消息曾展示 View Proposal");
    expect(modelHistoryMessageText(message)).toContain("当前审批状态未知");
    expect(modelHistoryMessageText(message)).not.toContain("00000000-0000-4000-8000-000000000099");
  });

  it("keeps an Object Change Proposal in later negotiation context", () => {
    const message: ClubChatMessage = {
      id: "assistant-object-proposal",
      role: "assistant",
      parts: [
        { type: "text", text: "我发现了一个身份问题。" },
        {
          type: "data-objectChangeProposal",
          data: {
            id: "00000000-0000-4000-8000-000000000098",
            status: "pending",
            reason: "负责人只是上下文泛称。",
            createdAt: "2026-08-14T00:00:00.000Z",
            invalidatesHigherMemory: false,
            changes: [{
              type: "REMOVE_SURFACE",
              title: "移除“负责人”的 Object 名称归属",
              details: ["Object：项目负责人"],
            }],
          },
        },
      ],
    };

    expect(modelHistoryMessageText(message)).toContain("Object Change Proposal");
    expect(modelHistoryMessageText(message)).toContain("移除“负责人”");
    expect(compactChatRequestMessages([message])[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "data-objectChangeProposal" }),
      ]),
    );
  });

  it("removes prior tool payloads while retaining lightweight source anchors", () => {
    const message = {
      id: "assistant-source",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "dynamic-tool",
          toolName: "readSourceDocument",
          toolCallId: "source-call",
          state: "output-available",
          input: { mode: "full", assertionRef: "A1" },
          output: { blocks: [{ markdown: "很长的原文正文" }] },
        },
        { type: "step-start" },
        { type: "text", text: "最终回答 [S1]" },
        {
          type: "data-sourceReferences",
          data: {
            references: [{
              ref: "S1",
              label: "测试原文 · 完整原文",
              document: {
                id: "doc-1",
                title: "测试原文",
                sha256: "sha",
                parser: "mineru",
                pageCount: 1,
                blockCount: 3,
              },
              selection: {
                mode: "full",
                label: "完整原文",
                startOrder: 0,
                endOrder: 2,
              },
              startBlockId: "block-1",
              endBlockId: "block-3",
              blockCount: 3,
              pages: [1],
            }],
          },
        },
      ],
    } as unknown as ClubChatMessage;

    const compacted = compactChatRequestMessages([message]);

    expect(JSON.stringify(compacted)).not.toContain("很长的原文正文");
    expect(JSON.stringify(compacted)).not.toContain("readSourceDocument");
    expect(JSON.stringify(compacted)).toContain("最终回答 [S1]");
    expect(JSON.stringify(compacted)).toContain('"startBlockId":"block-1"');
  });
});
