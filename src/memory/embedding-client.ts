import { z } from "zod";

const embeddingResponseSchema = z.object({
  model: z.string().min(1),
  model_revision: z.string().min(1),
  dimension: z.number().int().positive(),
  vectors: z.array(z.array(z.number())),
});

export type EmbeddingBatch = {
  model: string;
  modelRevision: string;
  dimension: number;
  vectors: number[][];
};

export async function embedMemoryQueries(
  texts: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EmbeddingBatch> {
  if (texts.length === 0) {
    throw new Error("embedding texts cannot be empty");
  }
  const baseUrl =
    process.env.MEMORY_EMBEDDING_BASE_URL?.trim() || "http://127.0.0.1:8765";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts }),
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(options.timeoutMs ?? 60_000),
    ]),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : `HTTP ${response.status}`;
    throw new Error(`BGE-M3 embedding 请求失败：${message}`);
  }
  const parsed = embeddingResponseSchema.parse(payload);
  if (
    parsed.vectors.length !== texts.length ||
    parsed.dimension !== 1024 ||
    parsed.vectors.some((vector) => vector.length !== parsed.dimension)
  ) {
    throw new Error("BGE-M3 embedding 返回了不兼容的向量维度");
  }
  return {
    model: parsed.model,
    modelRevision: parsed.model_revision,
    dimension: parsed.dimension,
    vectors: parsed.vectors,
  };
}
