import { randomUUID } from "node:crypto";
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
  prefix: string;
  profile: "catalog" | "coarse" | "deep";
  document: {
    title: string;
    parser: string;
  };
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
  objectLinks: Array<{ assertionId: string; globalObjectId: string }>;
  objectCoverage: Array<{ assertionId: string; globalObjectId: string }>;
};

export type SharedMemoryPublicationResult = {
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
      hashtextextended('sydaris-shared-memory-publication', 0)
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
  const configured = process.env.SYDARIS_COLD_START_OUTPUT_ROOT?.trim();
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
  libraryNode: { name: string };
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
        select: { name: true },
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
  const associations = [
    ...references.map((candidate, index) => ({ candidate, assertion: preparedAssertions[index] })),
    ...assertions.map((candidate, index) => ({
      candidate,
      assertion: preparedAssertions[references.length + index],
    })),
  ].flatMap(({ candidate, assertion }) => unique(candidate.objectLabels.flatMap((label) => {
    const draft = draftByNormalizedLabel.get(normalizedLabel(label));
    return draft ? [objectId(draft)] : [];
  })).map((globalObjectId) => ({ assertionId: assertion.id, globalObjectId })));
  const assertionKindById = new Map(preparedAssertions.map((assertion) => [assertion.id, assertion.kind]));
  const objectLinks = associations.filter((link) => assertionKindById.get(link.assertionId) === "grounded");
  const objectCoverage = associations.filter((link) => assertionKindById.get(link.assertionId) === "reference");

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
    prefix,
    profile: run.profile,
    document: {
      title: run.libraryNode.name,
      parser: run.parserKey ?? "library-assessment",
    },
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
    objectLinks,
    objectCoverage,
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
  const objectLinks: PreparedPublication["objectLinks"] = [];
  const objectCoverage: PreparedPublication["objectCoverage"] = [];

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
      const targetAssociations = assertion.kind === "grounded" ? objectLinks : objectCoverage;
      targetAssociations.push(...associatedOldObjectIds.map((oldObjectId) => {
        const shared = sharedObjectByOldId.get(oldObjectId);
        if (!shared) throw new Error(`深度冷启动 Assertion 引用未知 Object：${oldObjectId}`);
        return { assertionId: prepared.id, globalObjectId: shared.id };
      }));
    }
  }
  return {
    runId: run.id,
    sourceBlobId: run.sourceBlobId,
    prefix,
    profile: "deep",
    document: {
      title: run.libraryNode.name,
      parser: snapshot.source.parser,
    },
    objects: commonObjects(run.id, resolvedObjects),
    regions,
    blocks,
    fragments,
    assertions: preparedAssertions,
    assertionBlocks,
    surfaceMemberships,
    objectLinks,
    objectCoverage,
  };
}

