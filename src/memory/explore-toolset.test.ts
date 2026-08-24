import { beforeEach, describe, expect, it, vi } from "vitest";

const exploreMocks = vi.hoisted(() => ({
  searchMemory: vi.fn(),
  followObject: vi.fn(),
}));

vi.mock("@/memory/explore", () => ({
  ...exploreMocks,
  memoryExploreLimits: { queryChars: 500, focusChars: 300 },
}));

import { MemoryEvidenceAccumulator } from "@/memory/evidence-accumulator";
import {
  createMemoryExploreToolset,
  MemoryExploreContextBudgetError,
  UnknownExploreObjectError,
} from "@/memory/explore-toolset";
import type { MemoryExploreResult } from "@/memory/explore";
import type { MemoryRetrievalResult } from "@/memory/types";

function initial(): MemoryRetrievalResult {
  return {
    query: "test",
    mode: "fixture",
    seedMap: { facets: [], objects: [], assertions: [], connections: [] },
  };
}

function explored(): MemoryExploreResult {
  return {
    kind: "search-memory",
    mode: "fixture",
    query: "test",
    objects: [],
    assertions: [],
    connections: [],
    counts: { objects: 0, assertions: 0, connections: 0 },
    truncated: { objects: false, assertions: false },
    warnings: [],
  };
}

const executionOptions = {
  toolCallId: "tool-call-1",
  messages: [],
  abortSignal: undefined,
  context: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  exploreMocks.searchMemory.mockResolvedValue(explored());
});

describe("createMemoryExploreToolset", () => {
  it("rejects a result before it can exceed the request-level context budget", async () => {
    const evidence = new MemoryEvidenceAccumulator(initial());
    const tools = createMemoryExploreToolset({
      evidence,
      resultTokenBudget: 1,
    });

    await expect(tools.searchMemory.execute!(
      { query: "test", taskShape: "fact" },
      executionOptions,
    )).rejects.toBeInstanceOf(MemoryExploreContextBudgetError);
    expect(evidence.snapshot().seedMap.assertions).toHaveLength(0);
  });

  it("does not follow a GlobalObject that has not appeared in this request", async () => {
    const tools = createMemoryExploreToolset({
      evidence: new MemoryEvidenceAccumulator(initial()),
      resultTokenBudget: 1_000,
    });

    await expect(tools.followObject.execute!(
      { globalObjectId: "unknown" },
      executionOptions,
    )).rejects.toBeInstanceOf(UnknownExploreObjectError);
    expect(exploreMocks.followObject).not.toHaveBeenCalled();
  });

  it("allows searchMemory to discover an explicit target id without a request-local race", async () => {
    const tools = createMemoryExploreToolset({
      evidence: new MemoryEvidenceAccumulator(initial()),
      resultTokenBudget: 1_000,
    });

    await expect(tools.searchMemory.execute!({
      query: "目标组织的指导老师",
      targetObjectIds: ["not-yet-merged-object"],
      taskShape: "fact",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({ kind: "search-memory" }));
    expect(exploreMocks.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ targetObjectIds: ["not-yet-merged-object"] }),
      expect.any(Object),
    );
  });

  it("allows a Higher Memory maintainer to follow an explicitly selected Object", async () => {
    exploreMocks.followObject.mockResolvedValue({
      ...explored(),
      kind: "follow-object",
      globalObjectId: "important-object",
    });
    const tools = createMemoryExploreToolset({
      evidence: new MemoryEvidenceAccumulator(initial()),
      resultTokenBudget: 1_000,
      allowKnownObjectIds: ["important-object"],
      preferHigherMemory: false,
    });

    await expect(tools.followObject.execute!({
      globalObjectId: "important-object",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({
      globalObjectId: "important-object",
    }));
    expect(exploreMocks.followObject).toHaveBeenCalledWith(
      "important-object",
      undefined,
      expect.any(Object),
    );
  });

  it("passes Higher Memory preference through to Locate", async () => {
    const tools = createMemoryExploreToolset({
      evidence: new MemoryEvidenceAccumulator(initial()),
      resultTokenBudget: 1_000,
      preferHigherMemory: false,
    });

    await tools.searchMemory.execute!({ query: "test", taskShape: "fact" }, executionOptions);
    expect(exploreMocks.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ query: "test", targetHints: [] }),
      expect.objectContaining({ preferHigherMemory: false }),
    );
  });
});
