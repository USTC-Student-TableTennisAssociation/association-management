import { Prisma } from "@/generated/prisma/client";
import { getDatabase } from "@/db";
import {
  deleteStoredFile,
  storeUploadedFile,
} from "@/library/object-store-import";
import {
  libraryPlanPayloadSchema,
  type LibraryDeleteResult,
  type LibraryFolderView,
  type LibraryImportBatchView,
  type LibraryImportFileResult,
  type LibraryListing,
  type LibraryNodeView,
  type LibraryPlanOperation,
  type LibraryPlanPresentation,
  type LibraryProcessingProfile,
  type LibraryRecursiveListing,
} from "@/library/types";

export const LIBRARY_ROOT_ID = "00000000-0000-4000-8000-000000000100";

export class LibraryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryValidationError";
  }
}

export function normalizeLibraryName(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

export function validateLibraryName(input: string): string {
  const name = input.normalize("NFC").trim();
  if (!name || name === "." || name === "..") {
    throw new LibraryValidationError("文件或文件夹名称不能为空");
  }
  if (name.length > 255) throw new LibraryValidationError("名称不能超过 255 个字符");
  if (/[<>:"/\\|?*\0]/.test(name)) {
    throw new LibraryValidationError("名称包含 Windows 文件系统不允许的字符");
  }
  if (/[. ]$/.test(name)) {
    throw new LibraryValidationError("名称不能以句点或空格结尾");
  }
  return name;
}

export async function ensureLibraryRoot(): Promise<{ id: string; name: string }> {
  const database = getDatabase();
  return database.libraryNode.upsert({
    where: { id: LIBRARY_ROOT_ID },
    update: {},
    create: {
      id: LIBRARY_ROOT_ID,
      kind: "folder",
      name: "资料库",
      normalizedName: normalizeLibraryName("资料库"),
      processingProfile: "catalog",
      processingStatus: "idle",
    },
    select: { id: true, name: true },
  });
}

function folderView(node: { id: string; parentId: string | null; name: string }): LibraryFolderView {
  return {
    id: node.id,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    name: node.name,
  };
}

function nodeView(node: {
  id: string;
  kind: "file" | "folder";
  parentId: string | null;
  name: string;
  processingProfile: "catalog" | "coarse" | "deep";
  processingStatus: "idle" | "queued" | "running" | "ready" | "failed";
  originalRelativePath: string | null;
  updatedAt: Date;
  blob: null | {
    sha256: string;
    mimeType: string;
    byteSize: bigint;
    _count: { nodes: number };
  };
}): LibraryNodeView {
  return {
    id: node.id,
    kind: node.kind,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    name: node.name,
    processingProfile: node.processingProfile,
    processingStatus: node.processingStatus,
    ...(node.originalRelativePath
      ? { originalRelativePath: node.originalRelativePath }
      : {}),
    ...(node.blob
      ? {
          mimeType: node.blob.mimeType,
          byteSize: node.blob.byteSize.toString(),
          sha256: node.blob.sha256,
        }
      : {}),
    duplicateCount: Math.max(0, (node.blob?._count.nodes ?? 1) - 1),
    updatedAt: node.updatedAt.toISOString(),
  };
}

async function breadcrumbsFor(nodeId: string): Promise<Array<{ id: string; name: string }>> {
  const database = getDatabase();
  const entries: Array<{ id: string; name: string }> = [];
  let currentId: string | null = nodeId;
  let guard = 0;
  while (currentId) {
    if (guard++ > 1_000) throw new LibraryValidationError("资料库目录树存在循环");
    const node: { id: string; parentId: string | null; name: string } | null =
      await database.libraryNode.findUnique({
        where: { id: currentId },
        select: { id: true, parentId: true, name: true },
      });
    if (!node) throw new LibraryValidationError("资料库文件夹不存在");
    entries.push({ id: node.id, name: node.name });
    currentId = node.parentId;
  }
  return entries.reverse();
}

export async function getLibraryListing(parentId?: string): Promise<LibraryListing> {
  const database = getDatabase();
  const root = await ensureLibraryRoot();
  const folderId = parentId ?? root.id;
  const folder = await database.libraryNode.findUnique({
    where: { id: folderId },
    select: { id: true, parentId: true, name: true, kind: true },
  });
  if (!folder || folder.kind !== "folder") {
    throw new LibraryValidationError("资料库文件夹不存在");
  }
  const [children, allFolders, grouped, uniqueBlobs] = await Promise.all([
    database.libraryNode.findMany({
      where: { parentId: folderId },
      orderBy: [{ kind: "desc" }, { name: "asc" }],
      include: {
        blob: {
          select: {
            sha256: true,
            mimeType: true,
            byteSize: true,
            _count: { select: { nodes: true } },
          },
        },
      },
    }),
    database.libraryNode.findMany({
      where: { kind: "folder", id: { not: root.id } },
      orderBy: { name: "asc" },
      select: { id: true, parentId: true, name: true },
    }),
    database.libraryNode.groupBy({
      by: ["kind", "processingProfile"],
      where: { id: { not: root.id } },
      _count: { _all: true },
    }),
    database.librarySourceBlob.count(),
  ]);
  const count = (kind: "file" | "folder", profile?: LibraryProcessingProfile) =>
    grouped
      .filter((item) => item.kind === kind && (!profile || item.processingProfile === profile))
      .reduce((total, item) => total + item._count._all, 0);
  return {
    rootId: root.id,
    folder: folderView(folder),
    breadcrumbs: await breadcrumbsFor(folder.id),
    folders: allFolders.map(folderView),
    items: children.map(nodeView),
    summary: {
      files: count("file"),
      folders: count("folder"),
      catalog: count("file", "catalog"),
      coarse: count("file", "coarse"),
      deep: count("file", "deep"),
      uniqueBlobs,
    },
  };
}

export async function searchLibrary(input: {
  query?: string;
  queries?: string[];
  folderId?: string;
  limit?: number;
  offset?: number;
  kind?: "file" | "folder";
  profile?: LibraryProcessingProfile;
  extensions?: string[];
  includeNoise?: boolean;
}): Promise<LibraryNodeView[]> {
  const database = getDatabase();
  await ensureLibraryRoot();
  const queries = normalizedLibraryQueries(input.query, input.queries);
  const extensions = normalizedLibraryExtensions(input.extensions);
  const conditions: Prisma.LibraryNodeWhereInput[] = [];
  if (queries.length) {
    conditions.push({
      OR: queries.flatMap((query) => [
        { name: { contains: query, mode: "insensitive" as const } },
        { originalRelativePath: { contains: query, mode: "insensitive" as const } },
      ]),
    });
  }
  if (extensions.length) {
    conditions.push({
      kind: "file",
      OR: extensions.map((extension) => ({
        name: { endsWith: `.${extension}`, mode: "insensitive" as const },
      })),
    });
  }
  if (!input.includeNoise) {
    conditions.push({
      NOT: [
        { name: { equals: ".DS_Store", mode: "insensitive" } },
        { name: { equals: "desktop.ini", mode: "insensitive" } },
        { name: { equals: "Thumbs.db", mode: "insensitive" } },
        { name: { equals: ".localized", mode: "insensitive" } },
        { name: { startsWith: "~$" } },
        { name: { startsWith: "._" } },
        { name: { equals: "__MACOSX", mode: "insensitive" } },
        { name: { equals: "$RECYCLE.BIN", mode: "insensitive" } },
      ],
    });
  }
  const nodes = await database.libraryNode.findMany({
    where: {
      id: { not: LIBRARY_ROOT_ID },
      ...(input.folderId ? { parentId: input.folderId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.profile ? { processingProfile: input.profile } : {}),
      ...(conditions.length ? { AND: conditions } : {}),
    },
    orderBy: [{ kind: "desc" }, { updatedAt: "desc" }],
    skip: Math.max(input.offset ?? 0, 0),
    take: Math.min(Math.max(input.limit ?? 100, 1), 1_000),
    include: {
      blob: {
        select: {
          sha256: true,
          mimeType: true,
          byteSize: true,
          _count: { select: { nodes: true } },
        },
      },
    },
  });
  return nodes.map(nodeView);
}

type LibraryDescendantIndexNode = {
  id: string;
  parentId: string | null;
  kind: "file" | "folder";
  name: string;
  originalRelativePath: string | null;
  processingProfile: LibraryProcessingProfile;
};

const LIBRARY_NOISE_NAMES = new Set([
  ".ds_store",
  "desktop.ini",
  "thumbs.db",
  "ehthumbs.db",
  ".localized",
  "icon\r",
  "__macosx",
  "$recycle.bin",
  ".spotlight-v100",
  ".trashes",
  ".temporaryitems",
]);

export function isLibraryNoiseName(value: string): boolean {
  const name = value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  return LIBRARY_NOISE_NAMES.has(name) || name.startsWith("~$") || name.startsWith("._");
}

function normalizedLibrarySearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function normalizedLibraryQueries(query?: string, queries?: string[]): string[] {
  return [...new Set([query, ...(queries ?? [])]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map(normalizedLibrarySearchText))];
}

function normalizedLibraryExtensions(extensions?: string[]): string[] {
  return [...new Set((extensions ?? [])
    .map((extension) => extension.normalize("NFKC").trim().toLocaleLowerCase("en-US"))
    .map((extension) => extension.replace(/^\*?\./, ""))
    .filter((extension) => /^[a-z0-9][a-z0-9+_-]{0,19}$/.test(extension)))];
}

export function selectLibraryDescendantIds(input: {
  folderIds: string[];
  nodes: LibraryDescendantIndexNode[];
  query?: string;
  queries?: string[];
  kind?: "file" | "folder";
  profile?: LibraryProcessingProfile;
  extensions?: string[];
  includeNoise?: boolean;
}): string[] {
  const childrenByParent = new Map<string, LibraryDescendantIndexNode[]>();
  for (const node of input.nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id);
    });
  }

  const rootFolderIds = [...new Set(input.folderIds)];
  const rootFolderIdSet = new Set(rootFolderIds);
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  for (const folderId of rootFolderIds) {
    let current = nodesById.get(folderId);
    const ancestorIds = new Set<string>();
    while (current) {
      if (ancestorIds.has(current.id)) {
        throw new LibraryValidationError("资料库目录树存在循环");
      }
      ancestorIds.add(current.id);
      current = current.parentId ? nodesById.get(current.parentId) : undefined;
    }
  }
  const queries = normalizedLibraryQueries(input.query, input.queries);
  const extensions = normalizedLibraryExtensions(input.extensions);
  const pending = rootFolderIds.flatMap((folderId) => childrenByParent.get(folderId) ?? []);
  const visited = new Set<string>(rootFolderIds);
  const matchedIds: string[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const node = pending[index];
    if (visited.has(node.id)) {
      if (rootFolderIdSet.has(node.id)) continue;
      throw new LibraryValidationError("资料库目录树存在循环");
    }
    visited.add(node.id);
    if (!input.includeNoise && isLibraryNoiseName(node.name)) continue;
    if (node.kind === "folder") {
      pending.push(...(childrenByParent.get(node.id) ?? []));
    }

    const searchableText = normalizedLibrarySearchText(
      `${node.name}\n${node.originalRelativePath ?? ""}`,
    );
    if (
      (!input.kind || node.kind === input.kind) &&
      (!input.profile || node.processingProfile === input.profile) &&
      (!queries.length || queries.some((query) => searchableText.includes(query))) &&
      (!extensions.length || (
        node.kind === "file" &&
        extensions.some((extension) => normalizedLibrarySearchText(node.name).endsWith(`.${extension}`))
      ))
    ) {
      matchedIds.push(node.id);
    }
  }
  return matchedIds;
}

