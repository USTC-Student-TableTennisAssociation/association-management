import { readFile } from "node:fs/promises";
import path from "node:path";

export function libraryStorageRoot(): string {
  const configured = process.env.SYDARIS_LIBRARY_STORAGE_ROOT?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("SYDARIS_LIBRARY_STORAGE_ROOT 必须是绝对路径");
    }
    return path.normalize(/* turbopackIgnore: true */ configured);
  }
  return path.join(/* turbopackIgnore: true */ process.cwd(), ".sydaris-library");
}

export function blobStorageKey(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("无效的 SHA-256");
  return path.posix.join("blobs", sha256.slice(0, 2), sha256);
}

export function resolveStorageKey(storageKey: string): string {
  if (!/^blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(storageKey)) {
    throw new Error("资料库对象路径越界");
  }
  return path.join(
    /* turbopackIgnore: true */ libraryStorageRoot(),
    ...storageKey.split("/"),
  );
}

export async function readStoredFile(storageKey: string): Promise<Buffer> {
  return readFile(/* turbopackIgnore: true */ resolveStorageKey(storageKey));
}
