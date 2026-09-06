import { getDatabase } from "@/db";
import {
  parseCognitiveMemory,
  parseOperationalMemoryIndex,
  renderCognitiveMemory,
  type OperationalMemoryIndex,
} from "@/memory/higher-memory-document";
import type { StructuredSeedMap } from "@/memory/types";

const MAX_ASPECTS_IN_IDENTITY_CONTEXT = 8;

function compactOperationalIndex(value: unknown): OperationalMemoryIndex {
  const parsed = parseOperationalMemoryIndex(value);
  return {
    aspects: parsed.aspects.slice(0, MAX_ASPECTS_IN_IDENTITY_CONTEXT).map((aspect) => ({
      ...aspect,
      assertionIds: [],
      sourceNodeIds: [],
      sourceTitles: aspect.sourceTitles.slice(0, 3),
      recommendedQueries: aspect.recommendedQueries.slice(0, 3),
      unresolvedAspects: aspect.unresolvedAspects.slice(0, 3),
    })),
  };
}

/** Loads shared cognition for the authenticated user's bound Global Object. */
export async function loadIdentityBoundObjectMemory(
  globalObjectId: string,
): Promise<StructuredSeedMap> {
  const object = await getDatabase().memoryGlobalObject.findUnique({
    where: { id: globalObjectId },
    select: {
      id: true,
      globalObjectKey: true,
      canonicalName: true,
      higherMemory: {
        select: {
          id: true,
          cognitiveMemory: true,
          operationalIndex: true,
          maintainedAt: true,
        },
      },
    },
  });
  if (!object) return { facets: [], objects: [], assertions: [], connections: [] };

  return {
    facets: [],
    objects: [{
      ref: "O1",
      id: object.id,
      globalObjectKey: object.globalObjectKey,
      canonicalName: object.canonicalName,
      surfaceForms: [],
      matchedBy: [],
      matchedFacets: [],
      supportingAssertions: [],
      lexicalMatch: false,
      semanticMatch: false,
    }],
    ...(object.higherMemory
      ? {
          higherMemories: [{
            ref: "H1",
            id: object.higherMemory.id,
            globalObjectId: object.id,
            contentMarkdown: renderCognitiveMemory(
              parseCognitiveMemory(object.higherMemory.cognitiveMemory),
            ),
            operationalIndex: compactOperationalIndex(object.higherMemory.operationalIndex),
            maintainedAt: object.higherMemory.maintainedAt.toISOString(),
          }],
        }
      : {}),
    assertions: [],
    connections: [],
  };
}
