import { NextResponse } from "next/server";

import {
  handbookGuidelineLinks,
  handbookGuidelines,
} from "../../../../prisma/handbook-guidance.data";
import { parseGuidanceAnswer } from "../../../features/guidance-retrieval/guidance-answer-parser";
import {
  buildGuidanceAnswerUserPrompt,
  guidanceAnswerSystemPrompt,
} from "../../../features/guidance-retrieval/guidance-answer";
import { buildGuidanceChatContext } from "../../../features/guidance-retrieval/guidance-chat-pipeline";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
  error?: {
    message?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

const maxAiRequestAttempts = 3;
const aiRequestTimeoutMs = 90000;

const retryableStatusCodes = new Set([
  429,
  502,
  503,
  504,
]);

function isValidMessage(
  message: unknown,
): message is ChatMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate =
    message as Record<string, unknown>;

  return (
    (candidate.role === "user" ||
      candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0
  );
}

function getApiUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getRetryDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === "test") {
    return 0;
  }

  return attempt === 0 ? 1000 : 2500;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
): Promise<Response> {
  let lastError: unknown;

  for (
    let attempt = 0;
    attempt < maxAiRequestAttempts;
    attempt += 1
  ) {
    const controller = new AbortController();

    const timeoutId = setTimeout(
      () => controller.abort(),
      aiRequestTimeoutMs,
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      const shouldRetry =
        retryableStatusCodes.has(response.status) &&
        attempt < maxAiRequestAttempts - 1;

      if (!shouldRetry) {
        return response;
      }

      await response.text();
      await wait(getRetryDelayMs(attempt));
    } catch (error) {
      lastError = error;

      const isRequestTimeout =
        error instanceof Error &&
        error.name === "AbortError";

      if (
        isRequestTimeout ||
        attempt >= maxAiRequestAttempts - 1
      ) {
        throw error;
      }

      await wait(getRetryDelayMs(attempt));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError;
}

async function parseJsonResponse(
  response: Response,
): Promise<ChatCompletionResponse | null> {
  const text = await response.text();

  try {
    return JSON.parse(
      text,
    ) as ChatCompletionResponse;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const apiKey = process.env.AI_API_KEY;

  const apiBaseUrl =
    process.env.AI_API_BASE_URL ??
    "https://api.openai.com/v1";

  const model = process.env.AI_MODEL;

  if (!apiKey || !model) {
    return NextResponse.json(
      {
        error:
          "AI 服务暂不可用，请联系管理员。",
      },
      {
        status: 500,
      },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "请求格式不是有效 JSON。",
      },
      {
        status: 400,
      },
    );
  }

  const messagesInput =
    typeof body === "object" && body !== null
      ? (body as { messages?: unknown })
          .messages
      : undefined;

  if (!Array.isArray(messagesInput)) {
    return NextResponse.json(
      {
        error: "缺少消息列表。",
      },
      {
        status: 400,
      },
    );
  }

  if (!messagesInput.every(isValidMessage)) {
    return NextResponse.json(
      {
        error: "消息格式错误。",
      },
      {
        status: 400,
      },
    );
  }

  const messages = messagesInput
    .slice(-20)
    .map((message) => ({
      role: message.role,
      content: message.content
        .trim()
        .slice(0, 4000),
    }));

  if (messages.length === 0) {
    return NextResponse.json(
      {
        error: "消息内容不能为空。",
      },
      {
        status: 400,
      },
    );
  }

  const latestMessage =
    messages[messages.length - 1];

  if (
    !latestMessage ||
    latestMessage.role !== "user"
  ) {
    return NextResponse.json(
      {
        error: "缺少最新的用户问题。",
      },
      {
        status: 400,
      },
    );
  }

  const guidanceContext =
    buildGuidanceChatContext(
      latestMessage.content,
      handbookGuidelines,
      handbookGuidelineLinks,
    );

  const guidanceUserPrompt =
    buildGuidanceAnswerUserPrompt(
      latestMessage.content,
      guidanceContext,
    );

  const requestBody = JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content: guidanceAnswerSystemPrompt,
      },
      {
        role: "user",
        content: guidanceUserPrompt,
      },
    ],
    temperature: 0.2,
    max_tokens: 1200,
  });

  try {
    const response = await fetchWithRetry(
      getApiUrl(apiBaseUrl),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
      },
    );

    const data =
      await parseJsonResponse(response);

    if (!data) {
      return NextResponse.json(
        {
          error:
            "AI 服务返回了无法解析的响应。",
        },
        {
          status: 502,
        },
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          error:
            data.error?.message ??
            "AI 服务请求失败，请稍后重试。",
        },
        {
          status: response.status,
        },
      );
    }

    const rawAssistantMessage =
      data.choices?.[0]?.message?.content?.trim();

    if (!rawAssistantMessage) {
      return NextResponse.json(
        {
          error:
            "AI 服务没有返回有效回复。",
        },
        {
          status: 502,
        },
      );
    }

    const allowedGuidelineIds = new Set(
      guidanceContext.map(
        (item) => item.id,
      ),
    );

    const guidanceAnswer =
      parseGuidanceAnswer(
        rawAssistantMessage,
        allowedGuidelineIds,
      );

    if (!guidanceAnswer) {
      return NextResponse.json(
        {
          error:
            "AI 返回的回答或引用没有通过指导层校验。",
        },
        {
          status: 502,
        },
      );
    }

    const contextById = new Map(
      guidanceContext.map((item) => [
        item.id,
        item,
      ]),
    );

    const citations =
      guidanceAnswer.citations.map(
        (citation) => {
          const contextItem =
            contextById.get(
              citation.guidelineId,
            );

          return {
            guidelineId:
              citation.guidelineId,
            title:
              contextItem?.title ??
              "未知指导卡片",
            reason: citation.reason,
            authority:
              contextItem?.authority ??
              "pending_confirmation",
          };
        },
      );

    return NextResponse.json({
      message: guidanceAnswer.answer,
      citations,
      unresolved:
        guidanceAnswer.unresolved,
      usage: data.usage,
      finishReason:
        data.choices?.[0]?.finish_reason,
    });
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      error.name === "AbortError";

    return NextResponse.json(
      {
        error: isTimeout
          ? "学校 AI 服务响应超时，请稍后重试。"
          : "学校 AI 服务当前连接不稳定，已自动重试，请稍后再试。",
      },
      {
        status: 502,
      },
    );
  }
}