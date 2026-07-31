import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { Prisma, PrismaClient } from "../src/generated/prisma/client.js";

type CardKind =
  | "activity_pattern"
  | "activity_trait"
  | "person"
  | "role"
  | "historical_event"
  | "workflow"
  | "work_step"
  | "rule"
  | "principle"
  | "practice"
  | "archive_record";

type Card = {
  card_id: string;
  kind: CardKind;
  title: string;
  summary: string;
  content: Record<string, string | null>;
  evidence_ids: string[];
};

type Edge = {
  edge_id: string;
  from_card_id: string;
  to_card_id: string;
  context_card_id: string | null;
  relation_type: Prisma.MemoryEdgeCreateInput["relationType"];
  sequence: number | null;
  temporal_scope_markdown: string | null;
  note_markdown: string | null;
  evidence_ids: string[];
};

type Evidence = {
  evidence_id: string;
  start_block_id: string;
  end_block_id: string;
  role: Prisma.MemoryNodeSourceCreateInput["role"];
  note_markdown: string;
};

type Snapshot = {
  schema_version: string;
  status: string;
  source: {
    path: string;
    title: string;
    sha256: string;
    page_count: number;
    block_count: number;
  };
  root_subgraph: {
    cards: Card[];
    edges: Edge[];
    evidence: Evidence[];
    unresolved_issues: unknown[];
  } | null;
};

type ParsedBlock = {
  block_id: string;
  source_pages: number[];
  heading_path: string[];
  markdown: string;
};

type Arguments = {
  input: string;
  validateOnly: boolean;
};

function parseArguments(argv: string[]): Arguments {
  let input = "";
  let validateOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input") {
      input = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--validate-only") {
      validateOnly = true;
    } else {
      throw new Error(`未知参数：${argv[index]}`);
    }
  }
  if (!input) {
    throw new Error("缺少 --input <parent-integration.json>");
  }
  return { input: path.resolve(input), validateOnly };
}

async function findParsedBlocks(input: string): Promise<string> {
  let directory = path.dirname(input);
  while (true) {
    const candidate = path.join(directory, "parsed-blocks.json");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error("无法从整合产物向上找到 parsed-blocks.json");
      }
      directory = parent;
    }
  }
}

function assertSnapshot(value: unknown): asserts value is Snapshot {
  if (!value || typeof value !== "object") {
    throw new Error("parent-integration.json 不是 JSON 对象");
  }
  const snapshot = value as Partial<Snapshot>;
  if (snapshot.schema_version !== "parent-integration.v1") {
    throw new Error(`不支持的父节点整合版本：${snapshot.schema_version ?? "缺失"}`);
  }
  if (snapshot.status !== "complete" || !snapshot.root_subgraph) {
    throw new Error("父节点整合尚未完成，拒绝写入数据库");
  }
  const graph = snapshot.root_subgraph;
  if (
    !Array.isArray(graph.cards) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.evidence) ||
    !Array.isArray(graph.unresolved_issues)
  ) {
    throw new Error("根节点候选图结构不完整");
  }
  if (!snapshot.source?.sha256 || !snapshot.source.block_count) {
    throw new Error("父节点整合缺少来源文件信息");
  }
}

function uniqueMap<T>(items: T[], id: (item: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = id(item);
    if (!key || result.has(key)) {
      throw new Error(`${label} ID 缺失或重复：${key}`);
    }
    result.set(key, item);
  }
  return result;
}

