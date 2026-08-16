import { NextRequest, NextResponse } from "next/server";

import {
  createLibraryCompilationJob,
  getLibraryCompilationOverview,
  prepareLibraryCompilationRecovery,
} from "@/library/compilation-service";
import { createLibraryCompilationJobInputSchema } from "@/library/compilation-types";
import { startLibraryCompilationInBackground } from "@/library/compilation-runner";
import { libraryErrorResponse } from "@/library/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const jobId = request.nextUrl.searchParams.get("jobId")?.trim() || undefined;
    const includeCandidates = request.nextUrl.searchParams.get("includeCandidates") !== "false";
    let overview = await getLibraryCompilationOverview(jobId, includeCandidates);
    if (overview.job?.recoverable) {
      await prepareLibraryCompilationRecovery(overview.job.id).catch(() => undefined);
      startLibraryCompilationInBackground(overview.job.id);
      overview = await getLibraryCompilationOverview(jobId, includeCandidates);
    } else if (overview.job?.status === "queued") {
      startLibraryCompilationInBackground(overview.job.id);
    }
    return NextResponse.json(overview);
  } catch (error) {
    return libraryErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const input = createLibraryCompilationJobInputSchema.parse(await request.json());
    const jobId = await createLibraryCompilationJob(input.selections);
    startLibraryCompilationInBackground(jobId);
    return NextResponse.json(
      await getLibraryCompilationOverview(jobId, false),
      { status: 201 },
    );
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
