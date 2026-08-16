import { NextRequest, NextResponse } from "next/server";

import { libraryErrorResponse } from "@/library/http";
import { createLibraryPlan } from "@/library/service";

export async function POST(request: NextRequest) {
  try {
    return NextResponse.json(await createLibraryPlan(await request.json()), { status: 201 });
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