function validateGraph(snapshot: Snapshot, blocks: ParsedBlock[]): void {
  const graph = snapshot.root_subgraph;
  if (!graph) {
    throw new Error("根节点候选图不存在");
  }
  if (blocks.length !== snapshot.source.block_count) {
    throw new Error("parsed-blocks.json 与父节点整合的原文块数量不一致");
  }
  const cards = uniqueMap(graph.cards, (item) => item.card_id, "卡片");
  const edges = uniqueMap(graph.edges, (item) => item.edge_id, "边");
  const evidence = uniqueMap(graph.evidence, (item) => item.evidence_id, "依据");
  const blockIds = new Set(blocks.map((item) => item.block_id));
  const positions = new Map(blocks.map((block, index) => [block.block_id, index]));
  for (const card of cards.values()) {
    nodeData(card, randomUUID());
    for (const evidenceId of card.evidence_ids) {
      if (!evidence.has(evidenceId)) {
        throw new Error(`${card.card_id} 引用了不存在的依据 ${evidenceId}`);
      }
    }
  }
  for (const edge of edges.values()) {
    for (const cardId of [edge.from_card_id, edge.to_card_id, edge.context_card_id]) {
      if (cardId && !cards.has(cardId)) {
        throw new Error(`${edge.edge_id} 引用了不存在的卡片 ${cardId}`);
      }
    }
    for (const evidenceId of edge.evidence_ids) {
      if (!evidence.has(evidenceId)) {
        throw new Error(`${edge.edge_id} 引用了不存在的依据 ${evidenceId}`);
      }
    }
  }
  for (const item of evidence.values()) {
    if (!blockIds.has(item.start_block_id) || !blockIds.has(item.end_block_id)) {
      throw new Error(`${item.evidence_id} 引用了不存在的原文块`);
    }
    evidenceRange(item, blocks, positions);
  }
}