export async function listLibraryDescendants(input: {
  folderId?: string;
  folderIds?: string[];
  query?: string;
  queries?: string[];
  limit?: number;
  offset?: number;
  kind?: "file" | "folder";
  profile?: LibraryProcessingProfile;
  extensions?: string[];
  includeNoise?: boolean;
}): Promise<LibraryRecursiveListing> {
  const database = getDatabase();
  const root = await ensureLibraryRoot();
  const requestedFolderIds = [...new Set([
    ...(input.folderIds ?? []),
    ...(input.folderId ? [input.folderId] : []),
  ])];
  const folderIds = requestedFolderIds.length ? requestedFolderIds : [root.id];
  if (folderIds.length > 50) {
    throw new LibraryValidationError("一次最多递归查询 50 个文件夹");
  }
  const folders = await database.libraryNode.findMany({
    where: { id: { in: folderIds } },
    select: { id: true, parentId: true, name: true, kind: true },
  });
  if (
    folders.length !== folderIds.length ||
    folders.some((folder) => folder.kind !== "folder")
  ) {
    throw new LibraryValidationError("一个或多个资料库文件夹不存在");
  }

  const nodes = await database.libraryNode.findMany({
    where: { id: { not: root.id } },
    include: {
      blob: {
        select: {
          sha256: true,
          mimeType: true,
          byteSize: true,
          _count: { select: { nodes: true } },
        },
      },
    },
  });
  const matchedIds = selectLibraryDescendantIds({
    folderIds,
    nodes,
    query: input.query,
    queries: input.queries,
    kind: input.kind,
    profile: input.profile,
    extensions: input.extensions,
    includeNoise: input.includeNoise,
  });
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const limit = Math.min(Math.max(input.limit ?? 300, 1), 1_000);
  const offset = Math.min(Math.max(input.offset ?? 0, 0), matchedIds.length);
  const items = matchedIds
    .slice(offset, offset + limit)
    .map((id) => nodesById.get(id))
    .filter((node): node is (typeof nodes)[number] => Boolean(node))
    .map(nodeView);
  return {
    folders: folderIds.map((id) => {
      const folder = folders.find((candidate) => candidate.id === id);
      if (!folder) throw new LibraryValidationError("资料库文件夹不存在");
      return folderView(folder);
    }),
    items,
    matchedCount: matchedIds.length,
    offset,
    returnedCount: items.length,
    ...(offset + items.length < matchedIds.length
      ? { nextOffset: offset + items.length }
      : {}),
    truncated: offset + items.length < matchedIds.length,
  };
}

