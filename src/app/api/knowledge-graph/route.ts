import { currentAuthUser, unauthorizedResponse } from "@/auth/session";
import {
  loadKnowledgeGraph,
  type KnowledgeGraphMode,
} from "@/memory/knowledge-graph";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (!await currentAuthUser()) return unauthorizedResponse();
    const requestedMode = new URL(request.url).searchParams.get("mode");
    const mode: KnowledgeGraphMode = requestedMode === "all" || requestedMode === "isolated"
      ? requestedMode
      : "core";
    return Response.json(await loadKnowledgeGraph(mode));
  } catch (error) {
    console.error("[knowledge-graph]", error);
    return Response.json(
      { error: "无法读取组织知识图谱。" },
      { status: 500 },
    );
  }
}
