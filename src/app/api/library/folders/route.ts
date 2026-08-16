import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { libraryErrorResponse } from "@/library/http";
import { createLibraryFolder } from "@/library/service";

const payloadSchema = z.object({ parentId: z.string().uuid(), name: z.string() });

export async function POST(request: NextRequest) {
  try {
    const payload = payloadSchema.parse(await request.json());
    return NextResponse.json(await createLibraryFolder(payload), { status: 201 });
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