export async function inspectLibraryNodes(nodeIds: string[]): Promise<LibraryNodeView[]> {
  const uniqueIds = [...new Set(nodeIds)].slice(0, 100);
  const nodes = await getDatabase().libraryNode.findMany({
    where: { id: { in: uniqueIds, not: LIBRARY_ROOT_ID } },
    orderBy: { name: "asc" },
    include: {
      blob: {
        select: {
          sha256: true,
          mimeType: true,
          byteSize: true,
          _count: { select: { nodes: true } },
        },
      },
    },
  });
  return nodes.map(nodeView);
}

async function requireFolder(
  database: Prisma.TransactionClient | ReturnType<typeof getDatabase>,
  folderId: string,
): Promise<void> {
  const folder = await database.libraryNode.findUnique({
    where: { id: folderId },
    select: { kind: true },
  });
  if (!folder || folder.kind !== "folder") {
    throw new LibraryValidationError("目标文件夹不存在");
  }
}

async function assertAvailableName(
  database: Prisma.TransactionClient | ReturnType<typeof getDatabase>,
  parentId: string,
  name: string,
  excludingIds: string[] = [],
): Promise<void> {
  const conflict = await database.libraryNode.findFirst({
    where: {
      parentId,
      normalizedName: normalizeLibraryName(name),
      ...(excludingIds.length ? { id: { notIn: excludingIds } } : {}),
    },
    select: { id: true },
  });
  if (conflict) throw new LibraryValidationError(`目标文件夹中已存在“${name}”`);
}

