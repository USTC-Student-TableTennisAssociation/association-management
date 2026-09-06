import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({ database: undefined as unknown }));
const indexerState = vi.hoisted(() => ({
  corpus: {
    assertionCount: 2,
    revision: "corpus-revision",
  },
}));

vi.mock("@/db", () => ({ getDatabase: () => databaseState.database }));
vi.mock("@/memory/assertion-indexer", () => ({
  inspectMemoryAssertionCorpus: vi.fn(async () => indexerState.corpus),
  memoryAssertionCorpusRevision: vi.fn((rows: Array<{ assertionId: string; contentHash: string }>) =>
    rows.map((row) => `${row.assertionId}:${row.contentHash}`).sort().join("|") ===
        "a:1|b:2"
      ? "corpus-revision"
      : "different-revision"
  ),
  rebuildMemoryAssertionIndex: vi.fn(),
}));

import { reconcileMemoryAssertionIndexJob } from "@/memory/assertion-index-job";

describe("Assertion index durable reconciliation", () => {
  const upsert = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    databaseState.database = {
      memoryAssertionEmbeddingIndex: {
        findUnique: vi.fn().mockResolvedValue({ indexedAssertionCount: 2 }),
      },
      memoryAssertionEmbedding: {
        findMany: vi.fn().mockResolvedValue([
          { assertionId: "a", contentHash: "1" },
          { assertionId: "b", contentHash: "2" },
        ]),
      },
      memoryAssertionIndexJob: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert,
      },
    };
  });

  it("adopts a complete manually materialized index as ready", async () => {
    upsert.mockResolvedValue({
      status: "ready",
      targetRevision: "corpus-revision",
      indexedRevision: "corpus-revision",
      targetAssertionCount: 2,
      completedAssertionCount: 2,
      attemptCount: 0,
      errorMessage: null,
      nextAttemptAt: null,
    });

    await expect(reconcileMemoryAssertionIndexJob()).resolves.toMatchObject({
      status: "ready",
      completedAssertionCount: 2,
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        status: "ready",
        indexedRevision: "corpus-revision",
      }),
    }));
  });

  it("persists queued work when the vectors are missing", async () => {
    const database = databaseState.database as {
      memoryAssertionEmbeddingIndex: { findUnique: ReturnType<typeof vi.fn> };
      memoryAssertionEmbedding: { findMany: ReturnType<typeof vi.fn> };
    };
    database.memoryAssertionEmbeddingIndex.findUnique.mockResolvedValue(null);
    database.memoryAssertionEmbedding.findMany.mockResolvedValue([]);
    upsert.mockResolvedValue({
      status: "queued",
      targetRevision: "corpus-revision",
      indexedRevision: null,
      targetAssertionCount: 2,
      completedAssertionCount: 0,
      attemptCount: 0,
      errorMessage: null,
      nextAttemptAt: null,
    });

    await expect(reconcileMemoryAssertionIndexJob()).resolves.toMatchObject({
      status: "queued",
      targetAssertionCount: 2,
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "queued", targetAssertionCount: 2 }),
    }));
  });
});
