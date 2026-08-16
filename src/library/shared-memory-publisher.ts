import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { getDatabase } from "@/db";
import { Prisma } from "@/generated/prisma/client";
import {
  libraryAssertionCandidateSchema,
  libraryObjectCandidateSchema,
  libraryReferenceCandidateSchema,
} from "@/library/compilation-types";
import type { GlobalObjectDraft } from "@/library/global-object-resolver";
import { rebuildMemoryAssertionIndex } from "@/memory/assertion-indexer";

const SHARED_COMPILATION_SCHEMA = "echo-shared-memory.v1";
const SHARED_SOURCE_SHA = createHash("sha256")
  .update("Echo Shared Brain workspace", "utf8")
  .digest("hex");

type PreparedBlock = {
  id: string;
  sourceBlockId: string;
  localOrder: number;
  blockType: string;
  sourcePages: number[];
  headingLevel: number | null;
  headingPath: string[];
  sourceType: string | null;
  sourceSubType: string | null;
  bbox?: Prisma.InputJsonValue;
  assetPath: string | null;
  markdown: string;
};

type PreparedRegion = {
  id: string;
  sourceNodeId: string;
  schemaVersion: string;
  label: string;
  lineageNodeIds: string[];
  sourcePages: number[];
  sourceBlockIds: string[];
  coveredBlockIds: string[];
  unclaimedBlockIds: string[];
  initialClaimCount: number;
  reviewAdditionCount: number;
  modelCalls: number;
  createdAt: Date;
  sourcePath: string | null;
  sourceTitle: string;
  sourceSha256: string;
  sourceParser: string | null;
};

type PreparedFragment = {
  id: string;
  sourceRegionId: string;
  sourceFragmentId: string;
  surfaceForms: string[];
};

type PreparedAssertion = {
  id: string;
  sourceRegionId: string;
  sourceClaimId: string;
  kind: "grounded" | "reference";
  statementTemplateMarkdown: string;
  globalStatementTemplateMarkdown: string;
  contextDependent: boolean;
};

type PreparedPublication = {
  runId: string;
  sourceBlobId: string;
  sourceSha256: string;
  prefix: string;
  profile: "catalog" | "coarse" | "deep";
  reuseExisting: boolean;
  objects: Array<{ id: string; canonicalName: string }>;
  regions: PreparedRegion[];
  blocks: PreparedBlock[];
  fragments: PreparedFragment[];
  assertions: PreparedAssertion[];
  assertionBlocks: Array<{ assertionId: string; blockId: string; ordinal: number }>;
  surfaceMemberships: Array<{
    objectFragmentId: string;
    surfaceFormOrdinal: number;
    globalObjectId: string;
  }>;
  semanticLinks: Array<{ assertionId: string; globalObjectId: string }>;
};

export type SharedMemoryPublicationResult = {
  compilationId: string;
  publishedRunCount: number;
  assertionCount: number;
  objectCount: number;
  embeddingStatus: "ready" | "unavailable" | "empty";
  embeddingWarning?: string;
};

function regionPrefix(sourceBlobId: string): string {
  return `library:${sourceBlobId}:`;
}

