import { afterEach, describe, expect, it, vi } from "vitest";

import { embedMemoryQueries } from "@/memory/embedding-client";

const originalBaseUrl = process.env.MEMORY_EMBEDDING_BASE_URL;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalBaseUrl === undefined) delete process.env.MEMORY_EMBEDDING_BASE_URL;
  else process.env.MEMORY_EMBEDDING_BASE_URL = originalBaseUrl;
});

describe("embedMemoryQueries", () => {
  it("uses the configured persistent BGE-M3 service and validates 1024 dimensions", async () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = "http://embedding.test/";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          model: "BAAI/bge-m3",
          model_revision: "test",
          dimension: 1024,
          vectors: [Array.from({ length: 1024 }, () => 0)],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await embedMemoryQueries(["积分赛"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://embedding.test/embed",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.dimension).toBe(1024);
    expect(result.vectors).toHaveLength(1);
  });

  it("rejects vectors from an incompatible model dimension", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            model: "wrong",
            model_revision: "test",
            dimension: 3,
            vectors: [[0, 0, 0]],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(embedMemoryQueries(["query"])).rejects.toThrow("不兼容的向量维度");
  });
});
