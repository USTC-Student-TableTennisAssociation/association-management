import { NextResponse } from "next/server";

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

const systemPrompt = `
你是一个社团 AI 秘书。
`;

function isValidMessage(message: unknown): message is ChatMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Record<string, unknown>;

  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0
  );
}

function getApiUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

async function parseJsonResponse(response: Response): Promise<ChatCompletionResponse | null> {
  const text = await response.text();

  try {
    return JSON.parse(text) as ChatCompletionResponse;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const apiKey = process.env.AI_API_KEY;
  const apiBaseUrl = process.env.AI_API_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.AI_MODEL;

  if (!apiKey || !model) {
    return NextResponse.json(
      { error: "AI 服务暂不可用，请联系管理员。" },
      { status: 500 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "请求格式不是有效 JSON。" },
      { status: 400 },
    );
  }

  const messagesInput =
    typeof body === "object" && body !== null
      ? (body as { messages?: unknown }).messages
      : undefined;

  if (!Array.isArray(messagesInput)) {
    return NextResponse.json(
      { error: "缺少消息列表。" },
      { status: 400 },
    );
  }

  if (!messagesInput.every(isValidMessage)) {
    return NextResponse.json(
      { error: "消息格式错误。" },
      { status: 400 },
    );
  }

  const messages = messagesInput
    .slice(-20)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 4000),
    }));

  if (messages.length === 0) {
    return NextResponse.json(
      { error: "消息内容不能为空。" },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(getApiUrl(apiBaseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          ...messages,
        ],
        temperature: 0.4,
        max_tokens: 1000,
      }),
    });

    clearTimeout(timeoutId);

    const data = await parseJsonResponse(response);

    if (!data) {
      return NextResponse.json(
        { error: "AI 服务返回了无法解析的响应。" },
        { status: 502 },
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        { error: "AI 服务请求失败，请稍后重试。" },
        { status: response.status },
      );
    }

    const assistantMessage = data.choices?.[0]?.message?.content?.trim();

    if (!assistantMessage) {
      return NextResponse.json(
        { error: "AI 服务没有返回有效回复。" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      message: assistantMessage,
      usage: data.usage,
      finishReason: data.choices?.[0]?.finish_reason,
    });
  } catch {
    clearTimeout(timeoutId);

    return NextResponse.json(
      { error: "无法连接 AI 服务，请检查网络或 API 配置。" },
      { status: 502 },
    );
  }
}