function normalizedLabel(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN")
    .replace(/[\s·•_/—–-]+/g, "");
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function objectId(draft: GlobalObjectDraft): string {
  return draft.existingObjectId ?? draft.draftObjectId;
}

export async function acquireSharedMemoryPublicationLock(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ lockResult: string }>>(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended('echo-shared-memory-publication', 0)
    )::text AS "lockResult"
  `);
  if (rows.length !== 1) throw new Error("Shared Brain 发布事务锁获取失败");
}

function draftsForRun(
  runId: string,
  resolvedObjects: GlobalObjectDraft[],
): GlobalObjectDraft[] {
  return resolvedObjects.filter((draft) =>
    draft.members.some((member) => member.runId === runId)
  );
}

function draftForMemberKey(
  key: string,
  resolvedObjects: GlobalObjectDraft[],
): GlobalObjectDraft {
  const matches = resolvedObjects.filter((draft) =>
    draft.members.some((member) => member.key === key)
  );
  if (matches.length !== 1) {
    throw new Error(`Shared Brain 发布无法唯一定位 Object 成员：${key}`);
  }
  return matches[0];
}

const deepSourceMetadataSchema = z.object({
  path: z.string(),
  title: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parser: z.string(),
  page_count: z.number().int().nonnegative(),
  block_count: z.number().int().nonnegative(),
});

const deepSourceAssertionSchema = z.object({
  claim_id: z.string().min(1),
  kind: z.enum(["grounded", "reference"]),
  statement_template_markdown: z.string().min(1),
  supporting_block_ids: z.array(z.string()),
  context_dependent: z.boolean(),
});

const deepSourceRegionSchema = z.object({
  schema_version: z.string(),
  created_at: z.string(),
  region_node_id: z.string().min(1),
  label: z.string().min(1),
  lineage_node_ids: z.array(z.string()),
  source_pages: z.array(z.number().int()),
  source_block_ids: z.array(z.string()),
  covered_block_ids: z.array(z.string()),
  unclaimed_block_ids: z.array(z.string()),
  initial_claim_count: z.number().int().nonnegative(),
  review_addition_count: z.number().int().nonnegative(),
  assertions: z.array(deepSourceAssertionSchema),
  object_fragments: z.array(z.object({
    fragment_id: z.string().min(1),
    surface_forms: z.array(z.string().min(1)),
  })),
  model_calls: z.number().int().nonnegative(),
});

const deepSnapshotSchema = z.object({
  schema_version: z.string(),
  created_at: z.string(),
  source: deepSourceMetadataSchema,
  region_tree_schema_version: z.string(),
  sources: z.array(deepSourceRegionSchema),
});

const deepResolutionSchema = z.object({
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  global_objects: z.array(z.object({
    global_object_id: z.string().uuid(),
    canonical_name: z.string().min(1),
    surface_atom_ids: z.array(z.string()),
  })),
});

const deepGlobalAssertionsSchema = z.object({
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  assertions: z.array(z.object({
    assertion_id: z.string().min(1),
    kind: z.enum(["grounded", "reference"]),
    global_statement_template_markdown: z.string().min(1),
    reference_atoms: z.array(z.object({
      global_object_id: z.string().uuid(),
    })),
    linked_global_object_ids: z.array(z.string().uuid()),
  })),
});

const parsedBlocksSchema = z.array(z.object({
  block_id: z.string().min(1),
  order: z.number().int().nonnegative(),
  block_type: z.string().min(1),
  source_pages: z.array(z.number().int()),
  heading_level: z.number().int().nullable(),
  heading_path: z.array(z.string()),
  source_type: z.string().nullable(),
  source_sub_type: z.string().nullable(),
  bbox: z.unknown().nullable(),
  asset_path: z.string().nullable(),
  markdown: z.string().min(1),
}));

function coldStartOutputRoot(): string {
  const configured = process.env.ECHO_COLD_START_OUTPUT_ROOT?.trim();
  if (configured) return path.normalize(/* turbopackIgnore: true */ configured);
  return path.join(/* turbopackIgnore: true */ process.cwd(), ".cold-start");
}

function safeDeepResolutionPath(location: string): string {
  const prefix = "cold-start-global-resolution:";
  if (!location.startsWith(prefix)) {
    throw new Error("深度冷启动运行缺少可发布的 Global Resolution 产物");
  }
  const resolved = path.normalize(/* turbopackIgnore: true */ location.slice(prefix.length));
  const root = coldStartOutputRoot();
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("深度冷启动产物路径越出允许目录");
  }
  return resolved.endsWith(".json")
    ? resolved
    : path.join(/* turbopackIgnore: true */ resolved, "global-resolution.json");
}

async function findParsedBlocks(sourceSemanticsPath: string): Promise<string> {
  let directory = path.dirname(sourceSemanticsPath);
  while (true) {
    const candidate = path.join(/* turbopackIgnore: true */ directory, "parsed-blocks.json");
    try {
      if ((await stat(/* turbopackIgnore: true */ candidate)).isFile()) return candidate;
    } catch {
      // Continue walking toward the cold-start run root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("深度冷启动产物缺少 parsed-blocks.json");
    directory = parent;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(/* turbopackIgnore: true */ filePath, "utf8")) as unknown;
}

type PublicationRun = {
  id: string;
  sourceBlobId: string | null;
  profile: "catalog" | "coarse" | "deep";
  parserKey: string | null;
  artifactLocation: string | null;
  completedAt: Date | null;
  sourceBlob: { sha256: string } | null;
  libraryNode: { name: string; originalRelativePath: string | null };
  assessment: null | {
    referenceCandidates: Prisma.JsonValue;
    assertionCandidates: Prisma.JsonValue;
    objectCandidates: Prisma.JsonValue;
  };
};

async function loadRuns(jobId: string) {
  return getDatabase().librarySourceProcessingRun.findMany({
    where: {
      jobId,
      status: "ready",
      stage: "ready",
      sourceBlobId: { not: null },
    },
    orderBy: [{ phaseOrder: "asc" }, { createdAt: "asc" }],
    include: {
      sourceBlob: true,
      libraryNode: {
        select: { name: true, originalRelativePath: true },
      },
      assessment: true,
    },
  });
}

function commonObjects(
  runId: string,
  resolvedObjects: GlobalObjectDraft[],
): Array<{ id: string; canonicalName: string }> {
  return draftsForRun(runId, resolvedObjects).map((draft) => ({
    id: objectId(draft),
    canonicalName: draft.canonicalLabel,
  }));
}

function sourcePathForRun(run: PublicationRun): string | null {
  return run.libraryNode.originalRelativePath ?? run.libraryNode.name;
}

export function prepareSemanticPublication(
  run: PublicationRun,
  resolvedObjects: GlobalObjectDraft[],
): PreparedPublication {
  if (!run.sourceBlobId || !run.sourceBlob || !run.assessment) {
    throw new Error("语义编译运行缺少 Blob 或 Assessment");
  }
  const references = z.array(libraryReferenceCandidateSchema)
    .parse(run.assessment.referenceCandidates);
  const assertions = z.array(libraryAssertionCandidateSchema)
    .parse(run.assessment.assertionCandidates);
  const objectCandidates = z.array(libraryObjectCandidateSchema)
    .parse(run.assessment.objectCandidates);
  const prefix = regionPrefix(run.sourceBlobId);
  const sourceRegionId = randomUUID();
  const runDrafts = draftsForRun(run.id, resolvedObjects);
  const draftByNormalizedLabel = new Map<string, GlobalObjectDraft>();
  for (const [index, candidate] of objectCandidates.entries()) {
    const draft = draftForMemberKey(`${run.id}:assessment:${index}`, resolvedObjects);
    draftByNormalizedLabel.set(normalizedLabel(candidate.label), draft);
  }
  for (const draft of runDrafts) {
    for (const member of draft.members.filter((item) => item.runId === run.id)) {
      draftByNormalizedLabel.set(normalizedLabel(member.label), draft);
    }
  }

  const blockByExcerpt = new Map<string, PreparedBlock>();
  const candidateBlocks = [
    ...references.map((candidate) => ({ candidate, kind: "reference" as const })),
    ...assertions.map((candidate) => ({ candidate, kind: "grounded" as const })),
  ].map(({ candidate, kind }) => {
    const key = `${kind}\u0000${candidate.sourceExcerpt}`;
    let block = blockByExcerpt.get(key);
    if (!block) {
      const ordinal = blockByExcerpt.size;
      block = {
        id: randomUUID(),
        sourceBlockId: `${prefix}semantic-block-${ordinal + 1}`,
        localOrder: ordinal,
        blockType: kind === "reference" ? "reference_excerpt" : "grounded_excerpt",
        sourcePages: [],
        headingLevel: null,
        headingPath: [run.libraryNode.name],
        sourceType: "library_compilation",
        sourceSubType: "semantic_excerpt",
        assetPath: null,
        markdown: candidate.sourceExcerpt,
      };
      blockByExcerpt.set(key, block);
    }
    return block;
  });
  const preparedAssertions: PreparedAssertion[] = [
    ...references.map((candidate, index) => ({
      id: randomUUID(),
      sourceRegionId,
      sourceClaimId: `reference-${index + 1}`,
      kind: "reference" as const,
      statementTemplateMarkdown: candidate.statement,
      globalStatementTemplateMarkdown: candidate.statement,
      contextDependent: true,
    })),
    ...assertions.map((candidate, index) => ({
      id: randomUUID(),
      sourceRegionId,
      sourceClaimId: `grounded-${index + 1}`,
      kind: "grounded" as const,
      statementTemplateMarkdown: candidate.statement,
      globalStatementTemplateMarkdown: candidate.statement,
      contextDependent: candidate.contextDependent,
    })),
  ];
  const semanticLinks = [
    ...references.map((candidate, index) => ({ candidate, assertion: preparedAssertions[index] })),
    ...assertions.map((candidate, index) => ({
      candidate,
      assertion: preparedAssertions[references.length + index],
    })),
  ].flatMap(({ candidate, assertion }) => unique(candidate.objectLabels.flatMap((label) => {
    const draft = draftByNormalizedLabel.get(normalizedLabel(label));
    return draft ? [objectId(draft)] : [];
  })).map((globalObjectId) => ({ assertionId: assertion.id, globalObjectId })));

  const fragments: PreparedFragment[] = [];
  const surfaceMemberships: PreparedPublication["surfaceMemberships"] = [];
  for (const [index, draft] of runDrafts.entries()) {
    const surfaceForms = unique(draft.members
      .filter((member) => member.runId === run.id)
      .map((member) => member.label)
      .filter(Boolean));
    if (!surfaceForms.length) continue;
    const fragment: PreparedFragment = {
      id: randomUUID(),
      sourceRegionId,
      sourceFragmentId: `object-${index + 1}`,
      surfaceForms,
    };
    fragments.push(fragment);
    surfaceMemberships.push(...surfaceForms.map((_, surfaceFormOrdinal) => ({
      objectFragmentId: fragment.id,
      surfaceFormOrdinal,
      globalObjectId: objectId(draft),
    })));
  }
  const blocks = [...blockByExcerpt.values()];
  const sourceBlockIds = blocks.map((block) => block.sourceBlockId);
  return {
    runId: run.id,
    sourceBlobId: run.sourceBlobId,
    sourceSha256: run.sourceBlob.sha256,
    prefix,
    profile: run.profile,
    reuseExisting: false,
    objects: commonObjects(run.id, resolvedObjects),
    regions: [{
      id: sourceRegionId,
      sourceNodeId: `${prefix}semantic`,
      schemaVersion: "library-semantics.v1",
      label: run.libraryNode.name,
      lineageNodeIds: [`${prefix}semantic`],
      sourcePages: [],
      sourceBlockIds,
      coveredBlockIds: sourceBlockIds,
      unclaimedBlockIds: [],
      initialClaimCount: preparedAssertions.length,
      reviewAdditionCount: 0,
      modelCalls: 1,
      createdAt: run.completedAt ?? new Date(),
      sourcePath: sourcePathForRun(run),
      sourceTitle: run.libraryNode.name,
      sourceSha256: run.sourceBlob.sha256,
      sourceParser: run.parserKey,
    }],
    blocks,
    fragments,
    assertions: preparedAssertions,
    assertionBlocks: preparedAssertions.map((assertion, index) => ({
      assertionId: assertion.id,
      blockId: candidateBlocks[index].id,
      ordinal: 0,
    })),
    surfaceMemberships,
    semanticLinks,
  };
}

export async function prepareDeepPublication(
  run: PublicationRun,
  resolvedObjects: GlobalObjectDraft[],
): Promise<PreparedPublication> {
  if (!run.sourceBlobId || !run.sourceBlob) {
    throw new Error("深度冷启动运行缺少 Blob");
  }
  const prefix = regionPrefix(run.sourceBlobId);
  if (run.artifactLocation?.startsWith("memory-compilation:")) {
    return {
      runId: run.id,
      sourceBlobId: run.sourceBlobId,
      sourceSha256: run.sourceBlob.sha256,
      prefix,
      profile: "deep",
      reuseExisting: true,
      objects: commonObjects(run.id, resolvedObjects),
      regions: [],
      blocks: [],
      fragments: [],
      assertions: [],
      assertionBlocks: [],
      surfaceMemberships: [],
      semanticLinks: [],
    };
  }
  if (!run.artifactLocation) throw new Error("深度冷启动运行缺少产物位置");
  const resolutionPath = safeDeepResolutionPath(run.artifactLocation);
  const resolutionDirectory = path.dirname(resolutionPath);
  const sourceSemanticsPath = path.resolve(
    /* turbopackIgnore: true */ resolutionDirectory,
    "..",
    "..",
    "source-semantics-full.json",
  );
  const globalAssertionsPath = path.join(
    /* turbopackIgnore: true */ resolutionDirectory,
    "global-assertions.json",
  );
  const parsedBlocksPath = await findParsedBlocks(sourceSemanticsPath);
  const [snapshot, resolution, globalAssertions, parsedBlocks] = await Promise.all([
    readJson(sourceSemanticsPath).then((value) => deepSnapshotSchema.parse(value)),
    readJson(resolutionPath).then((value) => deepResolutionSchema.parse(value)),
    readJson(globalAssertionsPath).then((value) => deepGlobalAssertionsSchema.parse(value)),
    readJson(parsedBlocksPath).then((value) => parsedBlocksSchema.parse(value)),
  ]);
  if (
    snapshot.source.sha256 !== run.sourceBlob.sha256 ||
    resolution.source_sha256 !== run.sourceBlob.sha256 ||
    globalAssertions.source_sha256 !== run.sourceBlob.sha256
  ) {
    throw new Error("深度冷启动发布产物与资料库 Blob SHA-256 不一致");
  }

  const sharedObjectByOldId = new Map<string, { id: string; canonicalName: string }>();
  resolution.global_objects.forEach((object, index) => {
    const draft = draftForMemberKey(`${run.id}:deep:${index}`, resolvedObjects);
    sharedObjectByOldId.set(object.global_object_id, {
      id: objectId(draft),
      canonicalName: draft.canonicalLabel,
    });
  });
  const surfaceOwnerByAtom = new Map<string, string>();
  for (const object of resolution.global_objects) {
    for (const atomId of object.surface_atom_ids) {
      surfaceOwnerByAtom.set(atomId, object.global_object_id);
    }
  }
  const globalAssertionById = new Map(
    globalAssertions.assertions.map((assertion) => [assertion.assertion_id, assertion]),
  );
  const blockIdByOriginal = new Map(parsedBlocks.map((block) => [
    block.block_id,
    `${prefix}deep-block-${block.block_id}`,
  ]));
  const blockDatabaseIdByOriginal = new Map(parsedBlocks.map((block) => [
    block.block_id,
    randomUUID(),
  ]));
  const blocks: PreparedBlock[] = parsedBlocks.map((block, localOrder) => ({
    id: blockDatabaseIdByOriginal.get(block.block_id)!,
    sourceBlockId: blockIdByOriginal.get(block.block_id)!,
    localOrder,
    blockType: block.block_type,
    sourcePages: block.source_pages,
    headingLevel: block.heading_level,
    headingPath: block.heading_path,
    sourceType: block.source_type,
    sourceSubType: block.source_sub_type,
    ...(block.bbox === null ? {} : { bbox: block.bbox as Prisma.InputJsonValue }),
    assetPath: block.asset_path,
    markdown: block.markdown,
  }));
  const regions: PreparedRegion[] = [];
  const fragments: PreparedFragment[] = [];
  const preparedAssertions: PreparedAssertion[] = [];
  const assertionBlocks: PreparedPublication["assertionBlocks"] = [];
  const surfaceMemberships: PreparedPublication["surfaceMemberships"] = [];
  const semanticLinks: PreparedPublication["semanticLinks"] = [];

  for (const source of snapshot.sources) {
    const sourceRegionId = randomUUID();
    const sourceNodeId = `${prefix}deep:${source.region_node_id}`;
    const prefixedBlockIds = source.source_block_ids.map((id) => {
      const mapped = blockIdByOriginal.get(id);
      if (!mapped) throw new Error(`深度冷启动 SourceRegion 引用未知 Block：${id}`);
      return mapped;
    });
    regions.push({
      id: sourceRegionId,
      sourceNodeId,
      schemaVersion: source.schema_version,
      label: source.label,
      lineageNodeIds: source.lineage_node_ids.map((id) => `${prefix}deep:${id}`),
      sourcePages: source.source_pages,
      sourceBlockIds: prefixedBlockIds,
      coveredBlockIds: source.covered_block_ids.map((id) => blockIdByOriginal.get(id)!),
      unclaimedBlockIds: source.unclaimed_block_ids.map((id) => blockIdByOriginal.get(id)!),
      initialClaimCount: source.initial_claim_count,
      reviewAdditionCount: source.review_addition_count,
      modelCalls: source.model_calls,
      createdAt: new Date(source.created_at),
      sourcePath: sourcePathForRun(run),
      sourceTitle: run.libraryNode.name,
      sourceSha256: run.sourceBlob.sha256,
      sourceParser: snapshot.source.parser,
    });
    for (const fragment of source.object_fragments) {
      const preparedFragment: PreparedFragment = {
        id: randomUUID(),
        sourceRegionId,
        sourceFragmentId: fragment.fragment_id,
        surfaceForms: fragment.surface_forms,
      };
      fragments.push(preparedFragment);
      fragment.surface_forms.forEach((_, surfaceFormOrdinal) => {
        const atomId = `surface:${source.region_node_id}:${fragment.fragment_id}:${surfaceFormOrdinal}`;
        const oldObjectId = surfaceOwnerByAtom.get(atomId);
        const sharedObject = oldObjectId ? sharedObjectByOldId.get(oldObjectId) : undefined;
        if (!sharedObject) throw new Error(`深度冷启动 surface atom 没有有效 Object owner：${atomId}`);
        surfaceMemberships.push({
          objectFragmentId: preparedFragment.id,
          surfaceFormOrdinal,
          globalObjectId: sharedObject.id,
        });
      });
    }
    for (const assertion of source.assertions) {
      const assertionKey = `assertion:${source.region_node_id}:${assertion.claim_id}`;
      const global = globalAssertionById.get(assertionKey);
      if (!global) throw new Error(`深度冷启动缺少 Global Assertion：${assertionKey}`);
      const rendered = global.global_statement_template_markdown.replace(
        /\{\{object:([^{}]+)\}\}/g,
        (_, oldObjectId: string) => {
          const shared = sharedObjectByOldId.get(oldObjectId.trim());
          if (!shared) throw new Error(`Global Assertion 引用未知 Object：${oldObjectId}`);
          return shared.canonicalName;
        },
      );
      if (rendered.includes("{{object:") || rendered.includes("{{fragment:")) {
        throw new Error(`深度冷启动 Assertion 仍包含未解析引用：${assertionKey}`);
      }
      const prepared: PreparedAssertion = {
        id: randomUUID(),
        sourceRegionId,
        sourceClaimId: assertion.claim_id,
        kind: assertion.kind,
        statementTemplateMarkdown: rendered,
        globalStatementTemplateMarkdown: rendered,
        contextDependent: assertion.context_dependent,
      };
      preparedAssertions.push(prepared);
      assertion.supporting_block_ids.forEach((blockId, ordinal) => {
        const databaseBlockId = blockDatabaseIdByOriginal.get(blockId);
        if (!databaseBlockId) throw new Error(`深度冷启动 Assertion 引用未知 Block：${blockId}`);
        assertionBlocks.push({ assertionId: prepared.id, blockId: databaseBlockId, ordinal });
      });
      const associatedOldObjectIds = unique([
        ...global.linked_global_object_ids,
        ...global.reference_atoms.map((atom) => atom.global_object_id),
      ]);
      semanticLinks.push(...associatedOldObjectIds.map((oldObjectId) => {
        const shared = sharedObjectByOldId.get(oldObjectId);
        if (!shared) throw new Error(`深度冷启动 Assertion 引用未知 Object：${oldObjectId}`);
        return { assertionId: prepared.id, globalObjectId: shared.id };
      }));
    }
  }
  return {
    runId: run.id,
    sourceBlobId: run.sourceBlobId,
    sourceSha256: run.sourceBlob.sha256,
    prefix,
    profile: "deep",
    reuseExisting: false,
    objects: commonObjects(run.id, resolvedObjects),
    regions,
    blocks,
    fragments,
    assertions: preparedAssertions,
    assertionBlocks,
    surfaceMemberships,
    semanticLinks,
  };
}

async function ensureSharedCompilation(): Promise<string> {
  const database = getDatabase();
  return database.$transaction(async (transaction) => {
    await acquireSharedMemoryPublicationLock(transaction);
    const existing = await transaction.memoryCompilation.findFirst({
      orderBy: [{ importedAt: "desc" }, { id: "desc" }],
    });
    if (existing) return existing.id;
    const id = randomUUID();
    await transaction.memoryCompilation.create({
      data: {
        id,
        schemaVersion: SHARED_COMPILATION_SCHEMA,
        compiledAt: new Date(),
        sourcePath: "library://shared-brain",
        sourceTitle: "Echo Shared Brain",
        sourceSha256: SHARED_SOURCE_SHA,
        sourceParser: "echo-library-publisher",
        sourcePageCount: 0,
        sourceBlockCount: 0,
        sourceTimeText: null,
        sourceTimeSupportingBlockIds: [],
        regionTreeSchemaVersion: "echo-library-tree.v1",
        sourceNodeIds: [],
        sourceNodeCount: 0,
        assertionCount: 0,
        objectFragmentCount: 0,
        surfaceFormCount: 0,
        fragmentReferenceCount: 0,
        modelCalls: 0,
      },
    });
    return id;
  });
}

async function commitPublications(
  compilationId: string,
  publications: PreparedPublication[],
): Promise<void> {
  const database = getDatabase();
  await database.$transaction(async (transaction) => {
    await acquireSharedMemoryPublicationLock(transaction);
    const compilation = await transaction.memoryCompilation.findUnique({
      where: { id: compilationId },
    });
    if (!compilation) throw new Error("Shared Brain Compilation 已变更");
    const latest = await transaction.memoryCompilation.findFirst({
      orderBy: [{ importedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (latest?.id !== compilationId) throw new Error("Shared Brain 活跃 Compilation 已变更");

    // 历史单文档 Compilation 第一次转为多文件 Shared Brain 时，先保住原来的来源身份。
    await transaction.memorySourceRegion.updateMany({
      where: { compilationId, sourceSha256: null },
      data: {
        sourcePath: compilation.sourcePath,
        sourceTitle: compilation.sourceTitle,
        sourceSha256: compilation.sourceSha256,
        sourceParser: compilation.sourceParser,
      },
    });

    for (const publication of publications.filter((item) => !item.reuseExisting)) {
      await transaction.memorySourceRegion.deleteMany({
        where: {
          compilationId,
          OR: [
            { sourceNodeId: { startsWith: publication.prefix } },
            { sourceSha256: publication.sourceSha256 },
          ],
        },
      });
      await transaction.memorySourceBlock.deleteMany({
        where: {
          compilationId,
          sourceBlockId: { startsWith: publication.prefix },
        },
      });
    }

    const objectRows = new Map<string, { id: string; canonicalName: string }>();
    for (const publication of publications) {
      for (const object of publication.objects) {
        const existing = objectRows.get(object.id);
        if (existing && existing.canonicalName !== object.canonicalName) {
          throw new Error(`Shared Brain Object ${object.id} 出现不一致 canonical name`);
        }
        objectRows.set(object.id, object);
      }
    }
    const existingRows = objectRows.size
      ? await transaction.memoryGlobalObject.findMany({
          where: { id: { in: [...objectRows.keys()] } },
          select: { id: true, compilationId: true },
        })
      : [];
    if (existingRows.some((object) => object.compilationId !== compilationId)) {
      throw new Error("Global Object 属于非当前 Shared Brain Compilation");
    }
    for (const object of objectRows.values()) {
      await transaction.memoryGlobalObject.upsert({
        where: { id: object.id },
        create: {
          id: object.id,
          compilationId,
          globalObjectKey: `library:${object.id}`,
          canonicalName: object.canonicalName,
        },
        update: { canonicalName: object.canonicalName },
      });
    }

    const changed = publications.filter((item) => !item.reuseExisting);
    const regions = changed.flatMap((item) => item.regions);
    const blocks = changed.flatMap((item) => item.blocks);
    const fragments = changed.flatMap((item) => item.fragments);
    const assertions = changed.flatMap((item) => item.assertions);
    const assertionBlocks = changed.flatMap((item) => item.assertionBlocks);
    const memberships = changed.flatMap((item) => item.surfaceMemberships);
    const links = changed.flatMap((item) => item.semanticLinks);
    const maximumOrder = await transaction.memorySourceBlock.aggregate({
      where: { compilationId },
      _max: { order: true },
    });
    const orderOffset = (maximumOrder._max.order ?? -1) + 1;

    if (regions.length) await transaction.memorySourceRegion.createMany({
      data: regions.map((region) => ({ ...region, compilationId })),
    });
    if (blocks.length) await transaction.memorySourceBlock.createMany({
      data: blocks.map((block, index) => ({
        id: block.id,
        compilationId,
        sourceBlockId: block.sourceBlockId,
        order: orderOffset + index,
        blockType: block.blockType,
        sourcePages: block.sourcePages,
        headingLevel: block.headingLevel,
        headingPath: block.headingPath,
        sourceType: block.sourceType,
        sourceSubType: block.sourceSubType,
        ...(block.bbox === undefined ? {} : { bbox: block.bbox }),
        assetPath: block.assetPath,
        markdown: block.markdown,
      })),
    });
    if (fragments.length) await transaction.memorySourceObjectFragment.createMany({
      data: fragments.map((fragment) => ({ ...fragment, compilationId })),
    });
    if (assertions.length) await transaction.memoryAssertion.createMany({
      data: assertions.map((assertion) => ({ ...assertion, compilationId })),
    });
    if (assertionBlocks.length) await transaction.memoryAssertionSourceBlock.createMany({
      data: assertionBlocks,
    });
    if (memberships.length) await transaction.memoryGlobalObjectSurfaceMembership.createMany({
      data: memberships,
    });
    if (links.length) await transaction.memoryAssertionSemanticObjectLink.createMany({
      data: unique(links.map((link) => `${link.assertionId}\u0000${link.globalObjectId}`)).map((key) => {
        const [assertionId, globalObjectId] = key.split("\u0000");
        return { assertionId, globalObjectId };
      }),
    });
    if (changed.length) {
      // 内容已变更后不对外声称旧向量索引仍然完整；事务提交后会尝试全量重建。
      await transaction.memoryAssertionEmbeddingIndex.deleteMany({
        where: { compilationId },
      });
    }

    await transaction.memoryGlobalObject.deleteMany({
      where: {
        compilationId,
        surfaceMemberships: { none: {} },
        chatMentions: { none: {} },
        referenceResolutions: { none: {} },
        literalReferences: { none: {} },
        semanticAssertionLinks: { none: {} },
        higherMemory: { is: null },
        semanticCards: { none: {} },
      },
    });

    const [allRegions, sourceBlockCount, assertionCount, allFragments, fragmentReferenceCount] =
      await Promise.all([
        transaction.memorySourceRegion.findMany({
          where: { compilationId },
          orderBy: { sourceNodeId: "asc" },
          select: { sourceNodeId: true, sourcePages: true, modelCalls: true, sourceSha256: true },
        }),
        transaction.memorySourceBlock.count({ where: { compilationId } }),
        transaction.memoryAssertion.count({ where: { compilationId } }),
        transaction.memorySourceObjectFragment.findMany({
          where: { compilationId },
          select: { surfaceForms: true },
        }),
        transaction.memoryAssertionFragmentReference.count({
          where: { assertion: { compilationId } },
        }),
      ]);
    const pageKeys = new Set(allRegions.flatMap((region) =>
      region.sourcePages.map((page) => `${region.sourceSha256 ?? "legacy"}:${page}`)
    ));
    await transaction.memoryCompilation.update({
      where: { id: compilationId },
      data: {
        schemaVersion: SHARED_COMPILATION_SCHEMA,
        compiledAt: new Date(),
        importedAt: new Date(),
        sourcePath: "library://shared-brain",
        sourceTitle: "Echo Shared Brain",
        sourceSha256: SHARED_SOURCE_SHA,
        sourceParser: "echo-library-publisher",
        sourcePageCount: pageKeys.size,
        sourceBlockCount,
        sourceTimeText: null,
        sourceTimeSupportingBlockIds: [],
        regionTreeSchemaVersion: "echo-library-tree.v1",
        sourceNodeIds: allRegions.map((region) => region.sourceNodeId),
        sourceNodeCount: allRegions.length,
        assertionCount,
        objectFragmentCount: allFragments.length,
        surfaceFormCount: allFragments.reduce(
          (total, fragment) => total + fragment.surfaceForms.length,
          0,
        ),
        fragmentReferenceCount,
        modelCalls: allRegions.reduce((total, region) => total + region.modelCalls, 0),
      },
    });
    for (const publication of publications) {
      const sourceObjectCount = new Set([
        ...publication.surfaceMemberships.map((item) => item.globalObjectId),
        ...publication.semanticLinks.map((item) => item.globalObjectId),
      ]).size || publication.objects.length;
      await transaction.librarySourceProcessingRun.update({
        where: { id: publication.runId },
        data: {
          publishedAt: new Date(),
          publishedAssertionCount: publication.reuseExisting
            ? await transaction.memoryAssertion.count({
                where: {
                  compilationId,
                  sourceRegion: { sourceSha256: publication.sourceSha256 },
                },
              })
            : publication.assertions.length,
          publishedObjectCount: sourceObjectCount,
        },
      });
    }
  }, { maxWait: 30_000, timeout: 300_000 });
}

export async function publishLibraryRunsToSharedMemory(input: {
  jobId: string;
  resolvedObjects: GlobalObjectDraft[];
}): Promise<SharedMemoryPublicationResult> {
  const database = getDatabase();
  const runs = await loadRuns(input.jobId);
  const publications: PreparedPublication[] = [];
  for (const run of runs) {
    publications.push(run.profile === "deep"
      ? await prepareDeepPublication(run, input.resolvedObjects)
      : prepareSemanticPublication(run, input.resolvedObjects));
  }
  const compilationId = await ensureSharedCompilation();
  await database.libraryCompilationJob.update({
    where: { id: input.jobId },
    data: { globalStatusMessage: "正在把编译结果发布到 Shared Brain" },
  });
  await commitPublications(compilationId, publications);

  let embeddingStatus: SharedMemoryPublicationResult["embeddingStatus"] = "empty";
  let embeddingWarning: string | undefined;
  const assertionTotal = await database.memoryAssertion.count({ where: { compilationId } });
  if (assertionTotal > 0) {
    try {
      await rebuildMemoryAssertionIndex({
        compilationId,
        onProgress: async (completed, total) => {
          await database.libraryCompilationJob.update({
            where: { id: input.jobId },
            data: {
              globalStatusMessage: `Shared Brain 向量索引 ${completed}/${total}`,
            },
          });
        },
      });
      embeddingStatus = "ready";
    } catch (error) {
      embeddingStatus = "unavailable";
      embeddingWarning = error instanceof Error ? error.message : String(error);
    }
  }
  const [assertionCount, objectCount] = await Promise.all([
    database.memoryAssertion.count({ where: { compilationId } }),
    database.memoryGlobalObject.count({ where: { compilationId } }),
  ]);
  await database.libraryCompilationJob.update({
    where: { id: input.jobId },
    data: {
      globalStatusMessage: embeddingStatus === "unavailable"
        ? `Shared Brain 已发布 ${assertionCount} 条 Assertion；向量索引暂不可用`
        : `Shared Brain 已发布 ${assertionCount} 条 Assertion、${objectCount} 个 Object`,
    },
  });
  return {
    compilationId,
    publishedRunCount: publications.length,
    assertionCount,
    objectCount,
    embeddingStatus,
    ...(embeddingWarning ? { embeddingWarning } : {}),
  };
}