async function availableLibraryName(
  database: Prisma.TransactionClient | ReturnType<typeof getDatabase>,
  parentId: string,
  desiredName: string,
): Promise<string> {
  const extensionIndex = desiredName.lastIndexOf(".");
  const hasExtension = extensionIndex > 0;
  const extension = hasExtension ? desiredName.slice(extensionIndex) : "";
  const stem = hasExtension ? desiredName.slice(0, extensionIndex) : desiredName;
  for (let sequence = 1; sequence < 10_000; sequence += 1) {
    const candidate = sequence === 1 ? desiredName : `${stem} (${sequence})${extension}`;
    const conflict = await database.libraryNode.findFirst({
      where: { parentId, normalizedName: normalizeLibraryName(candidate) },
      select: { id: true },
    });
    if (!conflict) return candidate;
  }
  throw new LibraryValidationError(`无法为“${desiredName}”生成可用名称`);
}

export function libraryUploadPathSegments(relativePath: string): string[] {
  const normalized = relativePath.normalize("NFC").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) {
    throw new LibraryValidationError("导入文件路径必须是相对路径");
  }
  const rawSegments = normalized.split("/");
  if (rawSegments.length > 100 || normalized.length > 4_096) {
    throw new LibraryValidationError("导入文件路径过深或过长");
  }
  if (rawSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new LibraryValidationError("导入文件路径包含无效层级");
  }
  return rawSegments.map(validateLibraryName);
}

async function ensureUploadFolderPath(
  database: Prisma.TransactionClient,
  parentId: string,
  folderNames: string[],
  batchId: string,
): Promise<string> {
  let currentId = parentId;
  const relativeParts: string[] = [];
  for (const name of folderNames) {
    relativeParts.push(name);
    const existing = await database.libraryNode.findFirst({
      where: { parentId: currentId, normalizedName: normalizeLibraryName(name) },
      select: { id: true, kind: true },
    });
    if (existing) {
      if (existing.kind !== "folder") {
        throw new LibraryValidationError(`导入路径中的“${name}”已是文件`);
      }
      currentId = existing.id;
      continue;
    }
    const created = await database.libraryNode.create({
      data: {
        kind: "folder",
        parentId: currentId,
        name,
        normalizedName: normalizeLibraryName(name),
        importBatchId: batchId,
        originalRelativePath: relativeParts.join("/"),
      },
      select: { id: true },
    });
    currentId = created.id;
  }
  return currentId;
}

