import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { libraryErrorResponse } from "@/library/http";
import { deleteLibraryNodes } from "@/library/service";

const payloadSchema = z.object({
  nodeIds: z.array(z.string().uuid()).min(1).max(200),
});

export async function DELETE(request: NextRequest) {
  try {
    return NextResponse.json(
      await deleteLibraryNodes(payloadSchema.parse(await request.json())),
    );
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
