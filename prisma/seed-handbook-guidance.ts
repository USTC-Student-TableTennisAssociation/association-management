import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import {
  handbookGuidelineLinks,
  handbookGuidelines,
  type GuidelineLinkSeed,
  type GuidelineSeed,
} from "./handbook-guidance.data.js";
import { guidelineContentMatchesSeed, validateHandbookGuidance } from "./validate-handbook-guidance.js";

type ImportCounts = {
  guidelinesCreated: number;
  guidelinesUpdated: number;
  guidelinesSkipped: number;
  linksCreated: number;
  linksUpdated: number;
  linksSkipped: number;
  linksDeleted: number;
};

function emptyCounts(): ImportCounts {
  return {
    guidelinesCreated: 0,
    guidelinesUpdated: 0,
    guidelinesSkipped: 0,
    linksCreated: 0,
    linksUpdated: 0,
    linksSkipped: 0,
    linksDeleted: 0,
  };
}

function guidelineData(seed: GuidelineSeed) {
  return {
    title: seed.title,
    kind: seed.kind,
    contentMarkdown: seed.contentMarkdown,
    isMandatory: seed.isMandatory,
    appliesWhen: seed.appliesWhen as Prisma.InputJsonValue,
    suggestedActions: seed.suggestedActions as Prisma.InputJsonValue,
    basisNote: seed.basisNote,
    status: seed.status,
  };
}

function linkWhere(
  link: Pick<GuidelineLinkSeed, "fromGuidelineId" | "toGuidelineId" | "relationType">,
) {
  return {
    fromGuidelineId_toGuidelineId_relationType: {
      fromGuidelineId: link.fromGuidelineId,
      toGuidelineId: link.toGuidelineId,
      relationType: link.relationType,
    },
  };
}

function linkKey(
  link: Pick<GuidelineLinkSeed, "fromGuidelineId" | "toGuidelineId" | "relationType">,
): string {
  return `${link.fromGuidelineId}:${link.toGuidelineId}:${link.relationType}`;
}

async function runImport(dryRun: boolean): Promise<ImportCounts> {
  const validation = validateHandbookGuidance();
  if (validation.issues.length > 0) {
    throw new Error(`静态校验未通过：${validation.issues.map((item) => item.message).join("；")}`);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.startsWith("postgresql://") && !connectionString?.startsWith("postgres://")) {
    throw new Error("DATABASE_URL 必须是 PostgreSQL 连接地址，导入已取消。");
  }

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    return await prisma.$transaction(async (tx) => {
      const counts = emptyCounts();

      for (const guideline of handbookGuidelines) {
        const existing = await tx.guideline.findUnique({ where: { id: guideline.id } });

        if (!existing) {
          counts.guidelinesCreated += 1;
          if (!dryRun) {
            await tx.guideline.create({ data: { id: guideline.id, ...guidelineData(guideline) } });
          }
          continue;
        }

        const matches = guidelineContentMatchesSeed(existing, guideline);
        if (existing.status === "published") {
          if (!matches) {
            throw new Error(`已发布的 Guideline ${guideline.id} 与手册种子内容不同，拒绝覆盖人工审核结果。`);
          }
          counts.guidelinesSkipped += 1;
          continue;
        }

        if (matches) {
          counts.guidelinesSkipped += 1;
          continue;
        }

        counts.guidelinesUpdated += 1;
        if (!dryRun) {
          await tx.guideline.update({ where: { id: guideline.id }, data: guidelineData(guideline) });
        }
      }

      const managedGuidelineIds = handbookGuidelines.map((guideline) => guideline.id);
      const desiredLinkKeys = new Set(handbookGuidelineLinks.map(linkKey));
      const existingManagedLinks = await tx.guidelineLink.findMany({
        where: {
          fromGuidelineId: { in: managedGuidelineIds },
          toGuidelineId: { in: managedGuidelineIds },
        },
        include: {
          fromGuideline: { select: { status: true } },
          toGuideline: { select: { status: true } },
        },
      });

      // 仅同步两个端点均为 draft 的种子连线：已发布的人工审核内容不删除。
      for (const existingLink of existingManagedLinks) {
        if (
          desiredLinkKeys.has(linkKey(existingLink)) ||
          existingLink.fromGuideline.status !== "draft" ||
          existingLink.toGuideline.status !== "draft"
        ) {
          continue;
        }

        counts.linksDeleted += 1;
        if (!dryRun) {
          await tx.guidelineLink.delete({ where: linkWhere(existingLink) });
        }
      }

      for (const link of handbookGuidelineLinks) {
        const existing = await tx.guidelineLink.findUnique({ where: linkWhere(link) });
        if (!existing) {
          counts.linksCreated += 1;
          if (!dryRun) {
            await tx.guidelineLink.create({ data: link });
          }
          continue;
        }

        if (existing.note === link.note) {
          counts.linksSkipped += 1;
          continue;
        }

        counts.linksUpdated += 1;
        if (!dryRun) {
          await tx.guidelineLink.update({ where: linkWhere(link), data: { note: link.note } });
        }
      }

      return counts;
    });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

function printCounts(counts: ImportCounts, dryRun: boolean): void {
  console.log(`${dryRun ? "演练" : "导入"}完成：`);
  console.log(
    `- Guideline：新建 ${counts.guidelinesCreated}，更新 ${counts.guidelinesUpdated}，跳过 ${counts.guidelinesSkipped}`,
  );
  console.log(
    `- 连线：新建 ${counts.linksCreated}，更新 ${counts.linksUpdated}，删除 ${counts.linksDeleted}，跳过 ${counts.linksSkipped}`,
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const counts = await runImport(dryRun);
  printCounts(counts, dryRun);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`指导层手册导入失败：${message}`);
  process.exitCode = 1;
});
