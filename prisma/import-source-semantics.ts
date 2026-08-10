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
  context_dependent: boolean;
  temporal_annotations: TemporalAnnotation[];
};

type SourceObjectFragment = {
  fragment_id: string;
  source_region_id: string;
  surface_forms: string[];
};

type SourceRegion = {
  schema_version: "source-semantics.v7";
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
  object_fragments: SourceObjectFragment[];
  model_calls: number;
};

type Snapshot = {
  schema_version: "source-semantics-full.v7";
  created_at: string;
  source: SourceMetadata;
  region_tree_schema_version: string;
  source_node_ids: string[];
  sources: SourceRegion[];
  total_assertions: number;
  total_object_fragments: number;
  total_surface_forms: number;
  model_calls: number;
};

type StoredGlobalObject = {
  global_object_id: string;
  global_object_key: string;
  canonical_name: string;
  identity_summary_markdown: string;
  surface_atom_ids: string[];
  reference_atom_ids: string[];
};

type GlobalResolutionArtifact = {
  schema_version: "global-resolution.v1";
  created_at: string;
  source_semantics_schema_version: "source-semantics-full.v7";
  source_sha256: string;
  source_node_ids: string[];
  source_region_count: number;
  global_objects: StoredGlobalObject[];
  total_surface_atoms: number;
  total_reference_atoms: number;
};

type GlobalAssertionReferenceAtom = {
  atom_id: string;
  ordinal: number;
  global_object_id: string;
  source_start: number;
  source_end: number;
  source_text: string;
};

type GlobalizedAssertion = {
  assertion_id: string;
  global_statement_template_markdown: string;
  reference_atoms: GlobalAssertionReferenceAtom[];
};

type GlobalAssertionsArtifact = {
  schema_version: "global-assertions.v1";
  created_at: string;
  source_semantics_schema_version: "source-semantics-full.v7";
  global_resolution_schema_version: "global-resolution.v1";
  source_sha256: string;
  source_node_ids: string[];
  assertions: GlobalizedAssertion[];
  total_assertions: number;
  total_source_reference_atoms: number;
  total_literal_reference_atoms: number;
  total_reference_atoms: number;
};

type ResolvedInput = {
  resolution: string;
  sourceSemantics: string;
  globalAssertions: string;
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

const FRAGMENT_REFERENCE_PATTERN = /\{\{fragment:([^{}]+)\}\}/g;
const GLOBAL_OBJECT_REFERENCE_PATTERN = /\{\{object:([^{}]+)\}\}/g;
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
  if (!input) throw new Error("缺少 --input <Global Resolution 目录或 global-resolution.json>");
  return { input: path.resolve(input), validateOnly };
}

async function resolveInput(input: string): Promise<ResolvedInput> {
  const info = await stat(input);
  const resolution = info.isDirectory() ? path.join(input, "global-resolution.json") : input;
  const resolutionInfo = await stat(resolution);
  if (!resolutionInfo.isFile() || path.basename(resolution) !== "global-resolution.json") {
    throw new Error("--input 必须指向已完成的 Global Resolution 目录或 global-resolution.json");
  }
  const sourceSemantics = path.resolve(path.dirname(resolution), "..", "..", "source-semantics-full.json");
  const sourceInfo = await stat(sourceSemantics);
  if (!sourceInfo.isFile()) throw new Error("Global Resolution 不在完整 Source Semantic 产物下方");
  const globalAssertions = path.join(path.dirname(resolution), "global-assertions.json");
  try {
    const globalAssertionsInfo = await stat(globalAssertions);
    if (!globalAssertionsInfo.isFile()) throw new Error("不是文件");
  } catch {
    throw new Error("Global Resolution 缺少 global-assertions.json；请先运行 finalize-assertions");
  }
  return { resolution, sourceSemantics, globalAssertions };
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

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
  return value;
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
  const compactRawExpression = result.raw_expression.replace(/\s+/g, "");
  if (!groundingTexts.some((text) => text.replace(/\s+/g, "").includes(compactRawExpression))) {
    throw new Error(`${label}.raw_expression 不存在于模板、Fragment surface form 或 supporting blocks`);
  }
  return result;
}

function referenceIds(template: string): string[] {
  return [...template.matchAll(FRAGMENT_REFERENCE_PATTERN)].map((match) => match[1]);
}

