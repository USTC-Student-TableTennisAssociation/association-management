import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { libraryErrorResponse } from "@/library/http";
import { queueLibraryProcessing } from "@/library/service";

const payloadSchema = z.object({
  nodeIds: z.array(z.string().uuid()).min(1).max(200),
  profile: z.enum(["coarse", "deep"]),
});

export async function POST(request: NextRequest) {
  try {
    const count = await queueLibraryProcessing(payloadSchema.parse(await request.json()));
    return NextResponse.json({ ok: true, count, status: "queued" });
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