async function commitPublications(
  publications: PreparedPublication[],
): Promise<void> {
  const database = getDatabase();
  await database.$transaction(async (transaction) => {
    await acquireSharedMemoryPublicationLock(transaction);

    for (const publication of publications) {
      await transaction.memorySourceRegion.deleteMany({
        where: {
          sourceNodeId: { startsWith: publication.prefix },
        },
      });
      await transaction.memorySourceBlock.deleteMany({
        where: {
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
    for (const object of objectRows.values()) {
      await transaction.memoryGlobalObject.upsert({
        where: { id: object.id },
        create: {
          id: object.id,
          globalObjectKey: `library:${object.id}`,
          canonicalName: object.canonicalName,
        },
        update: { canonicalName: object.canonicalName },
      });
    }

    const sourceDocumentIdByRun = new Map<string, string>();
    for (const publication of publications) {
      const document = await transaction.librarySourceDocument.upsert({
        where: { processingRunId: publication.runId },
        create: {
          processingRunId: publication.runId,
          sourceBlobId: publication.sourceBlobId,
          title: publication.document.title,
          parser: publication.document.parser,
          blockCount: publication.blocks.length,
        },
        update: {
          sourceBlobId: publication.sourceBlobId,
          title: publication.document.title,
          parser: publication.document.parser,
          blockCount: publication.blocks.length,
        },
        select: { id: true },
      });
      sourceDocumentIdByRun.set(publication.runId, document.id);
    }
    const regions = publications.flatMap((item) =>
      item.regions.map((region) => ({
        ...region,
        sourceDocumentId: sourceDocumentIdByRun.get(item.runId)!,
      }))
    );
    const blocks = publications.flatMap((item) =>
      item.blocks.map((block) => ({
        ...block,
        sourceDocumentId: sourceDocumentIdByRun.get(item.runId)!,
      }))
    );
    const fragments = publications.flatMap((item) => item.fragments);
    const assertions = publications.flatMap((item) => item.assertions);
    const assertionBlocks = publications.flatMap((item) => item.assertionBlocks);
    const memberships = publications.flatMap((item) => item.surfaceMemberships);
    const links = publications.flatMap((item) => item.objectLinks);
    const coverage = publications.flatMap((item) => item.objectCoverage);
    if (regions.length) await transaction.memorySourceRegion.createMany({
      data: regions,
    });
    if (blocks.length) await transaction.memorySourceBlock.createMany({
      data: blocks.map((block) => ({
        id: block.id,
        sourceDocumentId: block.sourceDocumentId,
        sourceBlockId: block.sourceBlockId,
        order: block.localOrder,
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
      data: fragments,
    });
    if (assertions.length) await transaction.memoryAssertion.createMany({
      data: assertions,
    });
    if (assertionBlocks.length) await transaction.memoryAssertionSourceBlock.createMany({
      data: assertionBlocks,
    });
    if (memberships.length) await transaction.memoryGlobalObjectSurfaceMembership.createMany({
      data: memberships,
    });
    if (links.length) await transaction.memoryAssertionObjectLink.createMany({
      data: unique(links.map((link) => `${link.assertionId}\u0000${link.globalObjectId}`)).map((key) => {
        const [assertionId, globalObjectId] = key.split("\u0000");
        return { assertionId, globalObjectId };
      }),
    });
    if (coverage.length) await transaction.memoryAssertionObjectCoverage.createMany({
      data: unique(coverage.map((link) => `${link.assertionId}\u0000${link.globalObjectId}`)).map((key) => {
        const [assertionId, globalObjectId] = key.split("\u0000");
        return { assertionId, globalObjectId };
      }),
    });
    if (publications.length) {
      // 内容已变更后不对外声称旧向量索引仍然完整；事务提交后会尝试全量重建。
      await transaction.memoryAssertionEmbeddingIndex.deleteMany();
    }

    await transaction.librarySourceDocument.deleteMany({
      where: {
        sourceRegions: { none: {} },
        sourceBlocks: { none: {} },
      },
    });

    await transaction.memoryGlobalObject.deleteMany({
      where: {
        surfaceMemberships: { none: {} },
        chatMentions: { none: {} },
        assertionLinks: { none: {} },
        assertionCoverage: { none: {} },
        higherMemory: { is: null },
        relatedViewCards: { none: {} },
      },
    });

    for (const publication of publications) {
      const sourceObjectCount = new Set([
        ...publication.surfaceMemberships.map((item) => item.globalObjectId),
        ...publication.objectLinks.map((item) => item.globalObjectId),
        ...publication.objectCoverage.map((item) => item.globalObjectId),
      ]).size || publication.objects.length;
      await transaction.librarySourceProcessingRun.update({
        where: { id: publication.runId },
        data: {
          publishedAt: new Date(),
          publishedAssertionCount: publication.assertions.length,
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
  await database.libraryCompilationJob.update({
    where: { id: input.jobId },
    data: { globalStatusMessage: "正在把编译结果发布到 Shared Brain" },
  });
  await commitPublications(publications);

  let embeddingStatus: SharedMemoryPublicationResult["embeddingStatus"] = "empty";
  let embeddingWarning: string | undefined;
  const assertionTotal = await database.memoryAssertion.count();
  if (assertionTotal > 0) {
    try {
      await rebuildMemoryAssertionIndex({
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
    database.memoryAssertion.count(),
    database.memoryGlobalObject.count(),
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
    publishedRunCount: publications.length,
    assertionCount,
    objectCount,
    embeddingStatus,
    ...(embeddingWarning ? { embeddingWarning } : {}),
  };
}
