import { NextRequest, NextResponse } from "next/server";

import { libraryErrorResponse } from "@/library/http";
import { getLibraryListing, searchLibrary } from "@/library/service";

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams.get("q")?.trim();
    const folderId = request.nextUrl.searchParams.get("parentId")?.trim() || undefined;
    if (query) {
      return NextResponse.json({ items: await searchLibrary({ query, limit: 200 }) });
    }
    return NextResponse.json(await getLibraryListing(folderId));
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
