import { currentAuthUser } from "@/auth/session";
import { getDatabase } from "@/db";
import { viewReadPort } from "@/shell/composition-root";

export async function GET(
  _request: Request,
  context: { params: Promise<{ viewKey: string }> },
) {
  const user = await currentAuthUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  try {
    const { viewKey } = await context.params;
    const snapshot = await viewReadPort.inspect({
      viewKey,
      actor: { actorId: user.actor.id, permissions: ["view.read"] },
    });
    const relatedObjectIds = [...new Set(
      snapshot.cards.flatMap((card) => card.relatedObjectIds),
    )];
    const objects = relatedObjectIds.length
      ? await getDatabase().memoryGlobalObject.findMany({
          where: { id: { in: relatedObjectIds } },
          orderBy: { canonicalName: "asc" },
          select: { id: true, canonicalName: true },
        })
      : [];
    return Response.json({ ...snapshot, objects });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
