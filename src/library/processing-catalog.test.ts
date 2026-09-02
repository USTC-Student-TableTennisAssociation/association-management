import { describe, expect, it } from "vitest";

import {
  libraryProcessingCatalog,
  libraryProcessingCatalogInstruction,
} from "@/library/processing-catalog";

describe("Library Processing Catalog", () => {
  it("keeps profile, execution, and publication as independent dimensions", () => {
    const instruction = libraryProcessingCatalogInstruction();

    expect(instruction).toContain("profile");
    expect(instruction).toContain("status");
    expect(instruction).toContain("publication");
    expect(instruction).toContain("不是从 catalog 依次升级到 deep");
    expect(instruction).toContain("Worker 不直接写入 Business View");
  });

  it("describes all three supported outputs without making deep mandatory", () => {
    expect(libraryProcessingCatalog.profiles.catalog.groundedAssertions).toBe(false);
    expect(libraryProcessingCatalog.profiles.coarse.groundedAssertions).toBe(true);
    expect(libraryProcessingCatalog.profiles.deep.sourceDocument).toBe(true);
  });
});