export async function startLibraryBrowserImport(input: {
  parentId: string;
  displayName: string;
  rootFolderName?: string;
}): Promise<LibraryImportBatchView> {
  const database = getDatabase();
  await requireFolder(database, input.parentId);
  const displayName = input.displayName.normalize("NFC").trim().slice(0, 255);
  if (!displayName) throw new LibraryValidationError("导入名称不能为空");
  return database.$transaction(async (transaction) => {
    const batch = await transaction.libraryImportBatch.create({
      data: {
        displayName,
        originalRoot: "browser-upload",
        status: "running",
      },
      select: { id: true },
    });
    let uploadParentId = input.parentId;
    if (input.rootFolderName) {
      const desiredName = validateLibraryName(input.rootFolderName);
      const name = await availableLibraryName(transaction, input.parentId, desiredName);
      const folder = await transaction.libraryNode.create({
        data: {
          kind: "folder",
          parentId: input.parentId,
          name,
          normalizedName: normalizeLibraryName(name),
          importBatchId: batch.id,
          originalRelativePath: ".",
        },
        select: { id: true },
      });
      uploadParentId = folder.id;
    }
    return { id: batch.id, uploadParentId };
  });
}

export async function importLibraryBrowserFiles(input: {
  batchId: string;
  parentId: string;
  files: Array<{ file: File; relativePath: string }>;
}): Promise<LibraryImportFileResult[]> {
  if (!input.files.length || input.files.length > 12) {
    throw new LibraryValidationError("每批请送需包含 1–12 个文件");
  }
  const maximumFileBytes = 128 * 1024 * 1024;
  const maximumBatchBytes = 256 * 1024 * 1024;
  if (input.files.some(({ file }) => file.size > maximumFileBytes)) {
    throw new LibraryValidationError("单个文件不能超过 128 MB");
  }
  if (input.files.reduce((total, { file }) => total + file.size, 0) > maximumBatchBytes) {
    throw new LibraryValidationError("单批上传不能超过 256 MB");
  }
  const database = getDatabase();
  const batch = await database.libraryImportBatch.findUnique({
    where: { id: input.batchId },
    select: { status: true },
  });
  if (!batch || batch.status !== "running") {
    throw new LibraryValidationError("导入批次不存在或已结束");
  }
  await requireFolder(database, input.parentId);
  const results: LibraryImportFileResult[] = [];
  for (const entry of input.files) {
    const segments = libraryUploadPathSegments(entry.relativePath);
    const desiredName = segments.at(-1)!;
    const stored = await storeUploadedFile(entry.file);
    const created = await database.$transaction(async (transaction) => {
      const parentId = await ensureUploadFolderPath(
        transaction,
        input.parentId,
        segments.slice(0, -1),
        input.batchId,
      );
      const name = await availableLibraryName(transaction, parentId, desiredName);
      const blob = await transaction.librarySourceBlob.upsert({
        where: { sha256: stored.sha256 },
        update: {},
        create: stored,
        select: { id: true },
      });
      return transaction.libraryNode.create({
        data: {
          kind: "file",
          parentId,
          name,
          normalizedName: normalizeLibraryName(name),
          blobId: blob.id,
          importBatchId: input.batchId,
          originalRelativePath: segments.join("/"),
          processingProfile: "catalog",
          processingStatus: "idle",
        },
        select: { id: true, name: true },
      });
    });
    results.push({
      nodeId: created.id,
      name: created.name,
      sha256: stored.sha256,
      byteSize: stored.byteSize.toString(),
    });
  }
  return results;
}

export async function finishLibraryBrowserImport(input: {
  batchId: string;
  errorMessage?: string;
}): Promise<{ fileCount: number; uniqueBlobCount: number; status: "ready" | "failed" }> {
  const database = getDatabase();
  const files = await database.libraryNode.findMany({
    where: { importBatchId: input.batchId, kind: "file" },
    select: { blobId: true },
  });
  const uniqueBlobCount = new Set(files.flatMap((file) => file.blobId ? [file.blobId] : [])).size;
  const status = input.errorMessage ? "failed" as const : "ready" as const;
  const updated = await database.libraryImportBatch.updateMany({
    where: { id: input.batchId, status: "running" },
    data: {
      status,
      fileCount: files.length,
      uniqueBlobCount,
      errorMessage: input.errorMessage?.slice(0, 4_000),
      completedAt: new Date(),
    },
  });
  if (!updated.count) throw new LibraryValidationError("导入批次不存在或已结束");
  return { fileCount: files.length, uniqueBlobCount, status };
}

