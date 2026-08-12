import type { MemoryExploreResult } from "@/memory/explore";
import type {
  MemoryAssertionSeed,
  MemoryObjectSeed,
  MemoryRetrievalResult,
  MemorySourceReference,
  MemoryTemporalAnnotation,
} from "@/memory/types";

function assertionKey(input: {
  sourceNodeId: string;
  sourceClaimId: string;
}): string {
  return `${input.sourceNodeId}\u0000${input.sourceClaimId}`;
}

function numberedRef(ref: string, prefix: "A" | "O"): number {
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(ref);
  return match ? Number(match[1]) : 0;
}

function sourceKey(source: MemorySourceReference): string {
  return `${source.sourceNodeId}\u0000${source.sourceBlockId}\u0000${source.ordinal}`;
}

function temporalKey(annotation: MemoryTemporalAnnotation): string {
  return JSON.stringify(annotation);
}

function withoutExcerpt(source: MemorySourceReference): MemorySourceReference {
  return {
    sourceTitle: source.sourceTitle,
    sourceSha256: source.sourceSha256,
    sourceNodeId: source.sourceNodeId,
    sourceRegionLabel: source.sourceRegionLabel,
    sourceBlockId: source.sourceBlockId,
    ordinal: source.ordinal,
    pages: [...source.pages],
  };
}

function mergeUnique<T>(left: T[], right: T[], key: (item: T) => string): T[] {
  const result = [...left];
  const seen = new Set(left.map(key));
  for (const item of right) {
    const itemKey = key(item);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    result.push(item);
  }
  return result;
}

export class MemoryExploreSnapshotError extends Error {
  constructor(expected: string, actual: string) {
    super(`Explore 结果来自不同 Compilation：${expected} != ${actual}`);
    this.name = "MemoryExploreSnapshotError";
  }
}

/**
 * Request-local ref registry. It only unifies evidence discovered during one
 * answer so every tool result and the final citation pass share one A#/O#
 * namespace. It is not an exploration/branch controller.
 */
export class MemoryEvidenceAccumulator {
  private readonly objects: MemoryObjectSeed[];
  private readonly assertions: MemoryAssertionSeed[];
  private readonly connections: Array<{ assertionRef: string; objectRef: string }>;
  private readonly objectRefById: Map<string, string>;
  private readonly assertionRefByKey: Map<string, string>;
  private readonly connectionKeys: Set<string>;
  private nextObjectNumber: number;
  private nextAssertionNumber: number;
  private compilationId?: string;

  constructor(private readonly initial: MemoryRetrievalResult) {
    this.objects = initial.seedMap.objects.map((item) => ({
      ...item,
      surfaceForms: [...item.surfaceForms],
      matchedBy: item.matchedBy.map((match) => ({ ...match })),
      matchedFacets: [...item.matchedFacets],
      supportingAssertions: [...item.supportingAssertions],
    }));
    this.assertions = initial.seedMap.assertions.map((item) => ({
      ...item,
      matchedBy: item.matchedBy.map((match) => ({ ...match })),
      matchedFacets: [...item.matchedFacets],
      temporalAnnotations: item.temporalAnnotations.map((entry) => ({ ...entry })),
      sources: item.sources.map(withoutExcerpt),
    }));
    this.connections = initial.seedMap.connections.map((item) => ({ ...item }));
    this.objectRefById = new Map(this.objects.map((item) => [item.id, item.ref]));
    this.assertionRefByKey = new Map(
      this.assertions.map((item) => [assertionKey(item), item.ref]),
    );
    this.connectionKeys = new Set(
      this.connections.map((item) => `${item.assertionRef}\u0000${item.objectRef}`),
    );
    this.nextObjectNumber =
      Math.max(0, ...this.objects.map((item) => numberedRef(item.ref, "O"))) + 1;
    this.nextAssertionNumber =
      Math.max(0, ...this.assertions.map((item) => numberedRef(item.ref, "A"))) + 1;
    this.compilationId = initial.compilationId ?? initial.trace?.snapshot.id;
    this.refreshObjectSupport();
  }

  hasObject(globalObjectId: string): boolean {
    return this.objectRefById.has(globalObjectId);
  }

