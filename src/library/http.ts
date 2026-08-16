import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { LibraryValidationError } from "@/library/service";

export function libraryErrorResponse(error: unknown): NextResponse {
  const isUserError = error instanceof LibraryValidationError || error instanceof ZodError;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: isUserError ? 400 : 500 },
  );
}
