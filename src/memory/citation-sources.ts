import { citedRefs } from "@/ai/citation-refs";
import { getDatabase } from "@/db";
import type {
  MemoryRetrievalResult,
  MemorySourceReference,
  StructuredSeedMap,
} from "@/memory/types";

export type CitedSourceExcerpt = {
  assertionId: string;
  sourceKey: string;
  excerpt: string;
};

function sourceKey(source: MemorySourceReference): string {
  return source.kind === "chat"
    ? `chat\u0000${source.evidenceId}`
    : `document\u0000${source.sourceNodeId}\u0000${source.sourceBlockId}`;
}

function withoutExcerpt(source: MemorySourceReference): MemorySourceReference {
  const provenance = { ...source };
  delete provenance.excerpt;
  return provenance;
}

export function citedAssertionRefs(
  text: string,
  seedMap: StructuredSeedMap,
): string[] {
  const valid = new Set(seedMap.assertions.map((item) => item.ref));
  return citedRefs(text, "A").filter((ref) => valid.has(ref));
}

export function attachCitedSourceExcerpts(
  result: MemoryRetrievalResult,
  citedAssertionRefs: string[],
  excerpts: CitedSourceExcerpt[],
): MemoryRetrievalResult {
  const citedRefs = new Set(citedAssertionRefs);
  const excerptBySource = new Map(
    excerpts.map((item) => [`${item.assertionId}\u0000${item.sourceKey}`, item.excerpt]),
  );
  return {
    ...result,
    seedMap: {
      ...result.seedMap,
      assertions: result.seedMap.assertions.map((assertion) => ({
        ...assertion,
        sources: assertion.sources.map((source) => {
          const provenance = withoutExcerpt(source);
          if (!citedRefs.has(assertion.ref) || !assertion.id) return provenance;
          const excerpt = excerptBySource.get(
            `${assertion.id}\u0000${sourceKey(source)}`,
          );
          return excerpt === undefined ? provenance : { ...provenance, excerpt };
        }),
      })),
    },
  };
}

export async function hydrateCitedSourceExcerpts(
  result: MemoryRetrievalResult,
  citedAssertionRefs: string[],
): Promise<MemoryRetrievalResult> {
  if (result.mode !== "object-assertion" || !citedAssertionRefs.length) {
    return attachCitedSourceExcerpts(result, [], []);
  }
  const citedRefs = new Set(citedAssertionRefs);
  const assertionIds = result.seedMap.assertions
    .filter((assertion) => citedRefs.has(assertion.ref))
    .flatMap((assertion) => assertion.id ? [assertion.id] : []);
  if (!assertionIds.length) return attachCitedSourceExcerpts(result, [], []);

  const rows = await getDatabase().memoryAssertion.findMany({
    where: { id: { in: assertionIds } },
    select: {
      id: true,
      sourceRegion: { select: { sourceNodeId: true } },
      chatEvidenceLinks: {
        select: {
          chatEvidence: { select: { id: true, rawUserMessage: true } },
        },
      },
      sourceBlockLinks: {
        select: {
          sourceBlock: { select: { sourceBlockId: true, markdown: true } },
        },
      },
    },
  });
  const excerpts: CitedSourceExcerpt[] = rows.flatMap((row) => {
    if (row.sourceRegion) {
      return row.sourceBlockLinks.map(({ sourceBlock }) => ({
        assertionId: row.id,
        sourceKey: `document\u0000${row.sourceRegion!.sourceNodeId}\u0000${sourceBlock.sourceBlockId}`,
        excerpt: sourceBlock.markdown,
      }));
    }
    return row.chatEvidenceLinks.map(({ chatEvidence }) => ({
          assertionId: row.id,
          sourceKey: `chat\u0000${chatEvidence.id}`,
          excerpt: chatEvidence.rawUserMessage,
        }));
  });
  return attachCitedSourceExcerpts(result, citedAssertionRefs, excerpts);
}
