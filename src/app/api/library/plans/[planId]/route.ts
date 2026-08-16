import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { libraryErrorResponse } from "@/library/http";
import { decideLibraryPlan } from "@/library/service";

const payloadSchema = z.object({ decision: z.enum(["approve", "reject"]) });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ planId: string }> },
) {
  try {
    const [{ planId }, raw] = await Promise.all([context.params, request.json()]);
    const { decision } = payloadSchema.parse(raw);
    return NextResponse.json(await decideLibraryPlan({ planId, decision }));
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