function requiredContent(card: Card, key: string): string {
  const value = card.content[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${card.card_id} 缺少 ${card.kind}.${key}`);
  }
  return value;
}

function optionalContent(card: Card, key: string): string | null {
  const value = card.content[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function nodeData(card: Card, nodeId: string): Prisma.MemoryNodeCreateInput {
  const base = {
    id: nodeId,
    kind: card.kind,
    title: card.title,
    summary: card.summary,
    status: "draft" as const,
  };
  switch (card.kind) {
    case "activity_pattern":
      return {
        ...base,
        activityPattern: {
          create: {
            descriptionMarkdown: requiredContent(card, "description_markdown"),
            purposeMarkdown: optionalContent(card, "purpose_markdown"),
            recurrenceKind: requiredContent(card, "recurrence_kind") as
              Prisma.MemoryActivityPatternCreateInput["recurrenceKind"],
            typicalTimingMarkdown: optionalContent(card, "typical_timing_markdown"),
            identityBoundaryMarkdown: optionalContent(card, "identity_boundary_markdown"),
          },
        },
      };
    case "activity_trait":
      return {
        ...base,
        activityTrait: {
          create: {
            dimension: requiredContent(card, "dimension") as
              Prisma.MemoryActivityTraitCreateInput["dimension"],
            code: requiredContent(card, "code"),
            definitionMarkdown: requiredContent(card, "definition_markdown"),
          },
        },
      };
    case "person":
      return {
        ...base,
        person: {
          create: {
            identityMarkdown: requiredContent(card, "identity_markdown"),
            disambiguationMarkdown: optionalContent(card, "disambiguation_markdown"),
          },
        },
      };
    case "role":
      return {
        ...base,
        role: {
          create: {
            definitionMarkdown: requiredContent(card, "definition_markdown"),
            boundaryMarkdown: optionalContent(card, "boundary_markdown"),
            uncertaintyMarkdown: optionalContent(card, "uncertainty_markdown"),
          },
        },
      };
    case "historical_event":
      return {
        ...base,
        historicalEvent: {
          create: {
            eventMarkdown: requiredContent(card, "event_markdown"),
            timeMarkdown: optionalContent(card, "time_markdown"),
            backgroundMarkdown: optionalContent(card, "background_markdown"),
            outcomeMarkdown: optionalContent(card, "outcome_markdown"),
            significanceMarkdown: optionalContent(card, "significance_markdown"),
            uncertaintyMarkdown: optionalContent(card, "uncertainty_markdown"),
          },
        },
      };
    case "workflow":
      return {
        ...base,
        workflow: {
          create: {
            goalMarkdown: requiredContent(card, "goal_markdown"),
            entryMeaningMarkdown: requiredContent(card, "entry_meaning_markdown"),
          },
        },
      };
    case "work_step":
      return {
        ...base,
        workStep: {
          create: {
            objectiveMarkdown: requiredContent(card, "objective_markdown"),
            instructionMarkdown: requiredContent(card, "instruction_markdown"),
            completionMeaningMarkdown: requiredContent(card, "completion_meaning_markdown"),
          },
        },
      };
    case "rule":
      return {
        ...base,
        rule: {
          create: {
            statementMarkdown: requiredContent(card, "statement_markdown"),
            rationaleMarkdown: optionalContent(card, "rationale_markdown"),
            violationImpactMarkdown: optionalContent(card, "violation_impact_markdown"),
          },
        },
      };
    case "principle":
      return {
        ...base,
        principle: {
          create: {
            statementMarkdown: requiredContent(card, "statement_markdown"),
            rationaleMarkdown: requiredContent(card, "rationale_markdown"),
            tradeoffMarkdown: optionalContent(card, "tradeoff_markdown"),
          },
        },
      };
    case "practice":
      return {
        ...base,
        practice: {
          create: {
            situationMarkdown: requiredContent(card, "situation_markdown"),
            behaviorMarkdown: requiredContent(card, "behavior_markdown"),
            outcomeMarkdown: optionalContent(card, "outcome_markdown"),
            lessonMarkdown: requiredContent(card, "lesson_markdown"),
            uncertaintyMarkdown: optionalContent(card, "uncertainty_markdown"),
          },
        },
      };
    case "archive_record":
      return {
        ...base,
        archiveRecord: {
          create: {
            contentOverviewMarkdown: requiredContent(card, "content_overview_markdown"),
            provenanceMarkdown: optionalContent(card, "provenance_markdown"),
            integrityMarkdown: optionalContent(card, "integrity_markdown"),
          },
        },
      };
  }
}

function evidenceRange(
  item: Evidence,
  blocks: ParsedBlock[],
  positions: Map<string, number>,
): ParsedBlock[] {
  const start = positions.get(item.start_block_id);
  const end = positions.get(item.end_block_id);
  if (start === undefined || end === undefined || end < start) {
    throw new Error(`${item.evidence_id} 的原文范围无效`);
  }
  return blocks.slice(start, end + 1);
}

function commonHeadingPath(blocks: ParsedBlock[]): string | null {
  const paths = blocks.map((block) => block.heading_path);
  const common: string[] = [];
  for (let index = 0; ; index += 1) {
    const value = paths[0]?.[index];
    if (!value || paths.some((item) => item[index] !== value)) {
      break;
    }
    common.push(value);
  }
  return common.length ? common.join(" > ") : null;
}

async function importGraph(
  snapshot: Snapshot,
  blocks: ParsedBlock[],
  input: string,
): Promise<string> {
  const graph = snapshot.root_subgraph;
  if (!graph) {
    throw new Error("根节点候选图不存在");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.startsWith("postgresql://") && !connectionString?.startsWith("postgres://")) {
    throw new Error("DATABASE_URL 必须是 PostgreSQL 连接地址");
  }

  const cardIds = new Map(graph.cards.map((card) => [card.card_id, randomUUID()]));
  const edgeIds = new Map(graph.edges.map((edge) => [edge.edge_id, randomUUID()]));
  const evidenceById = uniqueMap(graph.evidence, (item) => item.evidence_id, "依据");
  const usedEvidenceIds = new Set([
    ...graph.cards.flatMap((card) => card.evidence_ids),
    ...graph.edges.flatMap((edge) => edge.evidence_ids),
  ]);
  const anchorIds = new Map([...usedEvidenceIds].map((id) => [id, randomUUID()]));
  const positions = new Map(blocks.map((block, index) => [block.block_id, index]));
  const sourceAssetRef = `sha256:${snapshot.source.sha256}`;
  const sourceAnchors = [...usedEvidenceIds].map((evidenceId) => {
    const item = evidenceById.get(evidenceId)!;
    const sourceBlocks = evidenceRange(item, blocks, positions);
    const pages = sourceBlocks.flatMap((block) => block.source_pages);
    const excerpt = sourceBlocks.map((block) => block.markdown).join("\n\n");
    return {
      id: anchorIds.get(evidenceId)!,
      sourceAssetRef,
      pageStart: Math.min(...pages),
      pageEnd: Math.max(...pages),
      sectionPath: commonHeadingPath(sourceBlocks),
      startBlockId: item.start_block_id,
      endBlockId: item.end_block_id,
      excerpt,
      excerptHash: createHash("sha256").update(excerpt).digest("hex"),
    };
  });
  const nodeSources = graph.cards.flatMap((card) =>
    [...new Set(card.evidence_ids)].map((evidenceId) => {
      const evidence = evidenceById.get(evidenceId)!;
      return {
        id: randomUUID(),
        nodeId: cardIds.get(card.card_id)!,
        sourceAnchorId: anchorIds.get(evidenceId)!,
        role: evidence.role,
        noteMarkdown: evidence.note_markdown,
      };
    }),
  );
  const edges = graph.edges.map((edge) => ({
    id: edgeIds.get(edge.edge_id)!,
    fromNodeId: cardIds.get(edge.from_card_id)!,
    toNodeId: cardIds.get(edge.to_card_id)!,
    contextNodeId: edge.context_card_id ? cardIds.get(edge.context_card_id)! : null,
    relationType: edge.relation_type,
    sequence: edge.sequence,
    temporalScopeMarkdown: edge.temporal_scope_markdown,
    noteMarkdown: edge.note_markdown,
    status: "draft" as const,
  }));
  const edgeSources = graph.edges.flatMap((edge) =>
    [...new Set(edge.evidence_ids)].map((evidenceId) => {
      const evidence = evidenceById.get(evidenceId)!;
      return {
        id: randomUUID(),
        edgeId: edgeIds.get(edge.edge_id)!,
        sourceAnchorId: anchorIds.get(evidenceId)!,
        role: evidence.role,
        noteMarkdown: evidence.note_markdown,
      };
    }),
  );
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    await prisma.$transaction(
      async (transaction) => {
        for (const card of graph.cards) {
          await transaction.memoryNode.create({
            data: nodeData(card, cardIds.get(card.card_id)!),
          });
        }
        if (sourceAnchors.length) {
          await transaction.memorySourceAnchor.createMany({ data: sourceAnchors });
        }
        if (nodeSources.length) {
          await transaction.memoryNodeSource.createMany({ data: nodeSources });
        }
        if (edges.length) {
          await transaction.memoryEdge.createMany({ data: edges });
        }
        if (edgeSources.length) {
          await transaction.memoryEdgeSource.createMany({ data: edgeSources });
        }
      },
      { maxWait: 30_000, timeout: 300_000 },
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }

  const reportPath = path.join(path.dirname(input), "database-import.json");
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        schema_version: "database-import.v1",
        created_at: new Date().toISOString(),
        source_sha256: snapshot.source.sha256,
        source_asset_ref: sourceAssetRef,
        status: "committed",
        counts: {
          nodes: graph.cards.length,
          edges: graph.edges.length,
          source_anchors: anchorIds.size,
          unresolved_issues: graph.unresolved_issues.length,
        },
        node_ids: [...cardIds].map(([candidate_card_id, database_node_id]) => ({
          candidate_card_id,
          database_node_id,
        })),
        edge_ids: [...edgeIds].map(([candidate_edge_id, database_edge_id]) => ({
          candidate_edge_id,
          database_edge_id,
        })),
        source_anchor_ids: [...anchorIds].map(([evidence_id, database_source_anchor_id]) => ({
          evidence_id,
          database_source_anchor_id,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  return reportPath;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const blocksPath = await findParsedBlocks(args.input);
  const snapshot = JSON.parse(await readFile(args.input, "utf8")) as unknown;
  assertSnapshot(snapshot);
  const blocks = JSON.parse(await readFile(blocksPath, "utf8")) as ParsedBlock[];
  validateGraph(snapshot, blocks);
  const graph = snapshot.root_subgraph!;
  console.log(
    `导入输入验证通过：${graph.cards.length} 张卡片，${graph.edges.length} 条边，` +
      `${graph.evidence.length} 项来源依据，${graph.unresolved_issues.length} 个未决问题。`,
  );
  if (args.validateOnly) {
    return;
  }
  const reportPath = await importGraph(snapshot, blocks, args.input);
  console.log(`数据库事务已提交，导入报告：${reportPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`冷启动数据库导入失败：${message}`);
  process.exitCode = 1;
});
