import { currentAuthUser } from "@/auth/session";
import { getDatabase } from "@/db";
import { viewChangeCoordinator } from "@/shell/composition-root";
import { presentViewChangeReaction } from "@/view-runtime/application/view-change-reaction";

export async function GET(
  request: Request,
  context: { params: Promise<{ viewKey: string }> },
) {
  const user = await currentAuthUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const { viewKey } = await context.params;
  const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? 20);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(100, Math.max(1, requestedLimit))
    : 20;
  try {
    await viewChangeCoordinator.resumePending({ viewKey });
    const rows = await getDatabase().viewChangeReaction.findMany({
      where: { actorId: user.actor.id, viewKey },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return Response.json({ reactions: rows.map(presentViewChangeReaction) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
