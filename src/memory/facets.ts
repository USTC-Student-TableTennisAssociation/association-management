import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { z } from "zod";

import type { MemoryFacet } from "@/memory/types";

const facetOutputSchema = z.object({
  facets: z.array(z.string().trim().min(1).max(120)).max(3),
});

const FACET_PLACEHOLDERS = new Set(["无", "没有", "无需", "none", "null", "n/a", "...", "…"]);

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

export function isUsefulFacet(value: string): boolean {
  const key = normalized(value);
  return !FACET_PLACEHOLDERS.has(key) && /[\p{L}\p{N}]/u.test(key);
}

function parseFacetOutput(text: string): string[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Facet 模型没有返回 JSON 对象");
  return facetOutputSchema.parse(JSON.parse(text.slice(start, end + 1))).facets;
}

export async function generateMemoryFacets(input: {
  model: LanguageModel;
  query: string;
  signal?: AbortSignal;
  enabled?: boolean;
}): Promise<{ facets: MemoryFacet[]; warnings: string[] }> {
  const queryFacet: MemoryFacet = { id: "facet-0", text: input.query, source: "query" };
  if (input.enabled === false) return { facets: [queryFacet], warnings: [] };

  try {
    const result = await generateText({
      model: input.model,
      system: [
        "你是 Object–Assertion 知识库的查询改写器。",
        "原问题会始终参与搜索；只补充 0 到 3 个彼此不同、可独立检索的短 Facet。",
        "保留问题中的专名、时间和限制，不回答问题，不引入原问题没有暗示的事实。",
        '严格输出 JSON：{"facets":["..."]}。',
      ].join("\n"),
      prompt: input.query,
      temperature: 0.1,
      maxOutputTokens: 512,
      abortSignal: input.signal,
      timeout: 30_000,
    });
    let parsedFacets: string[] | undefined;
    let parseError: unknown;
    for (const candidate of [result.text, result.reasoningText]) {
      if (!candidate?.trim()) continue;
      try {
        parsedFacets = parseFacetOutput(candidate);
        break;
      } catch (error) {
        parseError = error;
      }
    }
    if (!parsedFacets) {
      throw parseError ?? new Error("Facet 模型没有返回可解析内容");
    }

    const seen = new Set([normalized(input.query)]);
    const generated = parsedFacets
      .filter((facet) => {
        const key = normalized(facet);
        if (!isUsefulFacet(facet) || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3)
      .map<MemoryFacet>((text, index) => ({
        id: `facet-${index + 1}`,
        text,
        source: "ai",
      }));
    return { facets: [queryFacet, ...generated], warnings: [] };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    console.warn("[memory.facets]", error);
    return {
      facets: [queryFacet],
      warnings: ["AI Facet 生成失败，本轮仅使用原始问题检索。"],
    };
  }
}
