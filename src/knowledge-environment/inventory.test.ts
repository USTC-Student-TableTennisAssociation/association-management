import type { PrismaClient } from "@/generated/prisma/client";
import type { ExtensionRegistry } from "@/runtime/extension-host/extension-registry";
import { describe, expect, it, vi } from "vitest";

import { inspectKnowledgeEnvironment } from "@/knowledge-environment/inventory";

function fakeDependencies() {
  const database = {
    memoryGlobalObject: {
      count: vi.fn().mockResolvedValue(3),
      findMany: vi.fn().mockResolvedValue([
        { canonicalName: "对象甲" },
        { canonicalName: "对象乙" },
      ]),
    },
    memoryAssertion: {
      groupBy: vi.fn().mockResolvedValue([
        { kind: "grounded", _count: { _all: 4 } },
        { kind: "reference", _count: { _all: 2 } },
      ]),
    },
    memoryObjectHigherMemory: { count: vi.fn().mockResolvedValue(1) },
    memoryAmbientHigherMemory: { count: vi.fn().mockResolvedValue(2) },
    memoryAssertionEmbeddingIndex: {
      findUnique: vi.fn().mockResolvedValue({
        indexedAssertionCount: 6,
        indexedAt: new Date("2026-08-31T00:00:00.000Z"),
      }),
    },
    libraryNode: {
      groupBy: vi.fn().mockResolvedValue([
        {
          kind: "folder",
          processingProfile: "catalog",
          processingStatus: "idle",
          _count: { _all: 2 },
        },
        {
          kind: "file",
          processingProfile: "catalog",
          processingStatus: "ready",
          _count: { _all: 2 },
        },
        {
          kind: "file",
          processingProfile: "coarse",
          processingStatus: "queued",
          _count: { _all: 1 },
        },
        {
          kind: "file",
          processingProfile: "deep",
          processingStatus: "failed",
          _count: { _all: 1 },
        },
      ]),
      findMany: vi.fn().mockResolvedValue([{
        name: "章程.pdf",
        originalRelativePath: "制度/章程.pdf",
        processingProfile: "deep",
        processingStatus: "ready",
      }]),
    },
    librarySourceBlob: { count: vi.fn().mockResolvedValue(3) },
    librarySourceDocument: { count: vi.fn().mockResolvedValue(2) },
    librarySourceProcessingRun: {
      count: vi.fn()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1),
    },
    installedView: {
      findMany: vi.fn().mockResolvedValue([
        { viewKey: "alpha", status: "enabled", stateVersion: BigInt(4) },
        { viewKey: "beta", status: "incompatible", stateVersion: BigInt(2) },
      ]),
    },
    viewCard: {
      groupBy: vi.fn().mockResolvedValue([
        { viewKey: "alpha", cardTypeKey: "Activity", _count: { _all: 2 } },
        { viewKey: "beta", cardTypeKey: "Society", _count: { _all: 1 } },
      ]),
    },
    viewHigherMemory: {
      findMany: vi.fn().mockResolvedValue([{ viewKey: "beta" }]),
    },
  };
  const registry = {
    listViews: vi.fn().mockReturnValue([
      { manifest: { key: "beta", label: "Beta" } },
      { manifest: { key: "alpha", label: "Alpha" } },
    ]),
  };
  return {
    database: database as unknown as PrismaClient,
    registry: registry as unknown as Pick<ExtensionRegistry, "listViews">,
    mocks: { database, registry },
  };
}

describe("inspectKnowledgeEnvironment", () => {
  it("returns exact, layered inventory without collapsing the count semantics", async () => {
    const { database, registry } = fakeDependencies();
    const result = await inspectKnowledgeEnvironment(
      { includeExamples: true, exampleLimit: 2 },
      { database, registry },
    );

    expect(result.requestedLayers).toEqual([
      "shared_brain",
      "library",
      "business_views",
    ]);
    expect(result.sharedBrain).toMatchObject({
      coverage: "complete",
      measurement: "exact",
      objects: 3,
      assertions: { total: 6, grounded: 4, reference: 2 },
      higherMemories: { object: 1, ambient: 2 },
      vectorIndex: { status: "ready", indexedAssertions: 6, totalAssertions: 6 },
      objectExamples: ["对象甲", "对象乙"],
    });
    expect(result.library).toMatchObject({
      files: 4,
      folders: 2,
      uniqueContents: 3,
      duplicateFileNodes: 1,
      profiles: { catalog: 2, coarse: 1, deep: 1 },
      statuses: { idle: 0, queued: 1, running: 0, ready: 2, failed: 1 },
      sourceDocuments: 2,
      publishedContents: 2,
      failedCurrentRuns: 1,
    });
    expect(result.businessViews).toMatchObject({
      registered: 2,
      installed: 2,
      enabled: 1,
      incompatible: 1,
      totalCards: 3,
      views: [
        {
          viewKey: "alpha",
          status: "enabled",
          stateVersion: "4",
          cardCount: 2,
          higherMemory: false,
        },
        {
          viewKey: "beta",
          status: "incompatible",
          stateVersion: "2",
          cardCount: 1,
          higherMemory: true,
        },
      ],
    });
    expect(result.interpretation).toEqual(expect.objectContaining({
      inventoryCountsAreGlobalWithinScope: true,
      retrievalCountsAreNotInventoryCounts: true,
    }));
  });

  it("queries only requested layers and respects the current View boundary", async () => {
    const { database, registry, mocks } = fakeDependencies();
    const result = await inspectKnowledgeEnvironment(
      { layers: ["business_views"], includeExamples: false },
      {
        database,
        registry,
        canReadView: (viewKey) => viewKey === "alpha",
      },
    );

    expect(result.sharedBrain).toBeUndefined();
    expect(result.library).toBeUndefined();
    expect(result.businessViews?.registered).toBe(1);
    expect(result.businessViews?.views.map((view) => view.viewKey)).toEqual(["alpha"]);
    expect(mocks.database.memoryGlobalObject.count).not.toHaveBeenCalled();
    expect(mocks.database.libraryNode.groupBy).not.toHaveBeenCalled();
    expect(mocks.database.installedView.findMany).toHaveBeenCalledWith({
      where: { viewKey: { in: ["alpha"] } },
      select: { viewKey: true, status: true, stateVersion: true },
    });
  });
});
