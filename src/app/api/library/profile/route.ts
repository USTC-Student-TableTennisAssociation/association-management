import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { libraryErrorResponse } from "@/library/http";
import { setLibraryProcessingProfile } from "@/library/service";
import { libraryProcessingProfileSchema } from "@/library/types";

const payloadSchema = z.object({
  nodeIds: z.array(z.string().uuid()).min(1).max(200),
  profile: libraryProcessingProfileSchema,
});

export async function POST(request: NextRequest) {
  try {
    const count = await setLibraryProcessingProfile(payloadSchema.parse(await request.json()));
    return NextResponse.json({ ok: true, count });
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
