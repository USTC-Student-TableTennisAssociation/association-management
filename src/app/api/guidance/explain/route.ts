import { NextResponse } from "next/server";

import {
  buildGuidanceAiContext,
  buildGuidanceAiUserPrompt,
  guidanceAiSystemPrompt,
  parseGuidanceAiExplanation,
  type GuidanceAiResponse,
} from "@/features/guidance-inspector/guidance-ai";
import { buildGuidanceGraph } from "@/features/guidance-inspector/guidance-graph";
import { getGuidanceInspectorSource } from "@/features/guidance-inspector/guidance-source";
import { buildGuidanceTree } from "@/features/guidance-inspector/guidance-tree";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

function getApiUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

async function parseJsonResponse(response: Response): Promise<ChatCompletionResponse> {
  try {
    return (await response.json()) as ChatCompletionResponse;
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_API_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.AI_MODEL;

  if (!apiKey || !model) {
    return NextResponse.json(
      { error: "AI 解读尚未配置，请先设置 AI_API_KEY 和 AI_MODEL。" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求内容格式不正确。" }, { status: 400 });
  }

  const candidate = body as Record<string, unknown>;
  const nodeId = candidate.nodeId;
  const question = candidate.question;

  if (nodeId !== undefined && nodeId !== null && typeof nodeId !== "string") {
    return NextResponse.json({ error: "nodeId 必须是字符串。" }, { status: 400 });
  }

  if (question !== undefined && question !== null && typeof question !== "string") {
    return NextResponse.json({ error: "question 必须是字符串。" }, { status: 400 });
  }

  const normalizedQuestion = typeof question === "string" ? question.trim() : "";
  if (normalizedQuestion.length > 600) {
    return NextResponse.json({ error: "问题不能超过 600 个字符。" }, { status: 400 });
  }

  const source = getGuidanceInspectorSource();
  const graph = buildGuidanceGraph(source.nodes, source.links);
  const tree = buildGuidanceTree(graph);
  const normalizedNodeId = typeof nodeId === "string" && nodeId.trim() ? nodeId.trim() : null;

  if (normalizedNodeId && !graph.nodeById.has(normalizedNodeId)) {
    return NextResponse.json({ error: "未找到指定的指导卡片。" }, { status: 404 });
  }

  const context = buildGuidanceAiContext(graph, tree, normalizedNodeId);
  if (context.nodes.length === 0) {
    return NextResponse.json({ error: "当前没有可供解读的指导内容。" }, { status: 422 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(getApiUrl(baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: guidanceAiSystemPrompt },
          { role: "user", content: buildGuidanceAiUserPrompt(context, normalizedQuestion) },
        ],
        temperature: 0.2,
        max_tokens: 6000,
      }),
      signal: controller.signal,
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      return NextResponse.json(
        { error: payload.error?.message ?? "AI 服务暂时不可用，请稍后重试。" },
        { status: 502 },
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return NextResponse.json({ error: "AI 没有返回可用内容。" }, { status: 502 });
    }

    const explanation = parseGuidanceAiExplanation(
      content,
      new Set(context.nodes.map((node) => node.id)),
    );
    if (!explanation) {
      return NextResponse.json(
        { error: "AI 返回内容不符合指导层解读格式，请重试。" },
        { status: 502 },
      );
    }

    const result: GuidanceAiResponse = {
      explanation,
      context: {
        focusNodeId: context.focusNodeId,
        focusTitle: context.focusTitle,
        nodeCount: context.nodes.length,
      },
    };

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "AI 解读请求超时，请稍后重试。"
      : "AI 解读请求失败，请稍后重试。";
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
