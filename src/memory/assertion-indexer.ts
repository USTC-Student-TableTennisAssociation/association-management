import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { getDatabase } from "@/db";
import { embedMemoryQueries, type EmbeddingBatch } from "@/memory/embedding-client";
import { renderResolvedAssertion } from "@/memory/resolved-assertion";

type PreparedAssertion = {
  assertionId: string;
  contentHash: string;
  renderedText: string;
};

export type MemoryAssertionCorpus = {
  assertionCount: number;
  revision: string;
};

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function sameProfile(left: EmbeddingBatch, right: EmbeddingBatch): boolean {
  return left.model === right.model &&
    left.modelRevision === right.modelRevision &&
    left.dimension === right.dimension;
}

export function memoryAssertionCorpusRevision(
  assertions: ReadonlyArray<Pick<PreparedAssertion, "assertionId" | "contentHash">>,
): string {
  const digest = createHash("sha256");
  for (const assertion of [...assertions].sort((left, right) =>
    left.assertionId.localeCompare(right.assertionId)
  )) {
    digest.update(assertion.assertionId.length.toString());
    digest.update(":");
    digest.update(assertion.assertionId);
    digest.update(":");
    digest.update(assertion.contentHash);
    digest.update("\n");
  }
  return digest.digest("hex");
}

async function loadPreparedAssertions(): Promise<PreparedAssertion[]> {
  const database = getDatabase();
  const assertions = await database.memoryAssertion.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      globalStatementTemplateMarkdown: true,
      objectLinks: {
        orderBy: { globalObjectId: "asc" },
        select: {
          globalObject: { select: { id: true, canonicalName: true } },
        },
      },
    },
  });
  return assertions.map((assertion) => {
    const references = assertion.objectLinks.map(({ globalObject }) => ({
      globalObjectId: globalObject.id,
      canonicalName: globalObject.canonicalName,
    }));
    const renderedText = renderResolvedAssertion({
      globalStatementTemplateMarkdown: assertion.globalStatementTemplateMarkdown,
      references,
      assertionKey: assertion.id,
    });
    return {
      assertionId: assertion.id,
      renderedText,
      contentHash: createHash("sha256").update(renderedText, "utf8").digest("hex"),
    };
  });
}

export async function inspectMemoryAssertionCorpus(): Promise<MemoryAssertionCorpus> {
  const assertions = await loadPreparedAssertions();
  return {
    assertionCount: assertions.length,
    revision: memoryAssertionCorpusRevision(assertions),
  };
}

/**
 * 重建 Shared Brain 的完整 Assertion 索引。
 * 资料库发布先原子替换来源记忆，再由持久化任务调用本函数；
 * 索引失败不会回滚已发布的可读 Assertion，成功时才原子替换整份向量。
 */
export async function rebuildMemoryAssertionIndex(input: {
  onProgress?: (completed: number, total: number) => Promise<void> | void;
}): Promise<{
  indexedAssertionCount: number;
  revision: string;
  profile?: EmbeddingBatch;
}> {
  const database = getDatabase();
  const prepared = await loadPreparedAssertions();
  const revision = memoryAssertionCorpusRevision(prepared);
  if (!prepared.length) {
    await database.$transaction([
      database.memoryAssertionEmbedding.deleteMany({
        where: {},
      }),
      database.memoryAssertionEmbeddingIndex.deleteMany(),
    ]);
    return { indexedAssertionCount: 0, revision };
  }

  const batchSize = positiveIntegerEnvironment("MEMORY_EMBEDDING_BATCH_SIZE", 64);
  const timeoutMs = positiveIntegerEnvironment("MEMORY_EMBEDDING_TIMEOUT_MS", 120_000);
  let profile: EmbeddingBatch | undefined;
  const indexed: Array<PreparedAssertion & { vector: number[] }> = [];
  for (let start = 0; start < prepared.length; start += batchSize) {
    const batch = prepared.slice(start, start + batchSize);
    const response = await embedMemoryQueries(
      batch.map((item) => item.renderedText),
      { timeoutMs },
    );
    if (profile && !sameProfile(profile, response)) {
      throw new Error("同一次 Assertion 索引收到了不一致的 embedding profile");
    }
    profile ??= response;
    indexed.push(...batch.map((item, index) => ({
      ...item,
      vector: response.vectors[index],
    })));
    await input.onProgress?.(Math.min(start + batch.length, prepared.length), prepared.length);
  }
  if (!profile || indexed.length !== prepared.length) {
    throw new Error("Assertion embedding 未完整生成");
  }

  await database.$transaction(async (transaction) => {
    const currentAssertions = await transaction.memoryAssertion.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        globalStatementTemplateMarkdown: true,
        objectLinks: {
          orderBy: { globalObjectId: "asc" },
          select: {
            globalObject: { select: { id: true, canonicalName: true } },
          },
        },
      },
    });
    const currentRevision = memoryAssertionCorpusRevision(currentAssertions.map((assertion) => {
      const renderedText = renderResolvedAssertion({
        globalStatementTemplateMarkdown: assertion.globalStatementTemplateMarkdown,
        references: assertion.objectLinks.map(({ globalObject }) => ({
          globalObjectId: globalObject.id,
          canonicalName: globalObject.canonicalName,
        })),
        assertionKey: assertion.id,
      });
      return {
        assertionId: assertion.id,
        contentHash: createHash("sha256").update(renderedText, "utf8").digest("hex"),
      };
    }));
    if (currentRevision !== revision) {
      throw new Error("生成 embedding 期间 Shared Brain Assertion 已改变");
    }
    await transaction.memoryAssertionEmbedding.deleteMany();
    await transaction.memoryAssertionEmbeddingIndex.deleteMany();
    for (let start = 0; start < indexed.length; start += 64) {
      const values = indexed.slice(start, start + 64).map((item) =>
        Prisma.sql`(${item.assertionId}::uuid, ${item.contentHash}, ${vectorLiteral(item.vector)}::vector)`
      );
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "memory_assertion_embeddings" ("assertion_id", "content_hash", "embedding")
        VALUES ${Prisma.join(values)}
      `);
    }
    await transaction.memoryAssertionEmbeddingIndex.create({
      data: {
        id: "shared",
        modelKey: profile.model,
        modelRevision: profile.modelRevision,
        dimension: profile.dimension,
        indexedAssertionCount: indexed.length,
      },
    });
  }, { maxWait: 30_000, timeout: 300_000 });
  return { indexedAssertionCount: indexed.length, revision, profile };
}
