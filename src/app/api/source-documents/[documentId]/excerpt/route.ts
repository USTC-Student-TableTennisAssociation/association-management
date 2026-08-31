import { z } from "zod";

import { currentAuthUser, unauthorizedResponse } from "@/auth/session";

import {
  readSourceDocumentRange,
  SourceDocumentReadError,
} from "@/memory/source-document";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  startBlockId: z.string().trim().min(1).max(500),
  endBlockId: z.string().trim().min(1).max(500),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    if (!await currentAuthUser()) return unauthorizedResponse();
    const { documentId } = await context.params;
    const url = new URL(request.url);
    const query = querySchema.parse({
      startBlockId: url.searchParams.get("startBlockId"),
      endBlockId: url.searchParams.get("endBlockId"),
    });
    return Response.json(await readSourceDocumentRange({
      sourceDocumentId: documentId,
      ...query,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "原文引用参数错误。" }, { status: 400 });
    }
    if (error instanceof SourceDocumentReadError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[source-document.excerpt]", error);
    return Response.json({ error: "无法读取原文。" }, { status: 500 });
  }
}
