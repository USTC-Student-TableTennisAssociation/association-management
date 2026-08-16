import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  getLibraryCompilationOverview,
  prepareLibraryCompilationRecovery,
  prepareLibraryCompilationResume,
  prepareLibraryCompilationRetry,
  requestLibraryCompilationPause,
} from "@/library/compilation-service";
import { startLibraryCompilationInBackground } from "@/library/compilation-runner";
import { libraryErrorResponse } from "@/library/http";

export const runtime = "nodejs";

const actionSchema = z.object({
  action: z.enum(["pause", "resume", "retry_failed", "recover_stale"]),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const [{ jobId }, raw] = await Promise.all([context.params, request.json()]);
    const { action } = actionSchema.parse(raw);
    if (action === "pause") {
      await requestLibraryCompilationPause(jobId);
    } else if (action === "resume") {
      await prepareLibraryCompilationResume(jobId);
      startLibraryCompilationInBackground(jobId);
    } else if (action === "recover_stale") {
      await prepareLibraryCompilationRecovery(jobId);
      startLibraryCompilationInBackground(jobId);
    } else {
      await prepareLibraryCompilationRetry(jobId);
      startLibraryCompilationInBackground(jobId);
    }
    return NextResponse.json(await getLibraryCompilationOverview(jobId, false));
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