export async function deleteLibraryNodes(input: {
  nodeIds: string[];
}): Promise<LibraryDeleteResult> {
  const requestedIds = [...new Set(input.nodeIds)];
  if (!requestedIds.length || requestedIds.length > 200) {
    throw new LibraryValidationError("请选择 1–200 个要删除的项目");
  }
  if (requestedIds.includes(LIBRARY_ROOT_ID)) {
    throw new LibraryValidationError("不能删除资料库根目录");
  }
  const database = getDatabase();
  const requested = await database.libraryNode.findMany({
    where: { id: { in: requestedIds } },
    select: { id: true },
  });
  if (requested.length !== requestedIds.length) {
    throw new LibraryValidationError("部分资料库项目不存在");
  }
  const allIds = new Set(requestedIds);
  let frontier = requestedIds;
  let guard = 0;
  while (frontier.length) {
    if (guard++ > 1_000) throw new LibraryValidationError("资料库目录树存在循环");
    const children = await database.libraryNode.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((child) => child.id).filter((id) => !allIds.has(id));
    for (const id of frontier) allIds.add(id);
  }
  const deletionIds = [...allIds];
  const [activeNodes, activeRuns, nodes] = await Promise.all([
    database.libraryNode.count({
      where: { id: { in: deletionIds }, processingStatus: { in: ["queued", "running"] } },
    }),
    database.librarySourceProcessingRun.count({
      where: { libraryNodeId: { in: deletionIds }, status: { in: ["queued", "running"] } },
    }),
    database.libraryNode.findMany({
      where: { id: { in: deletionIds } },
      select: { blobId: true, importBatchId: true },
    }),
  ]);
  if (activeNodes || activeRuns) {
    throw new LibraryValidationError("所选项目中有文件正在处理，请暂停任务后再删除");
  }
  const blobIds = [...new Set(nodes.flatMap((node) => node.blobId ? [node.blobId] : []))];
  const importBatchIds = [...new Set(nodes.flatMap((node) =>
    node.importBatchId ? [node.importBatchId] : []
  ))];
  const cleanup = await database.$transaction(async (transaction) => {
    const remaining = new Set(deletionIds);
    while (remaining.size) {
      const leafNodes = await transaction.libraryNode.findMany({
        where: {
          id: { in: [...remaining] },
          children: { none: { id: { in: [...remaining] } } },
        },
        select: { id: true },
      });
      if (!leafNodes.length) throw new LibraryValidationError("资料库目录树存在循环");
      const leafIds = leafNodes.map((node) => node.id);
      await transaction.libraryNode.deleteMany({ where: { id: { in: leafIds } } });
      for (const id of leafIds) remaining.delete(id);
    }
    const orphanedBlobs = await transaction.librarySourceBlob.findMany({
      where: {
        id: { in: blobIds },
        nodes: { none: {} },
        processingRuns: { none: {} },
        catalogAssessments: { none: {} },
      },
      select: { id: true, storageKey: true },
    });
    if (orphanedBlobs.length) {
      await transaction.librarySourceBlob.deleteMany({
        where: { id: { in: orphanedBlobs.map((blob) => blob.id) } },
      });
    }
    const emptyBatches = await transaction.libraryImportBatch.findMany({
      where: { id: { in: importBatchIds }, nodes: { none: {} } },
      select: { id: true },
    });
    if (emptyBatches.length) {
      await transaction.libraryImportBatch.deleteMany({
        where: { id: { in: emptyBatches.map((batch) => batch.id) } },
      });
    }
    return { orphanedBlobs, deletedImportBatches: emptyBatches.length };
  });
  const storageWarnings: string[] = [];
  for (const blob of cleanup.orphanedBlobs) {
    try {
      await deleteStoredFile(blob.storageKey);
    } catch (error) {
      storageWarnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    deletedNodes: deletionIds.length,
    deletedBlobs: cleanup.orphanedBlobs.length,
    deletedImportBatches: cleanup.deletedImportBatches,
    retainedSharedBlobs: Math.max(0, blobIds.length - cleanup.orphanedBlobs.length),
    storageWarnings,
  };
}

export async function createLibraryFolder(input: {
  parentId: string;
  name: string;
}): Promise<LibraryFolderView> {
  const database = getDatabase();
  const name = validateLibraryName(input.name);
  await requireFolder(database, input.parentId);
  await assertAvailableName(database, input.parentId, name);
  return folderView(await database.libraryNode.create({
    data: {
      kind: "folder",
      parentId: input.parentId,
      name,
      normalizedName: normalizeLibraryName(name),
    },
    select: { id: true, parentId: true, name: true },
  }));
}

export async function renameLibraryNode(input: {
  nodeId: string;
  name: string;
}): Promise<void> {
  if (input.nodeId === LIBRARY_ROOT_ID) {
    throw new LibraryValidationError("不能重命名资料库根目录");
  }
  const database = getDatabase();
  const node = await database.libraryNode.findUnique({
    where: { id: input.nodeId },
    select: { parentId: true },
  });
  if (!node?.parentId) throw new LibraryValidationError("资料库节点不存在");
  const name = validateLibraryName(input.name);
  await assertAvailableName(database, node.parentId, name, [input.nodeId]);
  await database.libraryNode.update({
    where: { id: input.nodeId },
    data: { name, normalizedName: normalizeLibraryName(name) },
  });
}

async function assertMoveDoesNotCycle(
  database: Prisma.TransactionClient | ReturnType<typeof getDatabase>,
  nodeId: string,
  targetFolderId: string,
): Promise<void> {
  let currentId: string | null = targetFolderId;
  let guard = 0;
  while (currentId) {
    if (currentId === nodeId) {
      throw new LibraryValidationError("不能把文件夹移动到自身或其子文件夹中");
    }
    if (guard++ > 1_000) throw new LibraryValidationError("资料库目录树存在循环");
    const node: { parentId: string | null } | null = await database.libraryNode.findUnique({
      where: { id: currentId },
      select: { parentId: true },
    });
    if (!node) throw new LibraryValidationError("目标文件夹不存在");
    currentId = node.parentId;
  }
}

async function moveNodesWithDatabase(
  database: Prisma.TransactionClient,
  nodeIds: string[],
  targetFolderId: string,
): Promise<void> {
  await requireFolder(database, targetFolderId);
  if (nodeIds.includes(LIBRARY_ROOT_ID)) {
    throw new LibraryValidationError("不能移动资料库根目录");
  }
  const uniqueIds = [...new Set(nodeIds)];
  const nodes = await database.libraryNode.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, name: true, normalizedName: true },
  });
  if (nodes.length !== uniqueIds.length) throw new LibraryValidationError("部分资料库节点不存在");
  if (new Set(nodes.map((node) => node.normalizedName)).size !== nodes.length) {
    throw new LibraryValidationError("所选文件移动后会产生同名冲突");
  }
  for (const node of nodes) {
    await assertMoveDoesNotCycle(database, node.id, targetFolderId);
    await assertAvailableName(database, targetFolderId, node.name, uniqueIds);
  }
  await database.libraryNode.updateMany({
    where: { id: { in: uniqueIds } },
    data: { parentId: targetFolderId },
  });
}

