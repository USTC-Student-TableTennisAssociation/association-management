import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({
  upsert: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDatabase: () => ({
    libraryNode: {
      upsert: databaseState.upsert,
      findMany: databaseState.findMany,
    },
  }),
}));

import {
  LIBRARY_ROOT_ID,
  listLibraryDescendants,
} from "@/library/service";

const updatedAt = new Date("2026-08-15T00:00:00.000Z");

describe("listLibraryDescendants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseState.upsert.mockResolvedValue({ id: LIBRARY_ROOT_ID, name: "资料库" });
  });

  it("returns a filtered union of several folders and reports truncation", async () => {
    databaseState.findMany
      .mockResolvedValueOnce([
        { id: "00000000-0000-4000-8000-000000000201", parentId: LIBRARY_ROOT_ID, name: "活动一", kind: "folder" },
        { id: "00000000-0000-4000-8000-000000000202", parentId: LIBRARY_ROOT_ID, name: "活动二", kind: "folder" },
      ])
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000201",
          parentId: LIBRARY_ROOT_ID,
          kind: "folder",
          name: "活动一",
          originalRelativePath: "活动一",
          processingProfile: "catalog",
          processingStatus: "idle",
          updatedAt,
          blob: null,
        },
        {
          id: "00000000-0000-4000-8000-000000000202",
          parentId: LIBRARY_ROOT_ID,
          kind: "folder",
          name: "活动二",
          originalRelativePath: "活动二",
          processingProfile: "catalog",
          processingStatus: "idle",
          updatedAt,
          blob: null,
        },
        {
          id: "00000000-0000-4000-8000-000000000211",
          parentId: "00000000-0000-4000-8000-000000000201",
          kind: "file",
          name: "策划案.docx",
          originalRelativePath: "活动一/策划案.docx",
          processingProfile: "catalog",
          processingStatus: "idle",
          updatedAt,
          blob: null,
        },
        {
          id: "00000000-0000-4000-8000-000000000212",
          parentId: "00000000-0000-4000-8000-000000000202",
          kind: "file",
          name: "通知.docx",
          originalRelativePath: "活动二/通知.docx",
          processingProfile: "catalog",
          processingStatus: "idle",
          updatedAt,
          blob: null,
        },
        {
          id: "00000000-0000-4000-8000-000000000213",
          parentId: "00000000-0000-4000-8000-000000000202",
          kind: "file",
          name: "已处理.docx",
          originalRelativePath: "活动二/已处理.docx",
          processingProfile: "coarse",
          processingStatus: "ready",
          updatedAt,
          blob: null,
        },
      ]);

    const result = await listLibraryDescendants({
      folderIds: [
        "00000000-0000-4000-8000-000000000201",
        "00000000-0000-4000-8000-000000000202",
      ],
      kind: "file",
      profile: "catalog",
      limit: 1,
    });

    expect(result.folders.map((folder) => folder.name)).toEqual(["活动一", "活动二"]);
    expect(result.items).toHaveLength(1);
    expect(result.matchedCount).toBe(2);
    expect(result.offset).toBe(0);
    expect(result.returnedCount).toBe(1);
    expect(result.nextOffset).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("continues a recursive listing from the returned offset", async () => {
    databaseState.findMany
      .mockResolvedValueOnce([
        { id: "00000000-0000-4000-8000-000000000201", parentId: LIBRARY_ROOT_ID, name: "活动", kind: "folder" },
      ])
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000201",
          parentId: LIBRARY_ROOT_ID,
          kind: "folder",
          name: "活动",
          originalRelativePath: "活动",
          processingProfile: "catalog",
          processingStatus: "idle",
          updatedAt,
          blob: null,
        },
        ...["a", "b"].map((name, index) => ({
          id: `00000000-0000-4000-8000-00000000021${index + 1}`,
          parentId: "00000000-0000-4000-8000-000000000201",
          kind: "file",
          name: `${name}.docx`,
          originalRelativePath: `活动/${name}.docx`,
          processingProfile: "catalog",
          processingStatus: "idle",
          updatedAt,
          blob: null,
        })),
      ]);

    const result = await listLibraryDescendants({
      folderId: "00000000-0000-4000-8000-000000000201",
      kind: "file",
      offset: 1,
      limit: 1,
    });

    expect(result.items.map((item) => item.name)).toEqual(["b.docx"]);
    expect(result.offset).toBe(1);
    expect(result.returnedCount).toBe(1);
    expect(result.nextOffset).toBeUndefined();
    expect(result.truncated).toBe(false);
  });
});
