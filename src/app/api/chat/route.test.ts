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
    it("连接失败后自动重试并返回成功结果", async () => {
    process.env.AI_API_KEY = "test-api-key";
    process.env.AI_API_BASE_URL =
      "https://example.test/v1";
    process.env.AI_MODEL = "test-model";

    const aiAnswer = {
      answer: "活动尚未通过审批，不应提前举办。",
      citations: [
        {
          guidelineId:
            handbookGuidelineIds.noApprovalNoActivity,
          reason: "该卡片说明未审批不得开展活动。",
        },
      ],
      unresolved: [],
    };

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("fetch failed"),
      )
      .mockResolvedValueOnce(
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
      );

    vi.stubGlobal("fetch", fetchMock);

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
              content:
                "活动还没有通过二课审批，可以先举办吗？",
            },
          ],
        }),
      }),
    );

    const payload = (await response.json()) as {
      message?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.message).toBe(
      "活动尚未通过审批，不应提前举办。",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
    it("只向 AI 发送最新问题，不混入旧对话内容", async () => {
    process.env.AI_API_KEY = "test-api-key";
    process.env.AI_API_BASE_URL =
      "https://example.test/v1";
    process.env.AI_MODEL = "test-model";

    const aiAnswer = {
      answer: "普通训练活动应在活动前 3 天完成系统申报。",
      citations: [
        {
          guidelineId:
            handbookGuidelineIds.regularActivityT3Submission,
          reason: "该卡片规定了常规活动的申报时限。",
        },
      ],
      unresolved: [],
    };

    const fetchMock = vi.fn().mockResolvedValue(
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
    );

    vi.stubGlobal("fetch", fetchMock);

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
              content: "大型赛事只剩 5 天了怎么办？",
            },
            {
              role: "assistant",
              content: "这是上一轮的回答。",
            },
            {
              role: "user",
              content: "普通训练活动应该提前几天申报？",
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);

    const fetchOptions = fetchMock.mock.calls[0]?.[1];
    const requestBody = JSON.parse(
      String(fetchOptions?.body),
    ) as {
      messages: Array<{
        role: string;
        content: string;
      }>;
    };

    expect(requestBody.messages).toHaveLength(2);
    expect(requestBody.messages[1]?.role).toBe("user");
    expect(requestBody.messages[1]?.content).toContain(
      "普通训练活动应该提前几天申报？",
    );
    expect(requestBody.messages[1]?.content).not.toContain(
      "大型赛事只剩 5 天了怎么办？",
    );
    expect(requestBody.messages[1]?.content).not.toContain(
      "这是上一轮的回答。",
    );
  });
});