  merge(result: MemoryExploreResult): MemoryExploreResult {
    if (result.compilationId) {
      if (this.compilationId && this.compilationId !== result.compilationId) {
        throw new MemoryExploreSnapshotError(this.compilationId, result.compilationId);
      }
      this.compilationId ??= result.compilationId;
    }

    const localObjectRefs = new Map<string, string>();
    const mappedObjects = result.objects.map((item) => {
      let ref = this.objectRefById.get(item.id);
      const existing = ref
        ? this.objects.find((candidate) => candidate.ref === ref)
        : undefined;
      if (!ref) {
        ref = `O${this.nextObjectNumber++}`;
        this.objectRefById.set(item.id, ref);
        this.objects.push({
          ref,
          id: item.id,
          globalObjectKey: item.globalObjectKey,
          canonicalName: item.canonicalName,
          surfaceForms: [...item.surfaceForms],
          matchedBy: [],
          matchedFacets: [],
          supportingAssertions: [],
          lexicalMatch: item.lexicalMatch,
          semanticMatch: item.semanticMatch,
        });
      } else if (existing) {
        existing.surfaceForms = mergeUnique(
          existing.surfaceForms,
          item.surfaceForms,
          (value) => value,
        );
        existing.lexicalMatch = existing.lexicalMatch || item.lexicalMatch;
        existing.semanticMatch = existing.semanticMatch || item.semanticMatch;
      }
      localObjectRefs.set(item.ref, ref);
      return { ...item, ref };
    });

    const localAssertionRefs = new Map<string, string>();
    const mappedAssertions = result.assertions.map((item) => {
      const key = assertionKey(item);
      let ref = this.assertionRefByKey.get(key);
      const existing = ref
        ? this.assertions.find((candidate) => candidate.ref === ref)
        : undefined;
      if (!ref) {
        ref = `A${this.nextAssertionNumber++}`;
        this.assertionRefByKey.set(key, ref);
        this.assertions.push({
          ref,
          ...(item.id ? { id: item.id } : {}),
          sourceNodeId: item.sourceNodeId,
          sourceClaimId: item.sourceClaimId,
          renderedStatement: item.renderedStatement,
          contextDependent: item.contextDependent,
          matchedBy: [],
          matchedFacets: [],
          temporalAnnotations: item.temporalAnnotations.map((entry) => ({ ...entry })),
          sources: item.sources.map(withoutExcerpt),
        });
      } else if (existing) {
        existing.id ??= item.id;
        existing.temporalAnnotations = mergeUnique(
          existing.temporalAnnotations,
          item.temporalAnnotations,
          temporalKey,
        );
        existing.sources = mergeUnique(
          existing.sources,
          item.sources.map(withoutExcerpt),
          sourceKey,
        );
      }
      localAssertionRefs.set(item.ref, ref);
      return {
        ...item,
        ref,
        sources: item.sources.map(withoutExcerpt),
      };
    });

    const mappedConnections = result.connections.flatMap((item) => {
      const assertionRef = localAssertionRefs.get(item.assertionRef);
      const objectRef = localObjectRefs.get(item.objectRef);
      if (!assertionRef || !objectRef) return [];
      const key = `${assertionRef}\u0000${objectRef}`;
      if (!this.connectionKeys.has(key)) {
        this.connectionKeys.add(key);
        this.connections.push({ assertionRef, objectRef });
      }
      return [{ assertionRef, objectRef }];
    });

    this.refreshObjectSupport();

    return {
      ...result,
      objects: mappedObjects,
      assertions: mappedAssertions,
      connections: mappedConnections,
      counts: {
        objects: mappedObjects.length,
        assertions: mappedAssertions.length,
        connections: mappedConnections.length,
      },
    };
  }

  snapshot(): MemoryRetrievalResult {
    return {
      ...this.initial,
      ...(this.compilationId ? { compilationId: this.compilationId } : {}),
      seedMap: {
        facets: this.initial.seedMap.facets.map((item) => ({ ...item })),
        objects: this.objects.map((item) => ({
          ...item,
          surfaceForms: [...item.surfaceForms],
          matchedBy: item.matchedBy.map((match) => ({ ...match })),
          matchedFacets: [...item.matchedFacets],
          supportingAssertions: [...item.supportingAssertions],
        })),
        assertions: this.assertions.map((item) => ({
          ...item,
          matchedBy: item.matchedBy.map((match) => ({ ...match })),
          matchedFacets: [...item.matchedFacets],
          temporalAnnotations: item.temporalAnnotations.map((entry) => ({ ...entry })),
          sources: item.sources.map(withoutExcerpt),
        })),
        connections: this.connections.map((item) => ({ ...item })),
      },
    };
  }

  private refreshObjectSupport(): void {
    const supportByObject = new Map<string, Set<string>>();
    for (const connection of this.connections) {
      const refs = supportByObject.get(connection.objectRef) ?? new Set<string>();
      refs.add(connection.assertionRef);
      supportByObject.set(connection.objectRef, refs);
    }
    for (const object of this.objects) {
      object.supportingAssertions = [...(supportByObject.get(object.ref) ?? [])]
        .sort((left, right) => numberedRef(left, "A") - numberedRef(right, "A"));
      object.semanticMatch = object.semanticMatch || object.supportingAssertions.length > 0;
    }
  }
}
