import { beforeEach, describe, expect, it, vi } from "vitest";

const sourceState = vi.hoisted(() => ({ read: vi.fn() }));
const authState = vi.hoisted(() => ({ current: vi.fn() }));

vi.mock("@/auth/session", () => ({
  currentAuthUser: authState.current,
  unauthorizedResponse: () => Response.json({ error: "请先登录。" }, { status: 401 }),
}));

vi.mock("@/memory/source-document", () => ({
  readSourceDocumentRange: sourceState.read,
  SourceDocumentReadError: class SourceDocumentReadError extends Error {},
}));

import { GET } from "@/app/api/source-documents/[documentId]/excerpt/route";

beforeEach(() => {
  vi.clearAllMocks();
  authState.current.mockResolvedValue({ userId: "user-1" });
  sourceState.read.mockResolvedValue({
    document: { id: "doc-1", title: "测试原文" },
    blocks: [{ sourceBlockId: "block-1", markdown: "按需正文" }],
  });
});

describe("GET /api/source-documents/[documentId]/excerpt", () => {
  it("loads only the cited continuous Block range", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/source-documents/doc-1/excerpt?startBlockId=block-1&endBlockId=block-3",
      ),
      { params: Promise.resolve({ documentId: "doc-1" }) },
    );

    expect(response.status).toBe(200);
    expect(sourceState.read).toHaveBeenCalledWith({
      sourceDocumentId: "doc-1",
      startBlockId: "block-1",
      endBlockId: "block-3",
    });
    expect(await response.json()).toEqual(expect.objectContaining({
      blocks: [expect.objectContaining({ markdown: "按需正文" })],
    }));
  });

  it("rejects an incomplete reference without querying the database", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/source-documents/doc-1/excerpt?startBlockId=block-1",
      ),
      { params: Promise.resolve({ documentId: "doc-1" }) },
    );

    expect(response.status).toBe(400);
    expect(sourceState.read).not.toHaveBeenCalled();
  });
});
