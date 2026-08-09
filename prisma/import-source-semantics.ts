import "dotenv/config";

import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { Prisma, PrismaClient } from "../src/generated/prisma/client.js";

type SourceMetadata = {
  path: string;
  title: string;
  sha256: string;
  parser: string;
  page_count: number;
  block_count: number;
};

type TemporalAnnotation = {
  raw_expression: string;
  kind: "point" | "range" | "recurring" | "relative" | "contextual" | "unknown";
  normalized_text: string;
  start: string | null;
  end: string | null;
  precision: "day" | "month" | "year" | "academic_year" | "semester" | "unspecified";
  derivation: "source_explicit" | "contextual_inference" | "unresolved";
  basis_markdown: string;
};

type SourceAssertion = {
  claim_id: string;
  statement_template_markdown: string;
  supporting_block_ids: string[];
  temporal_annotations: TemporalAnnotation[];
};

type SourceObject = {
  object_id: string;
  label: string;
  aliases: string[];
};

type SourceObjectMention = {
  claim_id: string;
  span_text: string;
  occurrence_index: number;
  mention_id: string;
  object_id: string;
  start: number;
  end: number;
};

type SourceRegion = {
  schema_version: "source-semantics.v4";
  created_at: string;
  source: SourceMetadata;
  region_tree_schema_version: string;
  region_node_id: string;
  label: string;
  lineage_node_ids: string[];
  source_pages: number[];
  source_block_ids: string[];
  covered_block_ids: string[];
  unclaimed_block_ids: string[];
  initial_claim_count: number;
  review_addition_count: number;
  assertions: SourceAssertion[];
  objects: SourceObject[];
  object_mentions: SourceObjectMention[];
  model_calls: number;
};

type Snapshot = {
  schema_version: "source-semantics-full.v4";
  created_at: string;
  source: SourceMetadata;
  region_tree_schema_version: string;
  source_node_ids: string[];
  sources: SourceRegion[];
  total_assertions: number;
  total_objects: number;
  total_object_mentions: number;
  model_calls: number;
};

type ParsedBlock = {
  block_id: string;
  order: number;
  block_type: string;
  source_pages: number[];
  heading_level: number | null;
  heading_path: string[];
  source_type: string | null;
  source_sub_type: string | null;
  bbox: number[] | null;
  asset_path: string | null;
  markdown: string;
};

type Arguments = { input: string; validateOnly: boolean };

const OBJECT_REFERENCE_PATTERN = /\{\{object:([^{}]+)\}\}/g;
const TEMPORAL_KINDS = new Set(["point", "range", "recurring", "relative", "contextual", "unknown"]);
const TEMPORAL_PRECISIONS = new Set(["day", "month", "year", "academic_year", "semester", "unspecified"]);
const TEMPORAL_DERIVATIONS = new Set(["source_explicit", "contextual_inference", "unresolved"]);

function parseArguments(argv: string[]): Arguments {
  let input = "";
  let validateOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--input") {
      input = argv[index + 1] ?? "";
      index += 1;
    } else if (argument === "--validate-only") {
      validateOnly = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (!input) throw new Error("缺少 --input <source-semantics-full.json 或完整编译目录>");
  return { input: path.resolve(input), validateOnly };
}

async function resolveInput(input: string): Promise<string> {
  const info = await stat(input);
  return info.isDirectory() ? path.join(input, "source-semantics-full.json") : input;
}

