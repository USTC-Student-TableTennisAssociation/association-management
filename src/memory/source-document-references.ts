import { citedRefs } from "@/ai/citation-refs";
import type {
  SourceDocumentReadResult,
  SourceDocumentReference,
  SourceDocumentReferenceBundle,
} from "@/memory/source-document-types";

function referenceKey(result: SourceDocumentReadResult): string {
  const first = result.blocks.at(0)?.sourceBlockId ?? "";
  const last = result.blocks.at(-1)?.sourceBlockId ?? "";
  return `${result.document.id}\u0000${result.selection.mode}\u0000${first}\u0000${last}`;
}

/** Request-local S# namespace. It only exposes ranges the model actually read. */
export function createSourceDocumentReferenceRegistry() {
  const references: SourceDocumentReference[] = [];
  const refByRange = new Map<string, string>();

  function attachReference(
    result: SourceDocumentReadResult,
  ): SourceDocumentReadResult {
    if (!result.blocks.length) return result;

    const key = referenceKey(result);
    let ref = refByRange.get(key);
    if (!ref) {
      ref = `S${references.length + 1}`;
      refByRange.set(key, ref);
      const firstBlock = result.blocks[0];
      const lastBlock = result.blocks.at(-1)!;
      references.push({
        ref,
        label: `${result.document.title} · ${result.selection.label}`,
        document: result.document,
        selection: result.selection,
        startBlockId: firstBlock.sourceBlockId,
        endBlockId: lastBlock.sourceBlockId,
        blockCount: result.blocks.length,
        pages: [...new Set(result.blocks.flatMap((block) => block.pages))],
      });
    }
    return { ...result, ref };
  }

  function citedReferences(text: string): SourceDocumentReferenceBundle {
    const available = new Map(references.map((reference) => [reference.ref, reference]));
    const used = citedRefs(text, "S").filter((ref) => available.has(ref));
    return { references: used.map((ref) => available.get(ref)!) };
  }

  return {
    attachReference,
    citedReferences,
    availableRefs: () => references.map((reference) => reference.ref),
  };
}
