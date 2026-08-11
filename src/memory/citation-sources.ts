import { getDatabase } from "@/db";
import type {
  MemoryRetrievalResult,
  MemorySourceReference,
  StructuredSeedMap,
} from "@/memory/types";

export type CitedSourceExcerpt = {
  sourceNodeId: string;
  sourceClaimId: string;
  sourceBlockId: string;
  excerpt: string;
};

function sourceKey(
  sourceNodeId: string,
  sourceClaimId: string,
  sourceBlockId: string,
): string {
  return `${sourceNodeId}\u0000${sourceClaimId}\u0000${sourceBlockId}`;
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
  return [...text.matchAll(/\[(A\d+)\]/g)]
    .map((match) => match[1])
    .filter(
      (ref, index, values) =>
        valid.has(ref) && values.indexOf(ref) === index,
    );
}

export function attachCitedSourceExcerpts(
  result: MemoryRetrievalResult,
  citedAssertionRefs: string[],
  excerpts: CitedSourceExcerpt[],
): MemoryRetrievalResult {
  const citedRefs = new Set(citedAssertionRefs);
  const excerptBySource = new Map(
    excerpts.map((item) => [
      sourceKey(item.sourceNodeId, item.sourceClaimId, item.sourceBlockId),
      item.excerpt,
    ]),
  );

  return {
    ...result,
    seedMap: {
      ...result.seedMap,
      assertions: result.seedMap.assertions.map((assertion) => ({
        ...assertion,
        sources: assertion.sources.map((source) => {
          const provenance = withoutExcerpt(source);
          if (!citedRefs.has(assertion.ref)) return provenance;
          const excerpt = excerptBySource.get(
            sourceKey(
              assertion.sourceNodeId,
              assertion.sourceClaimId,
              source.sourceBlockId,
            ),
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
  const citedAssertions = result.seedMap.assertions.filter((assertion) =>
    citedRefs.has(assertion.ref),
  );
  if (!citedAssertions.length) return attachCitedSourceExcerpts(result, [], []);

  const compilationId = result.compilationId ?? result.trace?.snapshot.id;
  if (!compilationId) return attachCitedSourceExcerpts(result, [], []);

  const rows = await getDatabase().memoryAssertion.findMany({
    where: {
      compilationId,
      OR: citedAssertions.map((assertion) => ({
        sourceClaimId: assertion.sourceClaimId,
        sourceRegion: { is: { sourceNodeId: assertion.sourceNodeId } },
      })),
    },
    select: {
      sourceClaimId: true,
      sourceRegion: { select: { sourceNodeId: true } },
      sourceBlockLinks: {
        select: {
          sourceBlock: {
            select: {
              sourceBlockId: true,
              markdown: true,
            },
          },
        },
      },
    },
  });

  const excerpts = rows.flatMap((row) =>
    row.sourceBlockLinks.map(({ sourceBlock }) => ({
      sourceNodeId: row.sourceRegion.sourceNodeId,
      sourceClaimId: row.sourceClaimId,
      sourceBlockId: sourceBlock.sourceBlockId,
      excerpt: sourceBlock.markdown,
    })),
  );
  return attachCitedSourceExcerpts(result, citedAssertionRefs, excerpts);
}
