import { getDatabase } from "@/db";
import { extractLibraryPreview } from "@/library/preview-extractor";
import type { LibraryFilePreviewView } from "@/library/types";

function parserKeyForPreview(mimeType: string): string {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/")) return "text";
  if (mimeType.startsWith("image/")) return "vision";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (mimeType.includes("zip")) return "archive-manifest";
  return "metadata-only";
}

/**
 * Explicit, bounded chat preview. This may invoke the configured high-accuracy
 * document parser, but never changes a profile or creates memory assertions.
 */
export async function previewLibraryFiles(input: {
  nodeIds: string[];
  maxChars?: number;
  parseIfMissing?: boolean;
}): Promise<LibraryFilePreviewView[]> {
  const uniqueIds = [...new Set(input.nodeIds)].slice(0, 3);
  const maxChars = Math.min(Math.max(input.maxChars ?? 2_000, 200), 8_000);
  const nodes = await getDatabase().libraryNode.findMany({
    where: { id: { in: uniqueIds }, kind: "file", blobId: { not: null } },
    select: {
      id: true,
      name: true,
      originalRelativePath: true,
      blob: {
        select: {
          sha256: true,
          storageKey: true,
          mimeType: true,
        },
      },
    },
  });
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const previews: LibraryFilePreviewView[] = [];
  for (const id of uniqueIds) {
    const node = nodesById.get(id);
    if (!node?.blob) continue;
    const base = {
      id: node.id,
      name: node.name,
      ...(node.originalRelativePath ? { originalRelativePath: node.originalRelativePath } : {}),
      mimeType: node.blob.mimeType,
    };
    if (node.blob.mimeType.startsWith("image/")) {
      previews.push({
        ...base,
        available: false,
        warning: "图片预览需要视觉模型；请在基础编译中使用图片的多模态处理线路。",
      });
      continue;
    }
    const preview = await extractLibraryPreview({
      storageKey: node.blob.storageKey,
      sha256: node.blob.sha256,
      mimeType: node.blob.mimeType,
      parserKey: parserKeyForPreview(node.blob.mimeType),
      parseDocumentsIfMissing: input.parseIfMissing === true,
    });
    const text = preview.text?.trim();
    previews.push({
      ...base,
      available: Boolean(text),
      parser: preview.parser,
      ...(text ? { excerpt: text.slice(0, maxChars), truncated: text.length > maxChars } : {}),
      ...(preview.warning ? { warning: preview.warning } : {}),
    });
  }
  return previews;
}
