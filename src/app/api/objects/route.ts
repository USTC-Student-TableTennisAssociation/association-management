import { currentAuthUser, unauthorizedResponse } from "@/auth/session";
import { getDatabase } from "@/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!await currentAuthUser()) return unauthorizedResponse();
  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get("query") ?? "").trim().slice(0, 200);
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(30, Math.max(1, requestedLimit))
      : 20;
    const database = getDatabase();
    const compilation = await database.memoryCompilation.findFirst({
      orderBy: [{ importedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (!compilation) {
      return Response.json({ objects: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    const objects = await database.memoryGlobalObject.findMany({
      where: {
        compilationId: compilation.id,
        ...(query
          ? { canonicalName: { contains: query, mode: "insensitive" as const } }
          : {}),
      },
      orderBy: { canonicalName: "asc" },
      take: limit,
      select: { id: true, canonicalName: true },
    });
    return Response.json({ objects }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[objects]", error);
    return Response.json({ error: "无法搜索稳定 Object。" }, { status: 500 });
  }
}
