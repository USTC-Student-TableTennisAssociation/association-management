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

function initialWithObject(): MemoryRetrievalResult {
  return {
    query: "test",
    mode: "fixture",
    seedMap: {
      facets: [],
      objects: [{
        ref: "O1",
        id: "important-object",
        globalObjectKey: "important-object-key",
        canonicalName: "重要对象",
        surfaceForms: ["重要对象"],
        matchedBy: [],
        matchedFacets: [],
        supportingAssertions: [],
        lexicalMatch: true,
        semanticMatch: false,
      }],
      assertions: [],
      connections: [],
    },
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
      { objectRef: "O99" },
      executionOptions,
    )).rejects.toBeInstanceOf(UnknownExploreObjectError);
    expect(exploreMocks.followObject).not.toHaveBeenCalled();
  });

  it("resolves an explicit O# search target inside the Runtime", async () => {
    const tools = createMemoryExploreToolset({
      evidence: new MemoryEvidenceAccumulator(initialWithObject()),
      resultTokenBudget: 1_000,
    });

    await expect(tools.searchMemory.execute!({
      query: "目标组织的指导老师",
      targetObjectRefs: ["O1"],
      taskShape: "fact",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({ kind: "search-memory" }));
    expect(exploreMocks.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ targetObjectIds: ["important-object"] }),
      expect.any(Object),
    );
  });

  it("allows an internal fact agent to receive IDs while still following O#", async () => {
    exploreMocks.followObject.mockResolvedValue({
      ...explored(),
      kind: "follow-object",
      globalObjectId: "important-object",
    });
    const tools = createMemoryExploreToolset({
      evidence: new MemoryEvidenceAccumulator(initialWithObject()),
      resultTokenBudget: 1_000,
      preferHigherMemory: false,
      exposeDatabaseIds: true,
    });

    await expect(tools.followObject.execute!({
      objectRef: "O1",
    }, executionOptions)).resolves.toEqual(expect.objectContaining({
      globalObjectId: "important-object",
    }));
    expect(exploreMocks.followObject).toHaveBeenCalledWith(
      "important-object",
      undefined,
      expect.any(Object),
    );
  });

  it("does not expose storage IDs in main-model search results", async () => {
    exploreMocks.searchMemory.mockResolvedValue({
      ...explored(),
      compilationId: "compilation-secret",
      objects: [{
        ref: "O7",
        id: "database-object-id",
        globalObjectKey: "database-object-key",
        canonicalName: "中国科学技术大学学生乒乓球协会",
        surfaceForms: ["科大乒协"],
        lexicalMatch: true,
        semanticMatch: false,
      }],
    });
    const tools = createMemoryExploreToolset({
      evidence: new MemoryEvidenceAccumulator(initial()),
      resultTokenBudget: 1_000,
    });

    const result = await tools.searchMemory.execute!(
      { query: "社团概览", taskShape: "synthesis" },
      executionOptions,
    );

    expect(result).toEqual(expect.objectContaining({
      objects: [expect.objectContaining({
        ref: "O1",
        canonicalName: "中国科学技术大学学生乒乓球协会",
      })],
    }));
    expect(JSON.stringify(result)).not.toContain("database-object-id");
    expect(JSON.stringify(result)).not.toContain("database-object-key");
    expect(JSON.stringify(result)).not.toContain("compilation-secret");
  });

  it("presents grounded facts separately from source References", async () => {
    exploreMocks.searchMemory.mockResolvedValue({
      ...explored(),
      objects: [{
        ref: "O7",
        id: "database-object-id",
        globalObjectKey: "database-object-key",
        canonicalName: "目标组织",
        surfaceForms: ["组织"],
        lexicalMatch: true,
        semanticMatch: false,
      }],
      assertions: [{
        ref: "A7",
        id: "fact-id",
        kind: "grounded",
        dereferenceRequired: false,
        sourceClaimId: "fact-claim",
        renderedStatement: "目标组织成立于某日。",
        contextDependent: false,
        sources: [],
      }, {
        ref: "A8",
        id: "reference-id",
        kind: "reference",
        dereferenceRequired: true,
        sourceClaimId: "reference-claim",
        renderedStatement: "完整活动清单位于原文章节。",
        contextDependent: true,
        sources: [],
      }],
      connections: [
        { assertionRef: "A7", objectRef: "O7" },
        { assertionRef: "A8", objectRef: "O7" },
      ],
      counts: { objects: 1, assertions: 2, connections: 2 },
    });
    const tools = createMemoryExploreToolset({
      evidence: new MemoryEvidenceAccumulator(initial()),
      resultTokenBudget: 1_000,
    });

    const result = await tools.searchMemory.execute!(
      { query: "完整资料", taskShape: "synthesis" },
      executionOptions,
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      facts: [{ ref: "A1", renderedStatement: "目标组织成立于某日。", objectRefs: ["O1"] }],
      references: [{
        ref: "A2",
        renderedStatement: "完整活动清单位于原文章节。",
        objectRefs: ["O1"],
        dereferenceRequired: true,
      }],
      counts: { objects: 1, facts: 1, references: 1 },
    });
    expect(result).not.toHaveProperty("assertions");
    expect(result).not.toHaveProperty("connections");
    expect(JSON.stringify(result)).not.toContain("fact-id");
    expect(JSON.stringify(result)).not.toContain("reference-id");
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
