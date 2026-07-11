import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { handbookGuidelineLinks, handbookGuidelines } from "./handbook-guidance.data.js";
import { guidelineContentMatchesSeed, validateHandbookGuidance } from "./validate-handbook-guidance.js";

type VerificationIssue = {
  subject: string;
  message: string;
};

function linkKey(fromGuidelineId: string, toGuidelineId: string, relationType: string): string {
  return `${fromGuidelineId}:${toGuidelineId}:${relationType}`;
}

async function main(): Promise<void> {
  const validation = validateHandbookGuidance();
  if (validation.issues.length > 0) {
    throw new Error("种子静态校验未通过，拒绝验证数据库内容。");
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.startsWith("postgresql://") && !connectionString?.startsWith("postgres://")) {
    throw new Error("DATABASE_URL 必须是 PostgreSQL 连接地址，验证已取消。");
  }

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const guidelineIds = handbookGuidelines.map((item) => item.id);
    const [storedGuidelines, storedLinks] = await Promise.all([
      prisma.guideline.findMany({ where: { id: { in: guidelineIds } } }),
      prisma.guidelineLink.findMany({ where: { fromGuidelineId: { in: guidelineIds } } }),
    ]);

    const issues: VerificationIssue[] = [];
    const storedById = new Map(storedGuidelines.map((item) => [item.id, item]));

    handbookGuidelines.forEach((expected) => {
      const actual = storedById.get(expected.id);
      if (!actual) {
        issues.push({ subject: expected.title, message: "数据库中不存在该 Guideline" });
        return;
      }
      if (!guidelineContentMatchesSeed(actual, expected)) {
        issues.push({ subject: expected.title, message: "数据库内容与当前种子数据不一致" });
      }
      if (actual.status !== "draft" && actual.status !== "published") {
        issues.push({ subject: expected.title, message: `状态异常：${actual.status}` });
      }
    });

    const storedLinkMap = new Map(
      storedLinks.map((item) => [linkKey(item.fromGuidelineId, item.toGuidelineId, item.relationType), item]),
    );
    handbookGuidelineLinks.forEach((expected) => {
      const actual = storedLinkMap.get(
        linkKey(expected.fromGuidelineId, expected.toGuidelineId, expected.relationType),
      );
      if (!actual) {
        issues.push({ subject: expected.note, message: "数据库中不存在该连线" });
        return;
      }
      if (actual.note !== expected.note) {
        issues.push({ subject: expected.note, message: "连线备注与当前种子数据不一致" });
      }
    });

    if (issues.length > 0) {
      console.error(`数据库验证失败：${issues.length} 项问题`);
      issues.forEach((issue) => console.error(`- ${issue.subject}: ${issue.message}`));
      process.exitCode = 1;
      return;
    }

    const statusCounts = storedGuidelines.reduce<Record<string, number>>((counts, guideline) => {
      counts[guideline.status] = (counts[guideline.status] ?? 0) + 1;
      return counts;
    }, {});
    console.log(`数据库验证通过：${storedGuidelines.length} 条 Guideline，${handbookGuidelineLinks.length} 条目标连线。`);
    console.log(`- 状态分布：${Object.entries(statusCounts)
      .map(([status, count]) => `${status} ${count}`)
      .join("，")}`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`指导层数据库验证失败：${message}`);
  process.exitCode = 1;
});
