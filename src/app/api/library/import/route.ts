import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { libraryErrorResponse } from "@/library/http";
import {
  finishLibraryBrowserImport,
  importLibraryBrowserFiles,
  LibraryValidationError,
  startLibraryBrowserImport,
} from "@/library/service";

export const runtime = "nodejs";

const startSchema = z.object({
  parentId: z.string().uuid(),
  displayName: z.string(),
  rootFolderName: z.string().optional(),
});

const finishSchema = z.object({
  batchId: z.string().uuid(),
  errorMessage: z.string().optional(),
});

const relativePathsSchema = z.array(z.string()).min(1).max(12);

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLocaleLowerCase().startsWith("multipart/form-data")) {
      return NextResponse.json(
        await startLibraryBrowserImport(startSchema.parse(await request.json())),
        { status: 201 },
      );
    }
    const formData = await request.formData();
    const batchId = z.string().uuid().parse(formData.get("batchId"));
    const parentId = z.string().uuid().parse(formData.get("parentId"));
    const relativePaths = relativePathsSchema.parse(JSON.parse(
      z.string().parse(formData.get("relativePaths")),
    ));
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.length !== relativePaths.length) {
      throw new LibraryValidationError("导入文件与相对路径数量不一致");
    }
    return NextResponse.json({
      files: await importLibraryBrowserFiles({
        batchId,
        parentId,
        files: files.map((file, index) => ({ file, relativePath: relativePaths[index] })),
      }),
    });
  } catch (error) {
    return libraryErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    return NextResponse.json(
      await finishLibraryBrowserImport(finishSchema.parse(await request.json())),
    );
  } catch (error) {
    return libraryErrorResponse(error);
  }
}