function validateSnapshot(value: unknown, blocksValue: unknown): { snapshot: Snapshot; blocks: ParsedBlock[] } {
  const root = objectValue(value, "source-semantics-full.json");
  if (root.schema_version !== "source-semantics-full.v7") {
    throw new Error(`不支持的来源语义版本：${String(root.schema_version)}；只接受 source-semantics-full.v7`);
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
    if (region.schema_version !== "source-semantics.v7") throw new Error(`sources[${regionIndex}] 不是 source-semantics.v7`);
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

    const surfaceOwners = new Map<string, string>();
    const objectFragments = arrayValue(region.object_fragments, `${regionNodeId}.object_fragments`).map(
      (rawFragment, index): SourceObjectFragment => {
        const item = objectValue(rawFragment, `${regionNodeId}.object_fragments[${index}]`);
        const fragmentId = stringValue(item.fragment_id, `${regionNodeId}.object_fragments[${index}].fragment_id`);
        if (fragmentId !== `fragment-${index + 1}`) {
          throw new Error(`${regionNodeId}.object_fragments 的稳定 ID 顺序无效`);
        }
        const sourceRegionId = stringValue(item.source_region_id, `${regionNodeId}.${fragmentId}.source_region_id`);
        if (sourceRegionId !== regionNodeId) throw new Error(`${regionNodeId}.${fragmentId} 属于其他 SourceRegion`);
        const surfaceForms = unique(
          stringArray(item.surface_forms, `${regionNodeId}.${fragmentId}.surface_forms`, false),
          `${regionNodeId}.${fragmentId}.surface_forms`,
        );
        for (const surfaceForm of surfaceForms) {
          if (surfaceForm !== surfaceForm.trim()) throw new Error(`${regionNodeId}.${fragmentId} 包含首尾空白的 surface form`);
          const owner = surfaceOwners.get(surfaceForm);
          if (owner && owner !== fragmentId) throw new Error(`${regionNodeId} 的 surface form ${surfaceForm} 被分到多个 Fragment`);
          surfaceOwners.set(surfaceForm, fragmentId);
        }
        return { fragment_id: fragmentId, source_region_id: sourceRegionId, surface_forms: surfaceForms };
      },
    );
    unique(objectFragments.map((item) => item.fragment_id), `${regionNodeId} fragment_id`);
    const fragmentById = new Map(objectFragments.map((item) => [item.fragment_id, item]));

    const rawAssertions = arrayValue(region.assertions, `${regionNodeId}.assertions`);
    const assertionRawById = new Map<string, Record<string, unknown>>();
    for (const [index, rawAssertion] of rawAssertions.entries()) {
      const item = objectValue(rawAssertion, `${regionNodeId}.assertions[${index}]`);
      const claimId = stringValue(item.claim_id, `${regionNodeId}.assertions[${index}].claim_id`);
      if (assertionRawById.has(claimId)) throw new Error(`${regionNodeId} assertion claim_id 重复：${claimId}`);
      assertionRawById.set(claimId, item);
    }
    const assertionTemplates = new Map<string, string>();
    const assertionFragmentIds = new Map<string, string[]>();
    for (const [claimId, item] of assertionRawById) {
      const template = stringValue(item.statement_template_markdown, `${regionNodeId}.${claimId}.statement_template_markdown`);
      const refs = referenceIds(template);
      const remainder = template.replace(FRAGMENT_REFERENCE_PATTERN, "");
      if (remainder.includes("{{fragment:")) throw new Error(`${regionNodeId}.${claimId} 包含不完整的 Fragment 引用`);
      if (template.includes("{{object:")) throw new Error(`${regionNodeId}.${claimId} 提前包含 Global Object 引用`);
      if (refs.some((id) => !fragmentById.has(id))) throw new Error(`${regionNodeId}.${claimId} 包含不存在的 Fragment 引用`);
      assertionTemplates.set(claimId, template);
      assertionFragmentIds.set(claimId, refs);
    }

    const assertions = [...assertionRawById].map(([claimId, item]): SourceAssertion => {
      const supporting = unique(stringArray(item.supporting_block_ids, `${regionNodeId}.${claimId}.supporting_block_ids`, false), `${regionNodeId}.${claimId}.supporting_block_ids`);
      for (const blockId of supporting) if (!sourceBlockSet.has(blockId)) throw new Error(`${regionNodeId}.${claimId} 引用了来源区域外原文块 ${blockId}`);
      const groundingTexts = [
        assertionTemplates.get(claimId)!,
        ...supporting.map((id) => blockById.get(id)!.markdown),
        ...(assertionFragmentIds.get(claimId) ?? []).flatMap((id) => fragmentById.get(id)!.surface_forms),
      ];
      return {
        claim_id: claimId,
        statement_template_markdown: assertionTemplates.get(claimId)!,
        supporting_block_ids: supporting,
        context_dependent: booleanValue(item.context_dependent, `${regionNodeId}.${claimId}.context_dependent`),
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
      schema_version: "source-semantics.v7",
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
      object_fragments: objectFragments,
      model_calls: integerValue(region.model_calls, `${regionNodeId}.model_calls`),
    };
  });
  if (JSON.stringify(sourceNodeIds) !== JSON.stringify(sources.map((item) => item.region_node_id))) throw new Error("source_node_ids 与 sources 顺序或内容不一致");
  const totalAssertions = integerValue(root.total_assertions, "total_assertions");
  const totalObjectFragments = integerValue(root.total_object_fragments, "total_object_fragments");
  const totalSurfaceForms = integerValue(root.total_surface_forms, "total_surface_forms");
  const modelCalls = integerValue(root.model_calls, "model_calls");
  if (totalAssertions !== sources.reduce((sum, item) => sum + item.assertions.length, 0) ||
      totalObjectFragments !== sources.reduce((sum, item) => sum + item.object_fragments.length, 0) ||
      totalSurfaceForms !== sources.reduce((sum, item) => sum + item.object_fragments.reduce((inner, fragment) => inner + fragment.surface_forms.length, 0), 0) ||
      modelCalls !== sources.reduce((sum, item) => sum + item.model_calls, 0)) {
    throw new Error("全量 totals 与 sources 汇总不一致");
  }
  const createdAt = new Date(stringValue(root.created_at, "created_at"));
  if (Number.isNaN(createdAt.getTime())) throw new Error("created_at 不是有效时间");
  return {
    snapshot: {
      schema_version: "source-semantics-full.v7",
      created_at: createdAt.toISOString(),
      source,
      region_tree_schema_version: regionTreeSchemaVersion,
      source_node_ids: sourceNodeIds,
      sources,
      total_assertions: totalAssertions,
      total_object_fragments: totalObjectFragments,
      total_surface_forms: totalSurfaceForms,
      model_calls: modelCalls,
    },
    blocks,
  };
}

const localKey = (regionId: string, localId: string): string => `${regionId}\u0000${localId}`;

const surfaceAtomId = (regionId: string, fragmentId: string, ordinal: number): string =>
  `surface:${regionId}:${fragmentId}:${ordinal}`;

const referenceAtomId = (regionId: string, claimId: string, ordinal: number): string =>
  `reference:${regionId}:${claimId}:${ordinal}`;

type SurfaceAssignment = {
  sourceNodeId: string;
  sourceFragmentId: string;
  ordinal: number;
  globalObjectId: string;
};

type ExpectedSurfaceAtom = Omit<SurfaceAssignment, "globalObjectId"> & {
  surfaceForm: string;
};

type ReferenceAssignment = {
  sourceNodeId: string;
  sourceClaimId: string;
  ordinal: number;
  globalObjectId: string;
};

type ValidatedResolution = {
  artifact: GlobalResolutionArtifact;
  surfaceAssignments: SurfaceAssignment[];
  referenceAssignments: ReferenceAssignment[];
};

type LiteralReferenceAssignment = {
  atomId: string;
  sourceNodeId: string;
  sourceClaimId: string;
  literalOrdinal: number;
  globalOrdinal: number;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  globalObjectId: string;
};

type ValidatedGlobalAssertions = {
  artifact: GlobalAssertionsArtifact;
  globalTemplates: Map<string, string>;
  literalReferences: LiteralReferenceAssignment[];
};

function validateGlobalResolution(value: unknown, snapshot: Snapshot): ValidatedResolution {
  const root = objectValue(value, "global-resolution.json");
  if (root.schema_version !== "global-resolution.v1") {
    throw new Error(`不支持的 Global Resolution 版本：${String(root.schema_version)}`);
  }
  if (root.source_semantics_schema_version !== snapshot.schema_version) {
    throw new Error("Global Resolution 与 Source Semantic schema_version 不一致");
  }
  if (stringValue(root.source_sha256, "source_sha256") !== snapshot.source.sha256) {
    throw new Error("Global Resolution 与 Source Semantic 的 source_sha256 不一致");
  }
  const sourceNodeIds = unique(stringArray(root.source_node_ids, "source_node_ids"), "source_node_ids");
  if (JSON.stringify(sourceNodeIds) !== JSON.stringify(snapshot.source_node_ids)) {
    throw new Error("Global Resolution 与 Source Semantic 的 SourceRegion 顺序不一致");
  }
  const createdAt = new Date(stringValue(root.created_at, "created_at"));
  if (Number.isNaN(createdAt.getTime())) throw new Error("Global Resolution created_at 不是有效时间");
  const sourceRegionCount = integerValue(root.source_region_count, "source_region_count");
  if (sourceRegionCount !== snapshot.sources.length) throw new Error("Global Resolution 未覆盖全部 SourceRegion");

  const expectedSurfaces = new Map<string, ExpectedSurfaceAtom>();
  const expectedReferences = new Map<string, Omit<ReferenceAssignment, "globalObjectId">>();
  for (const region of snapshot.sources) {
    for (const fragment of region.object_fragments) {
      for (const [ordinal, surfaceForm] of fragment.surface_forms.entries()) {
        expectedSurfaces.set(surfaceAtomId(region.region_node_id, fragment.fragment_id, ordinal), {
          sourceNodeId: region.region_node_id,
          sourceFragmentId: fragment.fragment_id,
          ordinal,
          surfaceForm,
        });
      }
    }
    for (const assertion of region.assertions) {
      for (const [ordinal] of referenceIds(assertion.statement_template_markdown).entries()) {
        expectedReferences.set(referenceAtomId(region.region_node_id, assertion.claim_id, ordinal), {
          sourceNodeId: region.region_node_id,
          sourceClaimId: assertion.claim_id,
          ordinal,
        });
      }
    }
  }
  const totalSurfaceAtoms = integerValue(root.total_surface_atoms, "total_surface_atoms");
  const totalReferenceAtoms = integerValue(root.total_reference_atoms, "total_reference_atoms");
  if (totalSurfaceAtoms !== expectedSurfaces.size || totalReferenceAtoms !== expectedReferences.size) {
    throw new Error("Global Resolution atom totals 与不可变 Source Semantic IR 不一致");
  }

  const globalObjectIds = new Set<string>();
  const globalObjectKeys = new Set<string>();
  const surfaceOwners = new Map<string, string>();
  const referenceOwners = new Map<string, string>();
  const globalObjects = arrayValue(root.global_objects, "global_objects").map((raw, index): StoredGlobalObject => {
    const item = objectValue(raw, `global_objects[${index}]`);
    const globalObjectId = stringValue(item.global_object_id, `global_objects[${index}].global_object_id`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(globalObjectId)) {
      throw new Error(`global_objects[${index}].global_object_id 不是有效 UUID`);
    }
    const globalObjectKey = stringValue(item.global_object_key, `global_objects[${index}].global_object_key`);
    if (globalObjectIds.has(globalObjectId) || globalObjectKeys.has(globalObjectKey)) {
      throw new Error("global_objects 包含重复 UUID 或 key");
    }
    globalObjectIds.add(globalObjectId);
    globalObjectKeys.add(globalObjectKey);
    const surfaceAtomIds = unique(
      stringArray(item.surface_atom_ids, `global_objects[${index}].surface_atom_ids`),
      `global_objects[${index}].surface_atom_ids`,
    );
    const referenceAtomIds = unique(
      stringArray(item.reference_atom_ids, `global_objects[${index}].reference_atom_ids`),
      `global_objects[${index}].reference_atom_ids`,
    );
    if (!surfaceAtomIds.length) throw new Error(`global_objects[${index}] 没有 surface atom`);
    for (const atomId of surfaceAtomIds) {
      if (!expectedSurfaces.has(atomId)) throw new Error(`Global Object 引用了未知 surface atom：${atomId}`);
      if (surfaceOwners.has(atomId)) throw new Error(`surface atom 被多个 Global Object 占有：${atomId}`);
      surfaceOwners.set(atomId, globalObjectId);
    }
    for (const atomId of referenceAtomIds) {
      if (!expectedReferences.has(atomId)) throw new Error(`Global Object 引用了未知 reference atom：${atomId}`);
      if (referenceOwners.has(atomId)) throw new Error(`reference atom 被多个 Global Object 占有：${atomId}`);
      referenceOwners.set(atomId, globalObjectId);
    }
    const canonicalName = stringValue(item.canonical_name, `global_objects[${index}].canonical_name`);
    if (!surfaceAtomIds.some((atomId) => expectedSurfaces.get(atomId)!.surfaceForm === canonicalName)) {
      throw new Error(`global_objects[${index}].canonical_name 不在当前 surface atoms 中`);
    }
    return {
      global_object_id: globalObjectId,
      global_object_key: globalObjectKey,
      canonical_name: canonicalName,
      identity_summary_markdown: stringValue(
        item.identity_summary_markdown,
        `global_objects[${index}].identity_summary_markdown`,
      ),
      surface_atom_ids: surfaceAtomIds,
      reference_atom_ids: referenceAtomIds,
    };
  });
  if (surfaceOwners.size !== expectedSurfaces.size || referenceOwners.size !== expectedReferences.size) {
    throw new Error("Global Resolution 未完整且互斥地分配全部 source atom");
  }

  return {
    artifact: {
      schema_version: "global-resolution.v1",
      created_at: createdAt.toISOString(),
      source_semantics_schema_version: "source-semantics-full.v7",
      source_sha256: snapshot.source.sha256,
      source_node_ids: sourceNodeIds,
      source_region_count: sourceRegionCount,
      global_objects: globalObjects,
      total_surface_atoms: totalSurfaceAtoms,
      total_reference_atoms: totalReferenceAtoms,
    },
    surfaceAssignments: [...expectedSurfaces].map(([atomId, item]) => ({
      sourceNodeId: item.sourceNodeId,
      sourceFragmentId: item.sourceFragmentId,
      ordinal: item.ordinal,
      globalObjectId: surfaceOwners.get(atomId)!,
    })),
    referenceAssignments: [...expectedReferences].map(([atomId, item]) => ({
      ...item,
      globalObjectId: referenceOwners.get(atomId)!,
    })),
  };
}

function validateGlobalAssertions(
  value: unknown,
  snapshot: Snapshot,
  resolution: ValidatedResolution,
): ValidatedGlobalAssertions {
  const root = objectValue(value, "global-assertions.json");
  if (root.schema_version !== "global-assertions.v1") {
    throw new Error(`不支持的 Global Assertions 版本：${String(root.schema_version)}`);
  }
  if (root.source_semantics_schema_version !== snapshot.schema_version ||
      root.global_resolution_schema_version !== resolution.artifact.schema_version) {
    throw new Error("Global Assertions 与 Source Semantic/Global Resolution schema 不一致");
  }
  if (stringValue(root.source_sha256, "global-assertions.source_sha256") !== snapshot.source.sha256) {
    throw new Error("Global Assertions 与 Source Semantic source_sha256 不一致");
  }
  const sourceNodeIds = unique(
    stringArray(root.source_node_ids, "global-assertions.source_node_ids"),
    "global-assertions.source_node_ids",
  );
  if (JSON.stringify(sourceNodeIds) !== JSON.stringify(snapshot.source_node_ids)) {
    throw new Error("Global Assertions 与 SourceRegion 顺序不一致");
  }
  const createdAt = new Date(stringValue(root.created_at, "global-assertions.created_at"));
  if (Number.isNaN(createdAt.getTime())) throw new Error("Global Assertions created_at 不是有效时间");

  const globalObjectIds = new Set(resolution.artifact.global_objects.map((item) => item.global_object_id));
  const sourceReferenceOwners = new Map(
    resolution.referenceAssignments.map((item) => [
      referenceAtomId(item.sourceNodeId, item.sourceClaimId, item.ordinal),
      item.globalObjectId,
    ]),
  );
  const surfaceTextOwners = new Map<string, Set<string>>();
  for (const assignment of resolution.surfaceAssignments) {
    const region = snapshot.sources.find((item) => item.region_node_id === assignment.sourceNodeId)!;
    const fragment = region.object_fragments.find((item) => item.fragment_id === assignment.sourceFragmentId)!;
    const surfaceText = fragment.surface_forms[assignment.ordinal];
    const owners = surfaceTextOwners.get(surfaceText) ?? new Set<string>();
    owners.add(assignment.globalObjectId);
    surfaceTextOwners.set(surfaceText, owners);
  }

  const expectedAssertions = snapshot.sources.flatMap((region) =>
    region.assertions.map((assertion) => ({ region, assertion })));
  const rawAssertions = arrayValue(root.assertions, "global-assertions.assertions");
  if (rawAssertions.length !== expectedAssertions.length) {
    throw new Error("Global Assertions 未完整覆盖全部 Source Assertions");
  }
  const globalTemplates = new Map<string, string>();
  const literalReferences: LiteralReferenceAssignment[] = [];
  const validatedAssertions: GlobalizedAssertion[] = [];
  const allAtomIds = new Set<string>();
  let sourceReferenceCount = 0;
  for (const [assertionIndex, expected] of expectedAssertions.entries()) {
    const label = `global-assertions.assertions[${assertionIndex}]`;
    const item = objectValue(rawAssertions[assertionIndex], label);
    const assertionId = stringValue(item.assertion_id, `${label}.assertion_id`);
    const expectedAssertionId = `assertion:${expected.region.region_node_id}:${expected.assertion.claim_id}`;
    if (assertionId !== expectedAssertionId) throw new Error(`${label} 的 assertion_id/顺序不一致`);
    const globalTemplate = stringValue(
      item.global_statement_template_markdown,
      `${label}.global_statement_template_markdown`,
    );
    const sourceTemplate = expected.assertion.statement_template_markdown;
    const sourceCodePoints = Array.from(sourceTemplate);
    const expectedSourceAtoms = new Map<string, { start: number; end: number; text: string; owner: string }>();
    for (const [ordinal, match] of [...sourceTemplate.matchAll(FRAGMENT_REFERENCE_PATTERN)].entries()) {
      const atomId = referenceAtomId(expected.region.region_node_id, expected.assertion.claim_id, ordinal);
      const start = codePointLength(sourceTemplate.slice(0, match.index));
      const text = match[0];
      const owner = sourceReferenceOwners.get(atomId);
      if (!owner) throw new Error(`Global Resolution 缺少 source reference owner：${atomId}`);
      expectedSourceAtoms.set(atomId, { start, end: start + codePointLength(text), text, owner });
    }

    const rawReferences = arrayValue(item.reference_atoms, `${label}.reference_atoms`);
    const references: GlobalAssertionReferenceAtom[] = [];
    const seenSourceAtoms = new Set<string>();
    let expectedLiteralOrdinal = 0;
    let previousEnd = 0;
    for (const [globalOrdinal, rawReference] of rawReferences.entries()) {
      const referenceLabel = `${label}.reference_atoms[${globalOrdinal}]`;
      const reference = objectValue(rawReference, referenceLabel);
      const atomId = stringValue(reference.atom_id, `${referenceLabel}.atom_id`);
      const ordinal = integerValue(reference.ordinal, `${referenceLabel}.ordinal`);
      if (ordinal !== globalOrdinal) throw new Error(`${referenceLabel}.ordinal 不连续`);
      if (allAtomIds.has(atomId)) throw new Error(`Global Assertions 重复 atom_id：${atomId}`);
      allAtomIds.add(atomId);
      const globalObjectId = stringValue(reference.global_object_id, `${referenceLabel}.global_object_id`);
      if (!globalObjectIds.has(globalObjectId)) throw new Error(`${referenceLabel} 引用了未知 Global Object`);
      const sourceStart = integerValue(reference.source_start, `${referenceLabel}.source_start`);
      const sourceEnd = integerValue(reference.source_end, `${referenceLabel}.source_end`, 1);
      const sourceText = stringValue(reference.source_text, `${referenceLabel}.source_text`);
      if (sourceStart < previousEnd || sourceEnd <= sourceStart ||
          sourceCodePoints.slice(sourceStart, sourceEnd).join("") !== sourceText) {
        throw new Error(`${referenceLabel} 的来源 span 无效或重叠`);
      }
      previousEnd = sourceEnd;

      const expectedSource = expectedSourceAtoms.get(atomId);
      if (expectedSource) {
        if (expectedSource.start !== sourceStart || expectedSource.end !== sourceEnd ||
            expectedSource.text !== sourceText || expectedSource.owner !== globalObjectId) {
          throw new Error(`${referenceLabel} 与 source reference/current owner 不一致`);
        }
        seenSourceAtoms.add(atomId);
        sourceReferenceCount += 1;
      } else {
        const literalMatch = atomId.match(/^reference:([^:]+):([^:]+):literal:(\d+)$/);
        if (!literalMatch || literalMatch[1] !== expected.region.region_node_id ||
            literalMatch[2] !== expected.assertion.claim_id ||
            Number(literalMatch[3]) !== expectedLiteralOrdinal) {
          throw new Error(`${referenceLabel} 不是稳定的 literal reference atom`);
        }
        const owners = surfaceTextOwners.get(sourceText);
        if (!owners || owners.size !== 1 || !owners.has(globalObjectId)) {
          throw new Error(`${referenceLabel} 不是无歧义的当前 surface form 匹配`);
        }
        literalReferences.push({
          atomId, sourceNodeId: expected.region.region_node_id,
          sourceClaimId: expected.assertion.claim_id, literalOrdinal: expectedLiteralOrdinal,
          globalOrdinal, sourceStart, sourceEnd, sourceText, globalObjectId,
        });
        expectedLiteralOrdinal += 1;
      }
      references.push({
        atom_id: atomId, ordinal, global_object_id: globalObjectId,
        source_start: sourceStart, source_end: sourceEnd, source_text: sourceText,
      });
    }
    if (seenSourceAtoms.size !== expectedSourceAtoms.size) {
      throw new Error(`${label} 未完整保留全部 source reference atoms`);
    }
    let cursor = 0;
    const rebuilt = references.map((reference) => {
      const prefix = sourceCodePoints.slice(cursor, reference.source_start).join("");
      cursor = reference.source_end;
      return `${prefix}{{object:${reference.global_object_id}}}`;
    }).join("") + sourceCodePoints.slice(cursor).join("");
    if (rebuilt !== globalTemplate || globalTemplate.includes("{{fragment:")) {
      throw new Error(`${label} 的 Global Object template 与 reference atoms 不一致`);
    }
    const tokenIds = [...globalTemplate.matchAll(GLOBAL_OBJECT_REFERENCE_PATTERN)].map((match) => match[1]);
    if (JSON.stringify(tokenIds) !== JSON.stringify(references.map((reference) => reference.global_object_id))) {
      throw new Error(`${label} 的 Global Object tokens 顺序不一致`);
    }
    globalTemplates.set(localKey(expected.region.region_node_id, expected.assertion.claim_id), globalTemplate);
    validatedAssertions.push({
      assertion_id: assertionId,
      global_statement_template_markdown: globalTemplate,
      reference_atoms: references,
    });
  }

  const totalAssertions = integerValue(root.total_assertions, "global-assertions.total_assertions");
  const totalSourceReferences = integerValue(
    root.total_source_reference_atoms,
    "global-assertions.total_source_reference_atoms",
  );
  const totalLiteralReferences = integerValue(
    root.total_literal_reference_atoms,
    "global-assertions.total_literal_reference_atoms",
  );
  const totalReferences = integerValue(root.total_reference_atoms, "global-assertions.total_reference_atoms");
  if (totalAssertions !== expectedAssertions.length || totalSourceReferences !== sourceReferenceCount ||
      totalLiteralReferences !== literalReferences.length ||
      totalReferences !== sourceReferenceCount + literalReferences.length) {
    throw new Error("Global Assertions totals 与实际内容不一致");
  }
  return {
    artifact: {
      schema_version: "global-assertions.v1", created_at: createdAt.toISOString(),
      source_semantics_schema_version: "source-semantics-full.v7",
      global_resolution_schema_version: "global-resolution.v1",
      source_sha256: snapshot.source.sha256, source_node_ids: sourceNodeIds,
      assertions: validatedAssertions, total_assertions: totalAssertions,
      total_source_reference_atoms: totalSourceReferences,
      total_literal_reference_atoms: totalLiteralReferences, total_reference_atoms: totalReferences,
    },
    globalTemplates,
    literalReferences,
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

async function importColdStart(
  snapshot: Snapshot,
  blocks: ParsedBlock[],
  resolution: ValidatedResolution,
  globalAssertions: ValidatedGlobalAssertions,
  input: string,
): Promise<string> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.startsWith("postgresql://") && !connectionString?.startsWith("postgres://")) {
    throw new Error("DATABASE_URL 必须是 PostgreSQL 连接地址");
  }
  const compilationId = randomUUID();
  const regionIds = new Map(snapshot.sources.map((region) => [region.region_node_id, randomUUID()]));
  const blockIds = new Map(blocks.map((block) => [block.block_id, randomUUID()]));
  const fragmentIds = new Map(snapshot.sources.flatMap((region) => region.object_fragments.map((item) => [localKey(region.region_node_id, item.fragment_id), randomUUID()] as const)));
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
  const objectFragments: Prisma.MemorySourceObjectFragmentCreateManyInput[] = snapshot.sources.flatMap((region) => region.object_fragments.map((item) => ({
    id: fragmentIds.get(localKey(region.region_node_id, item.fragment_id))!, compilationId,
    sourceRegionId: regionIds.get(region.region_node_id)!, sourceFragmentId: item.fragment_id,
    surfaceForms: item.surface_forms,
  })));
  const assertions: Prisma.MemoryAssertionCreateManyInput[] = snapshot.sources.flatMap((region) => region.assertions.map((item) => ({
    id: assertionIds.get(localKey(region.region_node_id, item.claim_id))!, compilationId,
    sourceRegionId: regionIds.get(region.region_node_id)!, sourceClaimId: item.claim_id,
    statementTemplateMarkdown: item.statement_template_markdown,
    globalStatementTemplateMarkdown: globalAssertions.globalTemplates.get(localKey(region.region_node_id, item.claim_id))!,
    contextDependent: item.context_dependent,
  })));
  const fragmentReferences: Prisma.MemoryAssertionFragmentReferenceCreateManyInput[] = snapshot.sources.flatMap((region) =>
    region.assertions.flatMap((item) => referenceIds(item.statement_template_markdown).map((sourceFragmentId, ordinal) => ({
      assertionId: assertionIds.get(localKey(region.region_node_id, item.claim_id))!,
      objectFragmentId: fragmentIds.get(localKey(region.region_node_id, sourceFragmentId))!,
      ordinal,
    }))));
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
  const globalObjects: Prisma.MemoryGlobalObjectCreateManyInput[] = resolution.artifact.global_objects.map((item) => ({
    id: item.global_object_id,
    compilationId,
    globalObjectKey: item.global_object_key,
    canonicalName: item.canonical_name,
    identitySummaryMarkdown: item.identity_summary_markdown,
  }));
  const surfaceMemberships: Prisma.MemoryGlobalObjectSurfaceMembershipCreateManyInput[] =
    resolution.surfaceAssignments.map((item) => ({
      objectFragmentId: fragmentIds.get(localKey(item.sourceNodeId, item.sourceFragmentId))!,
      surfaceFormOrdinal: item.ordinal,
      globalObjectId: item.globalObjectId,
    }));
  const referenceResolutions: Prisma.MemoryGlobalAssertionReferenceResolutionCreateManyInput[] =
    resolution.referenceAssignments.map((item) => ({
      assertionId: assertionIds.get(localKey(item.sourceNodeId, item.sourceClaimId))!,
      referenceOrdinal: item.ordinal,
      globalObjectId: item.globalObjectId,
    }));
  const literalReferences: Prisma.MemoryGlobalAssertionLiteralReferenceCreateManyInput[] =
    globalAssertions.literalReferences.map((item) => ({
      atomId: item.atomId,
      assertionId: assertionIds.get(localKey(item.sourceNodeId, item.sourceClaimId))!,
      literalOrdinal: item.literalOrdinal,
      globalOrdinal: item.globalOrdinal,
      sourceStart: item.sourceStart,
      sourceEnd: item.sourceEnd,
      sourceText: item.sourceText,
      globalObjectId: item.globalObjectId,
    }));

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
        assertionCount: assertions.length, objectFragmentCount: objectFragments.length,
        surfaceFormCount: snapshot.total_surface_forms, fragmentReferenceCount: fragmentReferences.length,
        modelCalls: snapshot.model_calls,
      } });
      if (regions.length) await transaction.memorySourceRegion.createMany({ data: regions });
      if (sourceBlocks.length) await transaction.memorySourceBlock.createMany({ data: sourceBlocks });
      if (objectFragments.length) await transaction.memorySourceObjectFragment.createMany({ data: objectFragments });
      if (assertions.length) await transaction.memoryAssertion.createMany({ data: assertions });
      if (fragmentReferences.length) await transaction.memoryAssertionFragmentReference.createMany({ data: fragmentReferences });
      if (assertionBlocks.length) await transaction.memoryAssertionSourceBlock.createMany({ data: assertionBlocks });
      if (temporals.length) await transaction.memoryTemporalAnnotation.createMany({ data: temporals });
      if (globalObjects.length) await transaction.memoryGlobalObject.createMany({ data: globalObjects });
      if (surfaceMemberships.length) await transaction.memoryGlobalObjectSurfaceMembership.createMany({ data: surfaceMemberships });
      if (referenceResolutions.length) await transaction.memoryGlobalAssertionReferenceResolution.createMany({ data: referenceResolutions });
      if (literalReferences.length) await transaction.memoryGlobalAssertionLiteralReference.createMany({ data: literalReferences });
    }, { maxWait: 30_000, timeout: 300_000 });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }

  const reportPath = path.join(path.dirname(input), "database-import.json");
  await writeFile(reportPath, JSON.stringify({
    schema_version: "cold-start-database-import.v1", created_at: new Date().toISOString(),
    status: "committed", compilation_id: compilationId, source_sha256: snapshot.source.sha256,
    counts: { source_regions: regions.length, source_blocks: sourceBlocks.length,
      object_fragments: objectFragments.length, surface_forms: snapshot.total_surface_forms,
      assertions: assertions.length, fragment_references: fragmentReferences.length,
      assertion_source_block_links: assertionBlocks.length, temporal_annotations: temporals.length,
      global_objects: globalObjects.length, global_surface_memberships: surfaceMemberships.length,
      global_reference_resolutions: referenceResolutions.length,
      global_literal_references: literalReferences.length },
    source_region_ids: [...regionIds].map(([source_node_id, database_id]) => ({ source_node_id, database_id })),
    object_fragment_ids: snapshot.sources.flatMap((region) => region.object_fragments.map((item) => ({ source_node_id: region.region_node_id,
      source_fragment_id: item.fragment_id, database_id: fragmentIds.get(localKey(region.region_node_id, item.fragment_id))! }))),
    assertion_ids: snapshot.sources.flatMap((region) => region.assertions.map((item) => ({ source_node_id: region.region_node_id,
      source_claim_id: item.claim_id, database_id: assertionIds.get(localKey(region.region_node_id, item.claim_id))! }))),
  }, null, 2), "utf8");
  return reportPath;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const input = await resolveInput(args.input);
  const blocksPath = await findParsedBlocks(input.sourceSemantics);
  const { snapshot, blocks } = validateSnapshot(
    JSON.parse(await readFile(input.sourceSemantics, "utf8")) as unknown,
    JSON.parse(await readFile(blocksPath, "utf8")) as unknown,
  );
  const resolution = validateGlobalResolution(
    JSON.parse(await readFile(input.resolution, "utf8")) as unknown,
    snapshot,
  );
  const globalAssertions = validateGlobalAssertions(
    JSON.parse(await readFile(input.globalAssertions, "utf8")) as unknown,
    snapshot,
    resolution,
  );
  const temporalCount = snapshot.sources.reduce((sum, region) =>
    sum + region.assertions.reduce((inner, assertion) => inner + assertion.temporal_annotations.length, 0), 0);
  const fragmentReferenceCount = snapshot.sources.reduce((sum, region) =>
    sum + region.assertions.reduce((inner, assertion) => inner + referenceIds(assertion.statement_template_markdown).length, 0), 0);
  console.log(`输入验证通过：${snapshot.sources.length} 个来源区域，${snapshot.total_object_fragments} 个 ObjectFragment，` +
    `${snapshot.total_surface_forms} 个 surface form，${snapshot.total_assertions} 条 Assertion，` +
    `${fragmentReferenceCount} 次 Fragment 引用，${temporalCount} 项时间标注，` +
    `${resolution.artifact.global_objects.length} 个 Global Object，` +
    `${globalAssertions.artifact.total_literal_reference_atoms} 个字符串 reference atom。`);
  if (args.validateOnly) return;
  const reportPath = await importColdStart(
    snapshot,
    blocks,
    resolution,
    globalAssertions,
    input.resolution,
  );
  console.log(`完整 cold-start package 已写入记忆层，导入报告：${reportPath}`);
}

main().catch((error: unknown) => {
  console.error(`cold-start package 导入失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
