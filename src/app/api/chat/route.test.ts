import { afterEach, describe, expect, it, vi } from "vitest";

import { handbookGuidelineIds } from "../../../../prisma/handbook-guidance.data";
import { POST } from "./route";

const originalApiKey = process.env.AI_API_KEY;
const originalApiBaseUrl = process.env.AI_API_BASE_URL;
const originalModel = process.env.AI_MODEL;

afterEach(() => {
  process.env.AI_API_KEY = originalApiKey;
  process.env.AI_API_BASE_URL = originalApiBaseUrl;
  process.env.AI_MODEL = originalModel;
  vi.unstubAllGlobals();
});

describe("聊天接口的指导层接入", () => {
  it("返回经过校验的回答和指导卡片引用", async () => {
    process.env.AI_API_KEY = "test-api-key";
    process.env.AI_API_BASE_URL = "https://example.test/v1";
    process.env.AI_MODEL = "test-model";

    const aiAnswer = {
      answer: "活动尚未通过审批，目前不应提前举办。",
      citations: [
        {
          guidelineId: handbookGuidelineIds.noApprovalNoActivity,
          reason: "该卡片说明未审批不得开展活动。",
        },
      ],
      unresolved: [],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(aiAnswer),
                },
                finish_reason: "stop",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      ),
    );

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: "活动还没有通过二课审批，可以先举办吗？",
            },
          ],
        }),
      }),
    );

    const payload = (await response.json()) as {
      message?: string;
      citations?: Array<{
        guidelineId: string;
        title: string;
        reason: string;
        authority: string;
      }>;
      unresolved?: string[];
    };

    expect(response.status).toBe(200);
    expect(payload.message).toBe(
      "活动尚未通过审批，目前不应提前举办。",
    );
    expect(payload.citations).toEqual([
      {
        guidelineId: handbookGuidelineIds.noApprovalNoActivity,
        title: "无二课审批不开展活动",
        reason: "该卡片说明未审批不得开展活动。",
        authority: "pending_confirmation",
      },
    ]);
    expect(payload.unresolved).toEqual([]);
        const fetchMock = vi.mocked(fetch);

    expect(fetchMock).toHaveBeenCalledOnce();

    const fetchOptions = fetchMock.mock.calls[0]?.[1];
    const requestBody = JSON.parse(
      String(fetchOptions?.body),
    ) as {
      messages: Array<{
        role: string;
        content: string;
      }>;
    };

    const aiUserMessage =
      requestBody.messages[
        requestBody.messages.length - 1
      ];

    expect(aiUserMessage?.role).toBe("user");
    expect(aiUserMessage?.content).toContain(
      "活动还没有通过二课审批，可以先举办吗？",
    );
    expect(aiUserMessage?.content).toContain(
      handbookGuidelineIds.noApprovalNoActivity,
    );
    expect(aiUserMessage?.content).toContain(
      "无二课审批不开展活动",
    );
    expect(aiUserMessage?.content).toContain(
      "pending_confirmation",
    );
  });
});