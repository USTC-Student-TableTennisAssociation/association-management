import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { hydrateCitedSourceExcerpts } from "@/memory/citation-sources";
import { locateObjectAssertions } from "@/memory/database-locate";

const runRealLocate = process.env.MEMORY_REAL_TEST === "true";

const cases = [
  { kind: "explicit-object", query: "继往开来是什么活动？" },
  { kind: "semantic-rewrite", query: "做活动宣传稿有哪些写作要求？" },
  { kind: "precise-number", query: "2009 年首次举办的赛事是什么？" },
  { kind: "time", query: "继往开来通常在什么时候举办？" },
  { kind: "knowledge-insufficient", query: "2028 年继往开来的负责人是谁？" },
] as const;

describe.skipIf(!runRealLocate)("GlobalObject–Assertion real database Locate", () => {
  it("runs five distinct real queries and records an inspectable trace", async () => {
    const results = [];
    for (const [index, item] of cases.entries()) {
      const result = await locateObjectAssertions({
        query: item.query,
        facets: [{ id: `facet-${index}`, text: item.query, source: "query" }],
      });
      expect(result.mode).toBe("object-assertion");
      expect(result.trace?.snapshot.globalObjectCount).toBeGreaterThan(0);
      expect(result.trace?.snapshot.objectFragmentCount).toBeGreaterThan(0);
      expect(result.trace?.snapshot.assertionCount).toBeGreaterThan(0);
      expect(result.trace?.objectLexical).toHaveLength(1);
      expect(result.trace?.assertionLexical).toHaveLength(1);
      expect(result.trace?.assertionVector).toHaveLength(1);
      expect(result.seedMap.connections.every((connection) =>
        result.seedMap.objects.some((object) => object.ref === connection.objectRef) &&
        result.seedMap.assertions.some((assertion) => assertion.ref === connection.assertionRef)
      )).toBe(true);
      expect(new Set(result.seedMap.objects.map((object) => object.id)).size)
        .toBe(result.seedMap.objects.length);
      expect(result.seedMap.assertions.flatMap((assertion) => assertion.sources)
        .every((source) => source.excerpt === undefined)).toBe(true);
      results.push({ kind: item.kind, ...result });
    }

    expect(results[0].seedMap.objects.some((object) => object.canonicalName.includes("继往开来"))).toBe(true);
    expect(results[2].seedMap.assertions.some((assertion) =>
      assertion.renderedStatement.includes("2009")
    )).toBe(true);

    const cited = await hydrateCitedSourceExcerpts(results[0], ["A1"]);
    expect(cited.seedMap.assertions
      .find((assertion) => assertion.ref === "A1")
      ?.sources.every((source) => Boolean(source.excerpt))).toBe(true);
    expect(cited.seedMap.assertions
      .filter((assertion) => assertion.ref !== "A1")
      .flatMap((assertion) => assertion.sources)
      .every((source) => source.excerpt === undefined)).toBe(true);

    const output = process.env.MEMORY_REAL_TRACE_OUTPUT;
    if (output) await writeFile(output, JSON.stringify(results, null, 2), "utf8");
  }, 120_000);
});
