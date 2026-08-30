import { describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({
  findBlocks: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDatabase: () => ({
    memorySourceBlock: { findMany: databaseState.findBlocks },
  }),
}));

import { extractLibraryPreview } from "@/library/preview-extractor";

describe("extractLibraryPreview", () => {
  it("does not start MinerU when a chat preview has not explicitly allowed parsing", async () => {
    databaseState.findBlocks.mockResolvedValue([]);

    const preview = await extractLibraryPreview({
      storageKey: `blobs/${"a".repeat(2)}/${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      parserKey: "docx",
      parseDocumentsIfMissing: false,
    });

    expect(preview.parser).toBe("preview-not-parsed");
    expect(preview.text).toBeUndefined();
    expect(preview.warning).toContain("未获授权启动 MinerU");
  });
});
