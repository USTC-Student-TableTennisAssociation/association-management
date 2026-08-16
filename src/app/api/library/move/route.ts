import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { libraryErrorResponse } from "@/library/http";
import { moveLibraryNodes } from "@/library/service";

const payloadSchema = z.object({
  nodeIds: z.array(z.string().uuid()).min(1).max(100),
  targetFolderId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    await moveLibraryNodes(payloadSchema.parse(await request.json()));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
