import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  blobStorageKey,
  resolveStorageKey,
} from "@/library/object-store";

const MIME_BY_EXTENSION: Record<string, string> = {
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

export function mimeTypeForFile(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream";
}

function mimeTypeForUpload(fileName: string, browserMimeType: string): string {
  const byExtension = mimeTypeForFile(fileName);
  if (byExtension !== "application/octet-stream") return byExtension;
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(browserMimeType)
    ? browserMimeType
    : "application/octet-stream";
}

export async function hashFile(filePath: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

export async function storeLocalFile(filePath: string, sha256: string): Promise<{
  storageKey: string;
  byteSize: bigint;
  mimeType: string;
}> {
  const storageKey = blobStorageKey(sha256);
  const destination = resolveStorageKey(storageKey);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await access(destination, constants.F_OK);
  } catch {
    try {
      await copyFile(filePath, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const sourceStat = await stat(filePath);
  const destinationStat = await stat(destination);
  if (sourceStat.size !== destinationStat.size) {
    throw new Error(`资料库对象大小校验失败：${filePath}`);
  }
  return {
    storageKey,
    byteSize: BigInt(sourceStat.size),
    mimeType: mimeTypeForFile(filePath),
  };
}

export async function storeUploadedFile(file: File): Promise<{
  sha256: string;
  storageKey: string;
  byteSize: bigint;
  mimeType: string;
}> {
  const contents = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const storageKey = blobStorageKey(sha256);
  const destination = resolveStorageKey(storageKey);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(
      /* turbopackIgnore: true */ destination,
      contents,
      { flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const destinationStat = await stat(/* turbopackIgnore: true */ destination);
  if (destinationStat.size !== contents.byteLength) {
    throw new Error(`资料库对象大小校验失败：${file.name}`);
  }
  return {
    sha256,
    storageKey,
    byteSize: BigInt(contents.byteLength),
    mimeType: mimeTypeForUpload(file.name, file.type),
  };
}

export async function deleteStoredFile(storageKey: string): Promise<boolean> {
  try {
    await unlink(/* turbopackIgnore: true */ resolveStorageKey(storageKey));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