export async function moveLibraryNodes(input: {
  nodeIds: string[];
  targetFolderId: string;
}): Promise<void> {
  await getDatabase().$transaction((transaction) =>
    moveNodesWithDatabase(transaction, input.nodeIds, input.targetFolderId),
  );
}

export async function setLibraryProcessingProfile(input: {
  nodeIds: string[];
  profile: LibraryProcessingProfile;
}): Promise<number> {
  const result = await getDatabase().libraryNode.updateMany({
    where: { id: { in: [...new Set(input.nodeIds)] }, kind: "file" },
    data: {
      processingProfile: input.profile,
      processingStatus: "idle",
    },
  });
  if (!result.count) throw new LibraryValidationError("没有可修改的文件");
  return result.count;
}

export async function queueLibraryProcessing(input: {
  nodeIds: string[];
  profile: Exclude<LibraryProcessingProfile, "catalog">;
}): Promise<number> {
  const uniqueIds = [...new Set(input.nodeIds)];
  if (!uniqueIds.length) throw new LibraryValidationError("请选择要处理的文件");
  return getDatabase().$transaction(async (transaction) => {
    const files = await transaction.libraryNode.findMany({
      where: { id: { in: uniqueIds }, kind: "file" },
      select: { id: true },
    });
    if (files.length !== uniqueIds.length) {
      throw new LibraryValidationError("只有文件可以进入解析队列");
    }
    await transaction.librarySourceProcessingRun.createMany({
      data: files.map((file) => ({
        libraryNodeId: file.id,
        profile: input.profile,
        profileVersion: "v1-skeleton",
        status: "queued",
      })),
    });
    await transaction.libraryNode.updateMany({
      where: { id: { in: uniqueIds } },
      data: { processingProfile: input.profile, processingStatus: "queued" },
    });
    return files.length;
  });
}

