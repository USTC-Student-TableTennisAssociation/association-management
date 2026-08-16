import { NextRequest } from "next/server";

import { libraryErrorResponse } from "@/library/http";
import { readStoredFile } from "@/library/object-store";
import { getLibraryFile } from "@/library/service";

function contentDisposition(name: string, inline: boolean): string {
  const safeFallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${safeFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ nodeId: string }> },
) {
  try {
    const { nodeId } = await context.params;
    const node = await getLibraryFile(nodeId);
    const body = await readStoredFile(node.blob!.storageKey);
    const inline = request.nextUrl.searchParams.get("disposition") === "inline";
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": node.blob!.mimeType,
        "Content-Length": body.byteLength.toString(),
        "Content-Disposition": contentDisposition(node.name, inline),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