async function findParsedBlocks(input: string): Promise<string> {
  let directory = path.dirname(input);
  while (true) {
    const candidate = path.join(directory, "parsed-blocks.json");
    try {
      await stat(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error("无法从来源语义产物向上找到 parsed-blocks.json");
      directory = parent;
    }
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function integerValue(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`${label} 必须是不小于 ${minimum} 的整数`);
  return value as number;
}

function enumValue(value: unknown, allowed: Set<string>, label: string): string {
  if (typeof value !== "string" || !allowed.has(value)) throw new Error(`${label} 不是允许的枚举值`);
  return value;
}

function stringArray(value: unknown, label: string, allowEmpty = true): string[] {
  const result = arrayValue(value, label);
  if (!allowEmpty && !result.length) throw new Error(`${label} 不能为空`);
  if (result.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} 必须是非空字符串数组`);
  return result as string[];
}

function integerArray(value: unknown, label: string, minimum = 0): number[] {
  const result = arrayValue(value, label);
  if (result.some((item) => !Number.isInteger(item) || (item as number) < minimum)) throw new Error(`${label} 包含无效整数`);
  return result as number[];
}

function numberArray(value: unknown, label: string): number[] {
  const result = arrayValue(value, label);
  if (result.some((item) => typeof item !== "number" || !Number.isFinite(item))) throw new Error(`${label} 包含无效数值`);
  return result as number[];
}

function unique<T>(values: T[], label: string): T[] {
  if (new Set(values).size !== values.length) throw new Error(`${label} 包含重复项`);
  return values;
}

function sameSource(left: SourceMetadata, right: SourceMetadata): boolean {
  return left.path === right.path && left.title === right.title && left.sha256 === right.sha256 &&
    left.parser === right.parser && left.page_count === right.page_count && left.block_count === right.block_count;
}

function validateSourceMetadata(value: unknown, label: string): SourceMetadata {
  const source = objectValue(value, label);
  return {
    path: stringValue(source.path, `${label}.path`),
    title: stringValue(source.title, `${label}.title`),
    sha256: stringValue(source.sha256, `${label}.sha256`),
    parser: stringValue(source.parser, `${label}.parser`),
    page_count: integerValue(source.page_count, `${label}.page_count`, 1),
    block_count: integerValue(source.block_count, `${label}.block_count`, 1),
  };
}

function parseAbsoluteTime(value: string, label: string, upperBound = false): number[] {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) throw new Error(`${label} 只允许 YYYY、YYYY-MM 或 YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : upperBound ? 12 : 1;
  const day = match[3] ? Number(match[3]) : upperBound ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 1;
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new Error(`${label} 不是有效日期`);
  }
  return [year, month, day];
}

function compareTimeParts(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function validateTemporal(value: unknown, label: string, groundingTexts: string[]): TemporalAnnotation {
  const item = objectValue(value, label);
  const result = {
    raw_expression: stringValue(item.raw_expression, `${label}.raw_expression`),
    kind: enumValue(item.kind, TEMPORAL_KINDS, `${label}.kind`) as TemporalAnnotation["kind"],
    normalized_text: stringValue(item.normalized_text, `${label}.normalized_text`),
    start: nullableString(item.start, `${label}.start`),
    end: nullableString(item.end, `${label}.end`),
    precision: enumValue(item.precision, TEMPORAL_PRECISIONS, `${label}.precision`) as TemporalAnnotation["precision"],
    derivation: enumValue(item.derivation, TEMPORAL_DERIVATIONS, `${label}.derivation`) as TemporalAnnotation["derivation"],
    basis_markdown: stringValue(item.basis_markdown, `${label}.basis_markdown`),
  };
  const start = result.start ? parseAbsoluteTime(result.start, `${label}.start`) : null;
  const end = result.end ? parseAbsoluteTime(result.end, `${label}.end`, true) : null;
  if (start && end && compareTimeParts(start, end) > 0) throw new Error(`${label}.start 不能晚于 end`);
  if (result.derivation === "unresolved" && (start || end)) throw new Error(`${label} unresolved 时不能填写 start/end`);
  if (!groundingTexts.some((text) => text.includes(result.raw_expression))) {
    throw new Error(`${label}.raw_expression 不存在于命题或 supporting blocks`);
  }
  return result;
}

function referenceIds(template: string): string[] {
  return [...template.matchAll(OBJECT_REFERENCE_PATTERN)].map((match) => match[1]);
}

function occurrenceStart(text: string, span: string, occurrence: number): number {
  let start = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    start = text.indexOf(span, start + 1);
    if (start < 0) return -1;
  }
  return start;
}

function validateSnapshot(value: unknown, blocksValue: unknown): { snapshot: Snapshot; blocks: ParsedBlock[] } {
  const root = objectValue(value, "source-semantics-full.json");
  if (root.schema_version !== "source-semantics-full.v4") {
    throw new Error(`不支持的来源语义版本：${String(root.schema_version)}；只接受 source-semantics-full.v4`);
  }
  const source = validateSourceMetadata(root.source, "source");
  const blocks = arrayValue(blocksValue, "parsed-blocks.json").map((raw, index): ParsedBlock => {
    const block = objectValue(raw, `blocks[${index}]`);
    const bbox = block.bbox === null ? null : numberArray(block.bbox, `blocks[${index}].bbox`);
    if (bbox && bbox.length !== 4) throw new Error(`blocks[${index}].bbox 必须包含四个坐标`);
    return {
      block_id: stringValue(block.block_id, `blocks[${index}].block_id`),
      order: integerValue(block.order, `blocks[${index}].order`),
      block_type: stringValue(block.block_type, `blocks[${index}].block_type`),
      source_pages: integerArray(block.source_pages, `blocks[${index}].source_pages`, 1),
      heading_level: block.heading_level === null ? null : integerValue(block.heading_level, `blocks[${index}].heading_level`, 1),
      heading_path: stringArray(block.heading_path, `blocks[${index}].heading_path`),
      source_type: block.source_type === null ? null : stringValue(block.source_type, `blocks[${index}].source_type`),
      source_sub_type: block.source_sub_type === null ? null : stringValue(block.source_sub_type, `blocks[${index}].source_sub_type`),
      bbox,
      asset_path: block.asset_path === null ? null : stringValue(block.asset_path, `blocks[${index}].asset_path`),
      markdown: stringValue(block.markdown, `blocks[${index}].markdown`),
    };
  });
  if (blocks.length !== source.block_count) throw new Error("parsed-blocks.json 与 source.block_count 不一致");
  unique(blocks.map((item) => item.block_id), "parsed block_id");
  unique(blocks.map((item) => item.order), "parsed block order");
  const blockById = new Map(blocks.map((item) => [item.block_id, item]));

  const regionTreeSchemaVersion = stringValue(root.region_tree_schema_version, "region_tree_schema_version");
  const sourceNodeIds = unique(stringArray(root.source_node_ids, "source_node_ids"), "source_node_ids");
  const sources = arrayValue(root.sources, "sources").map((raw, regionIndex): SourceRegion => {
    const region = objectValue(raw, `sources[${regionIndex}]`);
    if (region.schema_version !== "source-semantics.v4") throw new Error(`sources[${regionIndex}] 不是 source-semantics.v4`);
    const regionSource = validateSourceMetadata(region.source, `sources[${regionIndex}].source`);
    if (!sameSource(source, regionSource)) throw new Error(`sources[${regionIndex}].source 与全量 source 不一致`);
    if (region.region_tree_schema_version !== regionTreeSchemaVersion) throw new Error(`sources[${regionIndex}] 的区域树版本不一致`);
    const regionNodeId = stringValue(region.region_node_id, `sources[${regionIndex}].region_node_id`);
    const sourceBlockIds = unique(stringArray(region.source_block_ids, `${regionNodeId}.source_block_ids`), `${regionNodeId}.source_block_ids`);
    const coveredBlockIds = unique(stringArray(region.covered_block_ids, `${regionNodeId}.covered_block_ids`), `${regionNodeId}.covered_block_ids`);
    const unclaimedBlockIds = unique(stringArray(region.unclaimed_block_ids, `${regionNodeId}.unclaimed_block_ids`), `${regionNodeId}.unclaimed_block_ids`);
    const sourceBlockSet = new Set(sourceBlockIds);
    for (const blockId of sourceBlockIds) if (!blockById.has(blockId)) throw new Error(`${regionNodeId} 引用了不存在的原文块 ${blockId}`);
    for (const blockId of [...coveredBlockIds, ...unclaimedBlockIds]) if (!sourceBlockSet.has(blockId)) throw new Error(`${regionNodeId} 的覆盖状态包含范围外原文块 ${blockId}`);
    if (coveredBlockIds.some((id) => unclaimedBlockIds.includes(id)) || new Set([...coveredBlockIds, ...unclaimedBlockIds]).size !== sourceBlockIds.length) {
      throw new Error(`${regionNodeId} 的 covered/unclaimed 未完整且互斥地覆盖 source_block_ids`);
    }

    const objects = arrayValue(region.objects, `${regionNodeId}.objects`).map((rawObject, index): SourceObject => {
      const item = objectValue(rawObject, `${regionNodeId}.objects[${index}]`);
      return {
        object_id: stringValue(item.object_id, `${regionNodeId}.objects[${index}].object_id`),
        label: stringValue(item.label, `${regionNodeId}.objects[${index}].label`),
        aliases: unique(stringArray(item.aliases, `${regionNodeId}.objects[${index}].aliases`), `${regionNodeId}.objects[${index}].aliases`),
      };
    });
    unique(objects.map((item) => item.object_id), `${regionNodeId} object_id`);
    const objectById = new Map(objects.map((item) => [item.object_id, item]));

    const rawAssertions = arrayValue(region.assertions, `${regionNodeId}.assertions`);
    const assertionRawById = new Map<string, Record<string, unknown>>();
    for (const [index, rawAssertion] of rawAssertions.entries()) {
      const item = objectValue(rawAssertion, `${regionNodeId}.assertions[${index}]`);
      const claimId = stringValue(item.claim_id, `${regionNodeId}.assertions[${index}].claim_id`);
      if (assertionRawById.has(claimId)) throw new Error(`${regionNodeId} assertion claim_id 重复：${claimId}`);
      assertionRawById.set(claimId, item);
    }
    const assertionTemplates = new Map<string, string>();
    const plainStatements = new Map<string, string>();
    for (const [claimId, item] of assertionRawById) {
      const template = stringValue(item.statement_template_markdown, `${regionNodeId}.${claimId}.statement_template_markdown`);
      const refs = referenceIds(template);
      if (refs.some((id) => !objectById.has(id))) throw new Error(`${regionNodeId}.${claimId} 包含不存在的 Object 引用`);
      assertionTemplates.set(claimId, template);
      plainStatements.set(claimId, template.replace(OBJECT_REFERENCE_PATTERN, (_, id: string) => objectById.get(id)!.label));
    }

    const mentions = arrayValue(region.object_mentions, `${regionNodeId}.object_mentions`).map((rawMention, index): SourceObjectMention => {
      const item = objectValue(rawMention, `${regionNodeId}.object_mentions[${index}]`);
      const mention: SourceObjectMention = {
        claim_id: stringValue(item.claim_id, `${regionNodeId}.object_mentions[${index}].claim_id`),
        span_text: stringValue(item.span_text, `${regionNodeId}.object_mentions[${index}].span_text`),
        occurrence_index: integerValue(item.occurrence_index, `${regionNodeId}.object_mentions[${index}].occurrence_index`),
        mention_id: stringValue(item.mention_id, `${regionNodeId}.object_mentions[${index}].mention_id`),
        object_id: stringValue(item.object_id, `${regionNodeId}.object_mentions[${index}].object_id`),
        start: integerValue(item.start, `${regionNodeId}.object_mentions[${index}].start`),
        end: integerValue(item.end, `${regionNodeId}.object_mentions[${index}].end`, 1),
      };
      const statement = plainStatements.get(mention.claim_id);
      const object = objectById.get(mention.object_id);
      if (!statement || !object) throw new Error(`${regionNodeId}.${mention.mention_id} 引用了不存在的 claim 或 Object`);
      if (mention.end <= mention.start || statement.slice(mention.start, mention.end) !== mention.span_text || object.label !== mention.span_text) {
        throw new Error(`${regionNodeId}.${mention.mention_id} 的 span 与命题/Object 不一致`);
      }
      if (occurrenceStart(statement, mention.span_text, mention.occurrence_index) !== mention.start) {
        throw new Error(`${regionNodeId}.${mention.mention_id} 的 occurrence_index 不可复现`);
      }
      return mention;
    });
    unique(mentions.map((item) => item.mention_id), `${regionNodeId} mention_id`);
    const mentionRefsByClaim = new Map<string, SourceObjectMention[]>();
    for (const mention of mentions) mentionRefsByClaim.set(mention.claim_id, [...(mentionRefsByClaim.get(mention.claim_id) ?? []), mention]);
    for (const [claimId, template] of assertionTemplates) {
      const expected = referenceIds(template);
      const actual = (mentionRefsByClaim.get(claimId) ?? []).sort((a, b) => a.start - b.start).map((item) => item.object_id);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${regionNodeId}.${claimId} 的模板引用与 mention 不一致`);
    }

    const assertions = [...assertionRawById].map(([claimId, item]): SourceAssertion => {
      const supporting = unique(stringArray(item.supporting_block_ids, `${regionNodeId}.${claimId}.supporting_block_ids`, false), `${regionNodeId}.${claimId}.supporting_block_ids`);
      for (const blockId of supporting) if (!sourceBlockSet.has(blockId)) throw new Error(`${regionNodeId}.${claimId} 引用了来源区域外原文块 ${blockId}`);
      const groundingTexts = [plainStatements.get(claimId)!, ...supporting.map((id) => blockById.get(id)!.markdown)];
      return {
        claim_id: claimId,
        statement_template_markdown: assertionTemplates.get(claimId)!,
        supporting_block_ids: supporting,
        temporal_annotations: arrayValue(item.temporal_annotations, `${regionNodeId}.${claimId}.temporal_annotations`).map((annotation, index) =>
          validateTemporal(annotation, `${regionNodeId}.${claimId}.temporal_annotations[${index}]`, groundingTexts)),
      };
    });
    const initialClaimCount = integerValue(region.initial_claim_count, `${regionNodeId}.initial_claim_count`);
    const reviewAdditionCount = integerValue(region.review_addition_count, `${regionNodeId}.review_addition_count`);
    if (initialClaimCount + reviewAdditionCount !== assertions.length) throw new Error(`${regionNodeId} 的 claim 计数与 assertions 不一致`);
    const createdAt = new Date(stringValue(region.created_at, `${regionNodeId}.created_at`));
    if (Number.isNaN(createdAt.getTime())) throw new Error(`${regionNodeId}.created_at 不是有效时间`);
    return {
      schema_version: "source-semantics.v4",
      created_at: createdAt.toISOString(),
      source: regionSource,
      region_tree_schema_version: regionTreeSchemaVersion,
      region_node_id: regionNodeId,
      label: stringValue(region.label, `${regionNodeId}.label`),
      lineage_node_ids: stringArray(region.lineage_node_ids, `${regionNodeId}.lineage_node_ids`),
      source_pages: integerArray(region.source_pages, `${regionNodeId}.source_pages`, 1),
      source_block_ids: sourceBlockIds,
      covered_block_ids: coveredBlockIds,
      unclaimed_block_ids: unclaimedBlockIds,
      initial_claim_count: initialClaimCount,
      review_addition_count: reviewAdditionCount,
      assertions,
      objects,
      object_mentions: mentions,
      model_calls: integerValue(region.model_calls, `${regionNodeId}.model_calls`),
    };
  });
  if (JSON.stringify(sourceNodeIds) !== JSON.stringify(sources.map((item) => item.region_node_id))) throw new Error("source_node_ids 与 sources 顺序或内容不一致");
  const totalAssertions = integerValue(root.total_assertions, "total_assertions");
  const totalObjects = integerValue(root.total_objects, "total_objects");
  const totalMentions = integerValue(root.total_object_mentions, "total_object_mentions");
  const modelCalls = integerValue(root.model_calls, "model_calls");
  if (totalAssertions !== sources.reduce((sum, item) => sum + item.assertions.length, 0) ||
      totalObjects !== sources.reduce((sum, item) => sum + item.objects.length, 0) ||
      totalMentions !== sources.reduce((sum, item) => sum + item.object_mentions.length, 0) ||
      modelCalls !== sources.reduce((sum, item) => sum + item.model_calls, 0)) {
    throw new Error("全量 totals 与 sources 汇总不一致");
  }
  const createdAt = new Date(stringValue(root.created_at, "created_at"));
  if (Number.isNaN(createdAt.getTime())) throw new Error("created_at 不是有效时间");
  return {
    snapshot: {
      schema_version: "source-semantics-full.v4",
      created_at: createdAt.toISOString(),
      source,
      region_tree_schema_version: regionTreeSchemaVersion,
      source_node_ids: sourceNodeIds,
      sources,
      total_assertions: totalAssertions,
      total_objects: totalObjects,
      total_object_mentions: totalMentions,
      model_calls: modelCalls,
    },
    blocks,
  };
}

const localKey = (regionId: string, localId: string): string => `${regionId}\u0000${localId}`;

async function importSourceSemantics(snapshot: Snapshot, blocks: ParsedBlock[], input: string): Promise<string> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.startsWith("postgresql://") && !connectionString?.startsWith("postgres://")) {
    throw new Error("DATABASE_URL 必须是 PostgreSQL 连接地址");
  }
  const compilationId = randomUUID();
  const regionIds = new Map(snapshot.sources.map((region) => [region.region_node_id, randomUUID()]));
  const blockIds = new Map(blocks.map((block) => [block.block_id, randomUUID()]));
  const objectIds = new Map(snapshot.sources.flatMap((region) => region.objects.map((item) => [localKey(region.region_node_id, item.object_id), randomUUID()] as const)));
  const assertionIds = new Map(snapshot.sources.flatMap((region) => region.assertions.map((item) => [localKey(region.region_node_id, item.claim_id), randomUUID()] as const)));

  const regions: Prisma.MemorySourceRegionCreateManyInput[] = snapshot.sources.map((item) => ({
    id: regionIds.get(item.region_node_id)!, compilationId, sourceNodeId: item.region_node_id,
    schemaVersion: item.schema_version, label: item.label, lineageNodeIds: item.lineage_node_ids,
    sourcePages: item.source_pages, sourceBlockIds: item.source_block_ids, coveredBlockIds: item.covered_block_ids,
    unclaimedBlockIds: item.unclaimed_block_ids, initialClaimCount: item.initial_claim_count,
    reviewAdditionCount: item.review_addition_count, modelCalls: item.model_calls, createdAt: new Date(item.created_at),
  }));
  const sourceBlocks: Prisma.MemorySourceBlockCreateManyInput[] = blocks.map((item) => ({
    id: blockIds.get(item.block_id)!, compilationId, sourceBlockId: item.block_id, order: item.order,
    blockType: item.block_type, sourcePages: item.source_pages, headingLevel: item.heading_level,
    headingPath: item.heading_path, sourceType: item.source_type, sourceSubType: item.source_sub_type,
    bbox: item.bbox === null ? undefined : item.bbox, assetPath: item.asset_path, markdown: item.markdown,
  }));
  const objects: Prisma.MemoryObjectCreateManyInput[] = snapshot.sources.flatMap((region) => region.objects.map((item) => ({
    id: objectIds.get(localKey(region.region_node_id, item.object_id))!, compilationId,
    sourceRegionId: regionIds.get(region.region_node_id)!, sourceObjectId: item.object_id,
    label: item.label, aliases: item.aliases,
  })));
  const assertions: Prisma.MemoryAssertionCreateManyInput[] = snapshot.sources.flatMap((region) => region.assertions.map((item) => ({
    id: assertionIds.get(localKey(region.region_node_id, item.claim_id))!, compilationId,
    sourceRegionId: regionIds.get(region.region_node_id)!, sourceClaimId: item.claim_id,
    statementTemplateMarkdown: item.statement_template_markdown,
  })));
  const mentions: Prisma.MemoryObjectMentionCreateManyInput[] = snapshot.sources.flatMap((region) => region.object_mentions.map((item) => ({
    id: randomUUID(), sourceRegionId: regionIds.get(region.region_node_id)!,
    assertionId: assertionIds.get(localKey(region.region_node_id, item.claim_id))!,
    objectId: objectIds.get(localKey(region.region_node_id, item.object_id))!, sourceMentionId: item.mention_id,
    spanText: item.span_text, occurrenceIndex: item.occurrence_index, start: item.start, end: item.end,
  })));
  const assertionBlocks: Prisma.MemoryAssertionSourceBlockCreateManyInput[] = snapshot.sources.flatMap((region) => region.assertions.flatMap((item) =>
    item.supporting_block_ids.map((blockId, ordinal) => ({
      assertionId: assertionIds.get(localKey(region.region_node_id, item.claim_id))!,
      blockId: blockIds.get(blockId)!, ordinal,
    }))));
  const temporals: Prisma.MemoryTemporalAnnotationCreateManyInput[] = snapshot.sources.flatMap((region) => region.assertions.flatMap((item) =>
    item.temporal_annotations.map((annotation, ordinal) => ({
      id: randomUUID(), assertionId: assertionIds.get(localKey(region.region_node_id, item.claim_id))!, ordinal,
      rawExpression: annotation.raw_expression, kind: annotation.kind, normalizedText: annotation.normalized_text,
      start: annotation.start, end: annotation.end, precision: annotation.precision,
      derivation: annotation.derivation, basisMarkdown: annotation.basis_markdown,
    }))));

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.memoryCompilation.deleteMany();
      await transaction.memoryCompilation.create({ data: {
        id: compilationId, schemaVersion: snapshot.schema_version, compiledAt: new Date(snapshot.created_at),
        sourcePath: snapshot.source.path, sourceTitle: snapshot.source.title, sourceSha256: snapshot.source.sha256,
        sourceParser: snapshot.source.parser, sourcePageCount: snapshot.source.page_count,
        sourceBlockCount: snapshot.source.block_count, regionTreeSchemaVersion: snapshot.region_tree_schema_version,
        sourceNodeIds: snapshot.source_node_ids, sourceNodeCount: snapshot.sources.length,
        assertionCount: assertions.length, objectCount: objects.length,
        objectMentionCount: mentions.length, modelCalls: snapshot.model_calls,
      } });
      if (regions.length) await transaction.memorySourceRegion.createMany({ data: regions });
      if (sourceBlocks.length) await transaction.memorySourceBlock.createMany({ data: sourceBlocks });
      if (objects.length) await transaction.memoryObject.createMany({ data: objects });
      if (assertions.length) await transaction.memoryAssertion.createMany({ data: assertions });
      if (mentions.length) await transaction.memoryObjectMention.createMany({ data: mentions });
      if (assertionBlocks.length) await transaction.memoryAssertionSourceBlock.createMany({ data: assertionBlocks });
      if (temporals.length) await transaction.memoryTemporalAnnotation.createMany({ data: temporals });
    }, { maxWait: 30_000, timeout: 300_000 });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }

  const reportPath = path.join(path.dirname(input), "database-import.json");
  await writeFile(reportPath, JSON.stringify({
    schema_version: "source-semantics-database-import.v1", created_at: new Date().toISOString(),
    status: "committed", compilation_id: compilationId, source_sha256: snapshot.source.sha256,
    counts: { source_regions: regions.length, source_blocks: sourceBlocks.length, objects: objects.length,
      assertions: assertions.length, object_mentions: mentions.length,
      assertion_source_block_links: assertionBlocks.length, temporal_annotations: temporals.length },
    source_region_ids: [...regionIds].map(([source_node_id, database_id]) => ({ source_node_id, database_id })),
    object_ids: snapshot.sources.flatMap((region) => region.objects.map((item) => ({ source_node_id: region.region_node_id,
      source_object_id: item.object_id, database_id: objectIds.get(localKey(region.region_node_id, item.object_id))! }))),
    assertion_ids: snapshot.sources.flatMap((region) => region.assertions.map((item) => ({ source_node_id: region.region_node_id,
      source_claim_id: item.claim_id, database_id: assertionIds.get(localKey(region.region_node_id, item.claim_id))! }))),
  }, null, 2), "utf8");
  return reportPath;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const input = await resolveInput(args.input);
  const blocksPath = await findParsedBlocks(input);
  const { snapshot, blocks } = validateSnapshot(
    JSON.parse(await readFile(input, "utf8")) as unknown,
    JSON.parse(await readFile(blocksPath, "utf8")) as unknown,
  );
  const temporalCount = snapshot.sources.reduce((sum, region) =>
    sum + region.assertions.reduce((inner, assertion) => inner + assertion.temporal_annotations.length, 0), 0);
  console.log(`输入验证通过：${snapshot.sources.length} 个来源区域，${snapshot.total_objects} 个 Object，` +
    `${snapshot.total_assertions} 条 Assertion，${snapshot.total_object_mentions} 个 Mention，${temporalCount} 项时间标注。`);
  if (args.validateOnly) return;
  const reportPath = await importSourceSemantics(snapshot, blocks, input);
  console.log(`来源记忆层已清空并写入，导入报告：${reportPath}`);
}

main().catch((error: unknown) => {
  console.error(`来源语义导入失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
