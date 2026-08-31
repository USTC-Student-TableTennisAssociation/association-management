import type { MemoryExploreResult } from "@/memory/explore";
import type {
  MemoryAssertionSeed,
  MemoryHigherMemorySeed,
  MemoryObjectSeed,
  MemoryRetrievalResult,
  MemorySourceReference,
} from "@/memory/types";

function assertionKey(input: {
  id?: string;
  sourceNodeId?: string;
  sourceClaimId: string;
}): string {
  return input.id ?? `${input.sourceNodeId ?? "unknown"}\u0000${input.sourceClaimId}`;
}

function numberedRef(ref: string, prefix: "A" | "O" | "H"): number {
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(ref);
  return match ? Number(match[1]) : 0;
}

function normalizedObjectReference(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[\s“”"'《》〈〉【】（）()，,。.!！?？:：;；·—_\-]/g, "");
}

function sourceKey(source: MemorySourceReference): string {
  if (source.kind === "chat") {
    return `chat\u0000${source.evidenceId}\u0000${source.ordinal}`;
  }
  return `${source.sourceNodeId}\u0000${source.sourceBlockId}\u0000${source.ordinal}`;
}

function withoutExcerpt(source: MemorySourceReference): MemorySourceReference {
  if (source.kind === "chat") {
    return {
      kind: "chat",
      evidenceId: source.evidenceId,
      actorId: source.actorId,
      actorDisplayName: source.actorDisplayName,
      submittedAt: source.submittedAt,
      timezone: source.timezone,
      ordinal: source.ordinal,
    };
  }
  return {
    kind: "document",
    sourceDocumentId: source.sourceDocumentId,
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

/**
 * Request-local ref registry. It only unifies evidence discovered during one
 * answer so every tool result and the final citation pass share one A#/O#
 * namespace. It is not an exploration/branch controller.
 */
export class MemoryEvidenceAccumulator {
  private readonly objects: MemoryObjectSeed[];
  private readonly assertions: MemoryAssertionSeed[];
  private readonly higherMemories: MemoryHigherMemorySeed[];
  private readonly connections: Array<{ assertionRef: string; objectRef: string }>;
  private readonly objectRefById: Map<string, string>;
  private readonly assertionRefByKey: Map<string, string>;
  private readonly higherMemoryRefByObjectId: Map<string, string>;
  private readonly connectionKeys: Set<string>;
  private nextObjectNumber: number;
  private nextAssertionNumber: number;
  private nextHigherMemoryNumber: number;

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
      sources: item.sources.map(withoutExcerpt),
    }));
    this.higherMemories = (initial.seedMap.higherMemories ?? []).map((item) => ({
      ...item,
      operationalIndex: {
        aspects: item.operationalIndex.aspects.map((aspect) => ({
          ...aspect,
          assertionIds: [...aspect.assertionIds],
          sourceNodeIds: [...aspect.sourceNodeIds],
          sourceTitles: [...aspect.sourceTitles],
          recommendedQueries: [...aspect.recommendedQueries],
          unresolvedAspects: [...aspect.unresolvedAspects],
        })),
      },
    }));
    this.connections = initial.seedMap.connections.map((item) => ({ ...item }));
    this.objectRefById = new Map(this.objects.map((item) => [item.id, item.ref]));
    this.assertionRefByKey = new Map(
      this.assertions.map((item) => [assertionKey(item), item.ref]),
    );
    this.higherMemoryRefByObjectId = new Map(
      this.higherMemories.map((item) => [item.globalObjectId, item.ref]),
    );
    this.connectionKeys = new Set(
      this.connections.map((item) => `${item.assertionRef}\u0000${item.objectRef}`),
    );
    this.nextObjectNumber =
      Math.max(0, ...this.objects.map((item) => numberedRef(item.ref, "O"))) + 1;
    this.nextAssertionNumber =
      Math.max(0, ...this.assertions.map((item) => numberedRef(item.ref, "A"))) + 1;
    this.nextHigherMemoryNumber =
      Math.max(0, ...this.higherMemories.map((item) => numberedRef(item.ref, "H"))) + 1;
    this.refreshObjectSupport();
  }

  hasObject(globalObjectId: string): boolean {
    return this.objectRefById.has(globalObjectId);
  }

  objectIdForRef(objectRef: string): string | undefined {
    for (const [objectId, ref] of this.objectRefById) {
      if (ref === objectRef) return objectId;
    }
    return undefined;
  }

  /**
   * Resolve a model-facing Object reference inside this request's evidence
   * namespace. O# remains the exact form, while a canonical name or known
   * surface form is accepted only when it identifies one discovered Object.
   */
  objectForModelReference(
    reference: string,
  ): { id: string; canonicalName: string } | undefined {
    const objectId = this.objectIdForRef(reference);
    if (objectId) {
      const object = this.objects.find((item) => item.id === objectId);
      return object ? { id: object.id, canonicalName: object.canonicalName } : undefined;
    }
    const normalized = normalizedObjectReference(reference);
    if (!normalized) return undefined;
    const matches = this.objects.filter((object) =>
      [object.canonicalName, ...object.surfaceForms].some(
        (name) => normalizedObjectReference(name) === normalized,
      )
    );
    return matches.length === 1
      ? { id: matches[0].id, canonicalName: matches[0].canonicalName }
      : undefined;
  }

  objectRefForId(globalObjectId: string): string | undefined {
    return this.objectRefById.get(globalObjectId);
  }

  invalidateHigherMemories(globalObjectIds: Iterable<string>): string[] {
    const invalidIds = new Set(globalObjectIds);
    if (!invalidIds.size) return [];
    const invalidatedRefs = this.higherMemories
      .filter((memory) => invalidIds.has(memory.globalObjectId))
      .map((memory) => memory.ref);
    if (!invalidatedRefs.length) return [];
    for (let index = this.higherMemories.length - 1; index >= 0; index -= 1) {
      const memory = this.higherMemories[index];
      if (!invalidIds.has(memory.globalObjectId)) continue;
      this.higherMemories.splice(index, 1);
      this.higherMemoryRefByObjectId.delete(memory.globalObjectId);
    }
    return invalidatedRefs;
  }

  merge(result: MemoryExploreResult): MemoryExploreResult {
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
          kind: item.kind,
          dereferenceRequired: item.dereferenceRequired,
          ...(item.sourceNodeId ? { sourceNodeId: item.sourceNodeId } : {}),
          sourceClaimId: item.sourceClaimId,
          renderedStatement: item.renderedStatement,
          contextDependent: item.contextDependent,
          matchedBy: [],
          matchedFacets: [],
          sources: item.sources.map(withoutExcerpt),
        });
      } else if (existing) {
        existing.id ??= item.id;
        if (
          existing.kind !== item.kind ||
          existing.dereferenceRequired !== item.dereferenceRequired
        ) {
          throw new Error(`Assertion ${key} 的 kind/dereference 标记不一致`);
        }
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

    const mappedHigherMemories = (result.higherMemories ?? []).map((item) => {
      let ref = this.higherMemoryRefByObjectId.get(item.globalObjectId);
      const existing = ref
        ? this.higherMemories.find((candidate) => candidate.ref === ref)
        : undefined;
      if (!ref) {
        ref = `H${this.nextHigherMemoryNumber++}`;
        this.higherMemoryRefByObjectId.set(item.globalObjectId, ref);
        this.higherMemories.push({ ...item, ref });
      } else if (existing) {
        existing.id = item.id;
        existing.contentMarkdown = item.contentMarkdown;
        existing.operationalIndex = {
          aspects: item.operationalIndex.aspects.map((aspect) => ({
            ...aspect,
            assertionIds: [...aspect.assertionIds],
            sourceNodeIds: [...aspect.sourceNodeIds],
            sourceTitles: [...aspect.sourceTitles],
            recommendedQueries: [...aspect.recommendedQueries],
            unresolvedAspects: [...aspect.unresolvedAspects],
          })),
        };
        existing.maintainedAt = item.maintainedAt;
      }
      return { ...item, ref };
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
      ...(mappedHigherMemories.length ? { higherMemories: mappedHigherMemories } : {}),
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
      seedMap: {
        facets: this.initial.seedMap.facets.map((item) => ({ ...item })),
        ...(this.initial.seedMap.sourceTime
          ? {
              sourceTime: {
                ...this.initial.seedMap.sourceTime,
                supportingBlocks: this.initial.seedMap.sourceTime.supportingBlocks.map(
                  (item) => ({ ...item, pages: [...item.pages] }),
                ),
              },
            }
          : {}),
        objects: this.objects.map((item) => ({
          ...item,
          surfaceForms: [...item.surfaceForms],
          matchedBy: item.matchedBy.map((match) => ({ ...match })),
          matchedFacets: [...item.matchedFacets],
          supportingAssertions: [...item.supportingAssertions],
        })),
        ...(this.higherMemories.length
          ? {
              higherMemories: this.higherMemories.map((item) => ({
                ...item,
                operationalIndex: {
                  aspects: item.operationalIndex.aspects.map((aspect) => ({
                    ...aspect,
                    assertionIds: [...aspect.assertionIds],
                    sourceNodeIds: [...aspect.sourceNodeIds],
                    sourceTitles: [...aspect.sourceTitles],
                    recommendedQueries: [...aspect.recommendedQueries],
                    unresolvedAspects: [...aspect.unresolvedAspects],
                  })),
                },
              })),
            }
          : {}),
        assertions: this.assertions.map((item) => ({
          ...item,
          matchedBy: item.matchedBy.map((match) => ({ ...match })),
          matchedFacets: [...item.matchedFacets],
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
