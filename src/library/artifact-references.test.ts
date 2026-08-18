import { describe, expect, it } from "vitest";

import { createArtifactReferenceRegistry } from "@/library/artifact-references";

describe("artifact reference registry", () => {
  it("registers stable F refs for a query and its returned files", () => {
    const registry = createArtifactReferenceRegistry();
    const result = registry.attachSearchReferences({
      queryTitle: "操作手册",
      matchedCount: 1,
      returnedCount: 1,
      truncated: false,
      items: [{
        nodeId: "node-1",
        name: "操作手册.docx",
        path: "制度/操作手册.docx",
        profile: "deep",
        status: "ready",
        matchKind: "exact_title",
        compilation: {
          sharedBrainStatus: "published" as const,
          publishedAssertionCount: 3,
          publishedObjectCount: 2,
        },
      }],
    });

    expect(result.ref).toBe("F1");
    expect(result.items[0].ref).toBe("F2");
    expect(registry.referenceForNode("node-1")).toBe("F2");
    expect(registry.availableRefs()).toEqual(["F1", "F2"]);
    expect(registry.citedReferences("查询 [F1]，文件 [F2]，伪造 [F9]。"))
      .toEqual({ references: registry.allReferences() });
  });
});
