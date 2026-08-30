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

/**
 * 重建 Shared Brain 的完整 Assertion 索引。
 * 资料库发布先原子替换来源记忆，再调用本函数；索引失败不会回滚已发布的可读 Assertion。
 */
export async function rebuildMemoryAssertionIndex(input: {
  onProgress?: (completed: number, total: number) => Promise<void> | void;
}): Promise<{ indexedAssertionCount: number; profile?: EmbeddingBatch }> {
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
  if (!assertions.length) {
    await database.$transaction([
      database.memoryAssertionEmbedding.deleteMany({
        where: {},
      }),
      database.memoryAssertionEmbeddingIndex.deleteMany(),
    ]);
    return { indexedAssertionCount: 0 };
  }

  const prepared: PreparedAssertion[] = assertions.map((assertion) => {
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
    const currentCount = await transaction.memoryAssertion.count();
    if (currentCount !== indexed.length) {
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
  return { indexedAssertionCount: indexed.length, profile };
}
