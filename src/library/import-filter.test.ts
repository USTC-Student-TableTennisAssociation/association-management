import { describe, expect, it } from "vitest";

import {
  isLibraryImportNoiseName,
  isLibraryImportNoisePath,
} from "@/library/import-filter";

describe("library import noise policy", () => {
  it.each([
    ".DS_Store",
    "._策划案.docx",
    "~$策划案.docx",
    ".~lock.策划案.docx#",
    "~WRD1234.tmp",
    "Thumbs.db",
    "Icon\r",
  ])("ignores system or temporary file %s", (name) => {
    expect(isLibraryImportNoiseName(name)).toBe(true);
  });

  it("ignores every file below a metadata directory", () => {
    expect(isLibraryImportNoisePath("资料/__MACOSX/._策划案.docx")).toBe(true);
  });

  it.each([
    "策划案.docx",
    "活动资料/正式版.docx",
    ".well-known/说明.md",
    "预算~.xlsx",
  ])("keeps legitimate path %s", (relativePath) => {
    expect(isLibraryImportNoisePath(relativePath)).toBe(false);
  });
});
