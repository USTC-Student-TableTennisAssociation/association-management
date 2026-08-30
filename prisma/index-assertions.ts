import "dotenv/config";

import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { embedMemoryQueries, type EmbeddingBatch } from "../src/memory/embedding-client.js";
import { renderResolvedAssertion } from "../src/memory/resolved-assertion.js";

type PreparedAssertion = {
  assertionId: string;
  contentHash: string;
  renderedText: string;
};

type IndexedAssertion = PreparedAssertion & {
  vector: number[];
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function sameProfile(left: EmbeddingBatch, right: EmbeddingBatch): boolean {
  return (
    left.model === right.model &&
    left.modelRevision === right.modelRevision &&
    left.dimension === right.dimension
  );
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (
    !connectionString?.startsWith("postgresql://") &&
    !connectionString?.startsWith("postgres://")
  ) {
    throw new Error("DATABASE_URL 必须是 PostgreSQL 连接地址");
  }

  const batchSize = positiveIntegerEnvironment("MEMORY_EMBEDDING_BATCH_SIZE", 64);
  const timeoutMs = positiveIntegerEnvironment("MEMORY_EMBEDDING_TIMEOUT_MS", 120_000);
  const pool = new Pool({ connectionString });
  const database = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const assertions = await database.memoryAssertion.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        sourceClaimId: true,
        globalStatementTemplateMarkdown: true,
        sourceRegion: { select: { sourceNodeId: true } },
        objectLinks: {
          orderBy: { globalObjectId: "asc" },
          select: {
            globalObject: { select: { id: true, canonicalName: true } },
          },
        },
      },
    });
    if (assertions.length === 0) throw new Error("Shared Brain 没有 Assertion，无法建立向量索引");

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
        contentHash: sha256(renderedText),
        renderedText,
      };
    });

    console.log(`准备索引 Shared Brain 的 ${prepared.length} 条 Assertion`);
    let profile: EmbeddingBatch | undefined;
    const indexed: IndexedAssertion[] = [];
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
      indexed.push(
        ...batch.map((item, index) => ({
          ...item,
          vector: response.vectors[index],
        })),
      );
      console.log(`BGE-M3：${Math.min(start + batch.length, prepared.length)}/${prepared.length}`);
    }
    if (!profile || indexed.length !== prepared.length) {
      throw new Error("Assertion embedding 未完整生成，数据库保持不变");
    }

    await database.$transaction(
      async (transaction) => {
        const currentAssertionCount = await transaction.memoryAssertion.count();
        if (currentAssertionCount !== indexed.length) {
          throw new Error("生成 embedding 期间 Shared Brain Assertion 已改变，拒绝写入过期索引");
        }

        await transaction.memoryAssertionEmbedding.deleteMany();
        await transaction.memoryAssertionEmbeddingIndex.deleteMany();
        for (let start = 0; start < indexed.length; start += 64) {
          const values = indexed.slice(start, start + 64).map((item) =>
            Prisma.sql`(${item.assertionId}::uuid, ${item.contentHash}, ${vectorLiteral(item.vector)}::vector)`,
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
      },
      { maxWait: 30_000, timeout: 300_000 },
    );
    console.log(
      `Assertion 索引已提交：${indexed.length} 条，` +
        `${profile.model}@${profile.modelRevision}/${profile.dimension}`,
    );
  } finally {
    await database.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(`Assertion 索引失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
