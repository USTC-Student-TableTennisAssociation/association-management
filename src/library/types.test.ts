import { describe, expect, it } from "vitest";

import {
  libraryUploadPathSegments,
  normalizeLibraryName,
  selectLibraryDescendantIds,
  validateLibraryName,
} from "@/library/service";
import { libraryPlanPayloadSchema } from "@/library/types";

describe("library names", () => {
  it("normalizes full-width and case differences for conflict detection", () => {
    expect(normalizeLibraryName("Ａ活动 ")).toBe("a活动");
  });

  it("rejects Windows-incompatible names", () => {
    expect(() => validateLibraryName("a/b")).toThrow("不允许的字符");
    expect(() => validateLibraryName("report. ")).toThrow("句点或空格");
  });

  it("accepts safe browser folder paths and rejects traversal", () => {
    expect(libraryUploadPathSegments("活动/策划案.docx")).toEqual(["活动", "策划案.docx"]);
    expect(() => libraryUploadPathSegments("../策划案.docx")).toThrow("无效层级");
    expect(() => libraryUploadPathSegments("/tmp/策划案.docx")).toThrow("相对路径");
  });
});

describe("library proposals", () => {
  it("accepts a folder-ref plan that can be applied sequentially", () => {
    const result = libraryPlanPayloadSchema.parse({
      reason: "把策划案粗编译，其余只归档",
      operations: [
        { type: "CREATE_FOLDER", folderRef: "plans", parent: "root", name: "策划案" },
        {
          type: "MOVE_NODES",
          nodeIds: ["00000000-0000-4000-8000-000000000201"],
          target: "new:plans",
        },
        {
          type: "SET_PROFILE",
          nodeIds: ["00000000-0000-4000-8000-000000000201"],
          profile: "coarse",
        },
      ],
    });
    expect(result.operations).toHaveLength(3);
  });
});

describe("recursive library selection", () => {
  const nodes = [
    {
      id: "year",
      parentId: "root",
      kind: "folder" as const,
      name: "25-26",
      originalRelativePath: "25-26",
      processingProfile: "catalog" as const,
    },
    {
      id: "activity",
      parentId: "year",
      kind: "folder" as const,
      name: "继往开来",
      originalRelativePath: "25-26/继往开来",
      processingProfile: "catalog" as const,
    },
    {
      id: "plan",
      parentId: "activity",
      kind: "file" as const,
      name: "策划案.docx",
      originalRelativePath: "25-26/继往开来/策划案.docx",
      processingProfile: "coarse" as const,
    },
    {
      id: "photo",
      parentId: "activity",
      kind: "file" as const,
      name: "合影.jpg",
      originalRelativePath: "25-26/继往开来/合影.jpg",
      processingProfile: "catalog" as const,
    },
    {
      id: "sibling",
      parentId: "root",
      kind: "file" as const,
      name: "其他策划案.docx",
      originalRelativePath: "其他策划案.docx",
      processingProfile: "coarse" as const,
    },
    {
      id: "notice",
      parentId: "activity",
      kind: "file" as const,
      name: "比赛通知.PDF",
      originalRelativePath: "25-26/继往开来/比赛通知.PDF",
      processingProfile: "catalog" as const,
    },
    {
      id: "office-lock",
      parentId: "activity",
      kind: "file" as const,
      name: "~$策划案.docx",
      originalRelativePath: "25-26/继往开来/~$策划案.docx",
      processingProfile: "catalog" as const,
    },
    {
      id: "macos-noise",
      parentId: "year",
      kind: "folder" as const,
      name: "__MACOSX",
      originalRelativePath: "25-26/__MACOSX",
      processingProfile: "catalog" as const,
    },
    {
      id: "noise-child",
      parentId: "macos-noise",
      kind: "file" as const,
      name: "策划备份.docx",
      originalRelativePath: "25-26/__MACOSX/策划备份.docx",
      processingProfile: "catalog" as const,
    },
  ];

  it("collects nested files without including siblings", () => {
    expect(selectLibraryDescendantIds({
      folderIds: ["year"],
      nodes,
      kind: "file",
    })).toEqual(["notice", "plan", "photo"]);
  });

  it("matches any literal query and normalized file extension", () => {
    expect(selectLibraryDescendantIds({
      folderIds: ["root"],
      nodes,
      queries: ["通知", "不存在"],
      extensions: [".pdf"],
      kind: "file",
    })).toEqual(["notice"]);
  });

  it("filters temporary files and their noise folders by default", () => {
    expect(selectLibraryDescendantIds({
      folderIds: ["year"],
      nodes,
      queries: ["策划"],
      kind: "file",
    })).toEqual(["plan"]);
    expect(selectLibraryDescendantIds({
      folderIds: ["year"],
      nodes,
      queries: ["策划"],
      kind: "file",
      includeNoise: true,
    })).toEqual(["noise-child", "office-lock", "plan"]);
  });

  it("filters recursive results by path text and processing profile", () => {
    expect(selectLibraryDescendantIds({
      folderIds: ["root"],
      nodes,
      query: "继往开来",
      kind: "file",
      profile: "coarse",
    })).toEqual(["plan"]);
  });

  it("rejects a cycle instead of traversing forever", () => {
    expect(() => selectLibraryDescendantIds({
      folderIds: ["a"],
      nodes: [
        {
          id: "a",
          parentId: "b",
          kind: "folder",
          name: "A",
          originalRelativePath: null,
          processingProfile: "catalog",
        },
        {
          id: "b",
          parentId: "a",
          kind: "folder",
          name: "B",
          originalRelativePath: null,
          processingProfile: "catalog",
        },
      ],
    })).toThrow("目录树存在循环");
  });

  it("combines overlapping folder selections without duplicate nodes", () => {
    expect(selectLibraryDescendantIds({
      folderIds: ["year", "activity"],
      nodes,
      kind: "file",
    })).toEqual(["notice", "plan", "photo"]);
  });
});