function operationDescription(operation: LibraryPlanOperation): string {
  if (operation.type === "CREATE_FOLDER") return `新建文件夹：${operation.name}`;
  if (operation.type === "MOVE_NODES") return `移动 ${operation.nodeIds.length} 个项目`;
  return `将 ${operation.nodeIds.length} 份文件设为 ${operation.profile}`;
}

function planPresentation(plan: {
  id: string;
  status: "pending" | "rejected" | "applied" | "failed";
  reason: string;
  operations: unknown;
  createdAt: Date;
  failureReason: string | null;
}): LibraryPlanPresentation {
  const operations = libraryPlanPayloadSchema.shape.operations.parse(plan.operations);
  return {
    id: plan.id,
    status: plan.status,
    reason: plan.reason,
    createdAt: plan.createdAt.toISOString(),
    ...(plan.failureReason ? { failureReason: plan.failureReason } : {}),
    operations: operations.map((operation) => ({
      ...operation,
      description: operationDescription(operation),
    })),
  };
}

export async function createLibraryPlan(raw: unknown): Promise<LibraryPlanPresentation> {
  const payload = libraryPlanPayloadSchema.parse(raw);
  const plan = await getDatabase().libraryPlan.create({
    data: { reason: payload.reason, operations: payload.operations },
  });
  return planPresentation(plan);
}

function resolveFolderSelector(
  selector: string,
  createdFolders: Map<string, string>,
): string {
  if (selector === "root") return LIBRARY_ROOT_ID;
  if (selector.startsWith("new:")) {
    const id = createdFolders.get(selector.slice(4));
    if (!id) throw new LibraryValidationError(`未知的新文件夹引用 ${selector}`);
    return id;
  }
  return selector;
}

async function applyPlanOperations(
  transaction: Prisma.TransactionClient,
  operations: LibraryPlanOperation[],
): Promise<void> {
  const createdFolders = new Map<string, string>();
  for (const operation of operations) {
    if (operation.type === "CREATE_FOLDER") {
      if (createdFolders.has(operation.folderRef)) {
        throw new LibraryValidationError(`重复的新文件夹引用 ${operation.folderRef}`);
      }
      const parentId = resolveFolderSelector(operation.parent, createdFolders);
      const name = validateLibraryName(operation.name);
      await requireFolder(transaction, parentId);
      await assertAvailableName(transaction, parentId, name);
      const created = await transaction.libraryNode.create({
        data: {
          kind: "folder",
          parentId,
          name,
          normalizedName: normalizeLibraryName(name),
        },
        select: { id: true },
      });
      createdFolders.set(operation.folderRef, created.id);
    } else if (operation.type === "MOVE_NODES") {
      await moveNodesWithDatabase(
        transaction,
        operation.nodeIds,
        resolveFolderSelector(operation.target, createdFolders),
      );
    } else {
      const result = await transaction.libraryNode.updateMany({
        where: { id: { in: [...new Set(operation.nodeIds)] }, kind: "file" },
        data: { processingProfile: operation.profile, processingStatus: "idle" },
      });
      if (!result.count) throw new LibraryValidationError("Proposal 没有命中可修改的文件");
    }
  }
}

export async function decideLibraryPlan(input: {
  planId: string;
  decision: "approve" | "reject";
}): Promise<LibraryPlanPresentation> {
  const database = getDatabase();
  const existing = await database.libraryPlan.findUnique({ where: { id: input.planId } });
  if (!existing) throw new LibraryValidationError("资料库整理建议不存在");
  if (existing.status !== "pending") throw new LibraryValidationError("资料库整理建议已经处理");
  if (input.decision === "reject") {
    return planPresentation(await database.libraryPlan.update({
      where: { id: existing.id },
      data: { status: "rejected", decidedAt: new Date() },
    }));
  }
  const operations = libraryPlanPayloadSchema.shape.operations.parse(existing.operations);
  try {
    return planPresentation(await database.$transaction(async (transaction) => {
      await applyPlanOperations(transaction, operations);
      return transaction.libraryPlan.update({
        where: { id: existing.id },
        data: { status: "applied", decidedAt: new Date(), appliedAt: new Date() },
      });
    }));
  } catch (error) {
    const failed = await database.libraryPlan.update({
      where: { id: existing.id },
      data: {
        status: "failed",
        decidedAt: new Date(),
        failureReason: error instanceof Error ? error.message : String(error),
      },
    });
    return planPresentation(failed);
  }
}

export async function getLibraryFile(nodeId: string) {
  const node = await getDatabase().libraryNode.findUnique({
    where: { id: nodeId },
    include: { blob: true },
  });
  if (!node || node.kind !== "file" || !node.blob) {
    throw new LibraryValidationError("资料库文件不存在");
  }
  return node;
}
