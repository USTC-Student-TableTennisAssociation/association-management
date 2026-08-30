import "dotenv/config";

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, opendir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { Pool } from "pg";

const ROOT_ID = "00000000-0000-4000-8000-000000000100";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);

const MIME_BY_EXTENSION = {
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rar": "application/vnd.rar",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

function usage() {
  console.log("Usage: pnpm library:import -- <file-or-directory> [--name <display name>]");
}

function parseArguments(argv) {
  const positional = [];
  let displayName;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      continue;
    } else if (value === "--name") {
      displayName = argv[index + 1];
      index += 1;
      if (!displayName) throw new Error("--name 需要一个名称");
    } else {
      positional.push(value);
    }
  }
  if (positional.length !== 1) {
    usage();
    process.exitCode = 1;
    return null;
  }
  return { sourceDirectory: path.resolve(positional[0]), displayName };
}

function normalizeName(name) {
  return name.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function storageRoot() {
  return path.resolve(
    process.env.SYDARIS_LIBRARY_STORAGE_ROOT?.trim() || path.join(projectDirectory, ".sydaris-library"),
  );
}

function storageKey(sha256) {
  return path.posix.join("blobs", sha256.slice(0, 2), sha256);
}

async function hashFile(filePath) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

async function storeFile(filePath, sha256) {
  const key = storageKey(sha256);
  const destination = path.join(storageRoot(), ...key.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await access(destination);
  } catch {
    try {
      await copyFile(filePath, destination, 1);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const [sourceInfo, destinationInfo] = await Promise.all([stat(filePath), stat(destination)]);
  if (sourceInfo.size !== destinationInfo.size) {
    throw new Error(`对象存储大小校验失败：${filePath}`);
  }
  return {
    storageKey: key,
    byteSize: BigInt(sourceInfo.size),
    mimeType: MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
  };
}

async function availableName(database, parentId, desiredName) {
  const extension = path.extname(desiredName);
  const stem = extension ? desiredName.slice(0, -extension.length) : desiredName;
  for (let sequence = 1; sequence < 10_000; sequence += 1) {
    const candidate = sequence === 1 ? desiredName : `${stem} (${sequence})${extension}`;
    const conflict = await database.libraryNode.findFirst({
      where: { parentId, normalizedName: normalizeName(candidate) },
      select: { id: true },
    });
    if (!conflict) return candidate;
  }
  throw new Error(`无法为“${desiredName}”生成可用名称`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) return;
  const sourceInfo = await stat(options.sourceDirectory);
  if (!sourceInfo.isDirectory() && !sourceInfo.isFile()) {
    throw new Error("导入路径必须是普通文件或文件夹");
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is not configured");

  const pool = new Pool({ connectionString });
  const database = new PrismaClient({ adapter: new PrismaPg(pool) });
  let batchId;
  let fileCount = 0;
  const uniqueHashes = new Set();
  try {
    await database.libraryNode.upsert({
      where: { id: ROOT_ID },
      update: {},
      create: {
        id: ROOT_ID,
        kind: "folder",
        name: "资料库",
        normalizedName: normalizeName("资料库"),
      },
    });
    const displayName = options.displayName?.trim() || path.basename(options.sourceDirectory);
    const batch = await database.libraryImportBatch.create({
      data: { displayName, originalRoot: options.sourceDirectory, status: "running" },
    });
    batchId = batch.id;

    async function importFile(localPath, virtualParentId, desiredName, relativePath) {
      const nodeName = await availableName(database, virtualParentId, desiredName);
      const sha256 = await hashFile(localPath);
      const stored = await storeFile(localPath, sha256);
      const blob = await database.librarySourceBlob.upsert({
        where: { sha256 },
        update: {},
        create: { sha256, ...stored },
      });
      await database.libraryNode.create({
        data: {
          kind: "file",
          parentId: virtualParentId,
          name: nodeName,
          normalizedName: normalizeName(nodeName),
          blobId: blob.id,
          importBatchId: batch.id,
          originalRelativePath: relativePath,
          processingProfile: "catalog",
        },
      });
      fileCount += 1;
      uniqueHashes.add(sha256);
      if (fileCount % 25 === 0) console.log(`已导入 ${fileCount} 个文件…`);
      return nodeName;
    }

    async function importDirectory(localDirectory, virtualParentId, relativeDirectory) {
      const directory = await opendir(localDirectory);
      const entries = [];
      for await (const entry of directory) entries.push(entry);
      entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
      for (const entry of entries) {
        const localPath = path.join(localDirectory, entry.name);
        const relativePath = relativeDirectory
          ? path.join(relativeDirectory, entry.name)
          : entry.name;
        const nodeName = await availableName(database, virtualParentId, entry.name);
        if (entry.isDirectory()) {
          const folder = await database.libraryNode.create({
            data: {
              kind: "folder",
              parentId: virtualParentId,
              name: nodeName,
              normalizedName: normalizeName(nodeName),
              importBatchId: batch.id,
              originalRelativePath: relativePath,
            },
          });
          await importDirectory(localPath, folder.id, relativePath);
        } else if (entry.isFile()) {
          await importFile(localPath, virtualParentId, nodeName, relativePath);
        } else {
          console.warn(`跳过非普通文件：${localPath}`);
        }
      }
    }

    let importedName;
    if (sourceInfo.isDirectory()) {
      const rootName = await availableName(database, ROOT_ID, displayName);
      const importedRoot = await database.libraryNode.create({
        data: {
          kind: "folder",
          parentId: ROOT_ID,
          name: rootName,
          normalizedName: normalizeName(rootName),
          importBatchId: batch.id,
          originalRelativePath: ".",
        },
      });
      importedName = rootName;
      await importDirectory(options.sourceDirectory, importedRoot.id, "");
    } else {
      importedName = await importFile(
        options.sourceDirectory,
        ROOT_ID,
        options.displayName?.trim() || path.basename(options.sourceDirectory),
        path.basename(options.sourceDirectory),
      );
    }
    await database.libraryImportBatch.update({
      where: { id: batch.id },
      data: {
        status: "ready",
        fileCount,
        uniqueBlobCount: uniqueHashes.size,
        completedAt: new Date(),
      },
    });
    console.log(`导入完成：${fileCount} 个文件，${uniqueHashes.size} 个唯一内容对象。`);
    console.log(`资料库项目：${importedName}`);
    console.log(`对象存储：${storageRoot()}`);
  } catch (error) {
    if (batchId) {
      await database.libraryImportBatch.update({
        where: { id: batchId },
        data: {
          status: "failed",
          fileCount,
          uniqueBlobCount: uniqueHashes.size,
          errorMessage: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await database.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
