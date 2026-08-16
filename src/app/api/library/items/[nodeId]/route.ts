import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { libraryErrorResponse } from "@/library/http";
import { renameLibraryNode } from "@/library/service";

const payloadSchema = z.object({ name: z.string() });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ nodeId: string }> },
) {
  try {
    const [{ nodeId }, payload] = await Promise.all([context.params, request.json()]);
    await renameLibraryNode({ nodeId, name: payloadSchema.parse(payload).name });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
