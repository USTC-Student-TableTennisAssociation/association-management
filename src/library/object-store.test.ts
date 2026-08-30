import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readStoredFile,
  resolveStorageKey,
} from "@/library/object-store";
import {
  deleteStoredFile,
  hashFile,
  storeLocalFile,
  storeUploadedFile,
} from "@/library/object-store-import";

const temporaryDirectories: string[] = [];
const originalStorageRoot = process.env.SYDARIS_LIBRARY_STORAGE_ROOT;

afterEach(async () => {
  if (originalStorageRoot === undefined) delete process.env.SYDARIS_LIBRARY_STORAGE_ROOT;
  else process.env.SYDARIS_LIBRARY_STORAGE_ROOT = originalStorageRoot;
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("library object store", () => {
  it("stores and reads a content-addressed copy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sydaris-library-test-"));
    temporaryDirectories.push(directory);
    process.env.SYDARIS_LIBRARY_STORAGE_ROOT = path.join(directory, "objects");
    const source = path.join(directory, "记录.txt");
    await writeFile(source, "test");
    const sha256 = await hashFile(source);
    const stored = await storeLocalFile(source, sha256);
    expect(stored.byteSize).toBe(BigInt(4));
    expect((await readStoredFile(stored.storageKey)).toString()).toBe("test");
  });

  it("prevents storage-key path traversal", () => {
    process.env.SYDARIS_LIBRARY_STORAGE_ROOT = path.join(tmpdir(), "sydaris-library-root");
    expect(() => resolveStorageKey("../outside")).toThrow("路径越界");
  });

  it("stores browser uploads by content hash and deletes the exact blob", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sydaris-library-upload-test-"));
    temporaryDirectories.push(directory);
    process.env.SYDARIS_LIBRARY_STORAGE_ROOT = path.join(directory, "objects");
    const stored = await storeUploadedFile(new File(["sydaris-upload"], "记录.txt", {
      type: "text/plain",
    }));
    expect(stored.mimeType).toBe("text/plain");
    expect((await readStoredFile(stored.storageKey)).toString()).toBe("sydaris-upload");
    expect(await deleteStoredFile(stored.storageKey)).toBe(true);
    expect(await deleteStoredFile(stored.storageKey)).toBe(false);
  });
});
