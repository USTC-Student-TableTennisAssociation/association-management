import { citedRefs } from "@/ai/citation-refs";

export type ArtifactSearchReferenceTarget = {
  kind: "search";
  queryTitle: string;
  matchedCount: number;
  truncated: boolean;
};

export type ArtifactItemReferenceTarget = {
  kind: "artifact";
  nodeId: string;
  name: string;
  path: string | null;
  profile: string;
  status: string;
  sharedBrainStatus: "published" | "not_published";
  publishedAssertionCount: number;
  publishedObjectCount: number;
};

export type ArtifactReferenceTarget =
  | ArtifactSearchReferenceTarget
  | ArtifactItemReferenceTarget;

export type ArtifactReference = {
  ref: string;
  label: string;
  target: ArtifactReferenceTarget;
};

export type ArtifactReferenceBundle = {
  references: ArtifactReference[];
};

type ArtifactSearchResult = {
  queryTitle: string;
  matchedCount: number;
  returnedCount: number;
  truncated: boolean;
  items: Array<{
    nodeId: string;
    name: string;
    path: string | null;
    profile: string;
    status: string;
    matchKind?: string;
    compilation: {
      sharedBrainStatus: "published" | "not_published";
      publishedAssertionCount: number;
      publishedObjectCount: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
};

function targetKey(target: ArtifactReferenceTarget): string {
  return target.kind === "search"
    ? `search\u0000${target.queryTitle}\u0000${target.matchedCount}\u0000${target.truncated}`
    : `artifact\u0000${target.nodeId}`;
}

/** Request-local F# registry for Library query results and artifact metadata. */
export function createArtifactReferenceRegistry() {
  const references: ArtifactReference[] = [];
  const refByTarget = new Map<string, string>();
  const refByNodeId = new Map<string, string>();

  function register(label: string, target: ArtifactReferenceTarget): string {
    const key = targetKey(target);
    const existing = refByTarget.get(key);
    if (existing) return existing;
    const ref = `F${references.length + 1}`;
    refByTarget.set(key, ref);
    references.push({ ref, label, target });
    if (target.kind === "artifact") refByNodeId.set(target.nodeId, ref);
    return ref;
  }

  function attachSearchReferences<T extends ArtifactSearchResult>(result: T):
    Omit<T, "items"> & {
      ref: string;
      items: Array<T["items"][number] & { ref: string }>;
    } {
    const ref = register(`资料库查询：${result.queryTitle}`, {
      kind: "search",
      queryTitle: result.queryTitle,
      matchedCount: result.matchedCount,
      truncated: result.truncated,
    });
    return {
      ...result,
      ref,
      items: result.items.map((item) => ({
        ...item,
        ref: register(item.path || item.name, {
          kind: "artifact",
          nodeId: item.nodeId,
          name: item.name,
          path: item.path,
          profile: item.profile,
          status: item.status,
          sharedBrainStatus: item.compilation.sharedBrainStatus,
          publishedAssertionCount: item.compilation.publishedAssertionCount,
          publishedObjectCount: item.compilation.publishedObjectCount,
        }),
      })),
    };
  }

  function citedReferences(text: string): ArtifactReferenceBundle {
    const available = new Map(references.map((reference) => [reference.ref, reference]));
    const used = citedRefs(text, "F").filter((ref) => available.has(ref));
    return { references: used.map((ref) => available.get(ref)!) };
  }

  return {
    attachSearchReferences,
    citedReferences,
    referenceForNode: (nodeId: string) => refByNodeId.get(nodeId),
    availableRefs: () => references.map((reference) => reference.ref),
    allReferences: () => references.map((reference) => ({ ...reference })),
  };
}
