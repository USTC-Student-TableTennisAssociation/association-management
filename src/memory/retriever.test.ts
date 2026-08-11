import { afterEach, describe, expect, it } from "vitest";

import { getMemoryRetriever } from "@/memory/retriever";

const originalMode = process.env.MEMORY_RETRIEVER_MODE;

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.MEMORY_RETRIEVER_MODE;
  } else {
    process.env.MEMORY_RETRIEVER_MODE = originalMode;
  }
});

describe("memory retriever selection", () => {
  it("can be explicitly disabled", async () => {
    process.env.MEMORY_RETRIEVER_MODE = "disabled";
    const result = await getMemoryRetriever().retrieve({ query: "anything" });
    expect(result).toEqual({
      query: "anything",
      mode: "disabled",
      seedMap: { facets: [], objects: [], assertions: [], connections: [] },
    });
  });

  it("uses Object–Assertion database retrieval by default", () => {
    delete process.env.MEMORY_RETRIEVER_MODE;
    expect(getMemoryRetriever().mode).toBe("object-assertion");
  });

  it("only returns the fixture for its explicit test query", async () => {
    process.env.MEMORY_RETRIEVER_MODE = "fixture";
    const retriever = getMemoryRetriever();

    expect((await retriever.retrieve({ query: "查询测试记忆" })).seedMap.assertions).toHaveLength(1);
    expect((await retriever.retrieve({ query: "real question" })).seedMap.assertions).toEqual([]);
  });
});
