import { currentAuthUser } from "@/auth/session";
import { getDatabase } from "@/db";
import { presentViewChangeReaction } from "@/view-runtime/application/view-change-reaction";

export async function POST(
  _request: Request,
  context: { params: Promise<{ viewKey: string; reactionId: string }> },
) {
  const user = await currentAuthUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const { viewKey, reactionId } = await context.params;
  const database = getDatabase();
  const updated = await database.viewChangeReaction.updateMany({
    where: { id: reactionId, viewKey, actorId: user.actor.id },
    data: { seenAt: new Date() },
  });
  if (updated.count !== 1) {
    return Response.json({ error: "View Reaction 不存在" }, { status: 404 });
  }
  const reaction = await database.viewChangeReaction.findUniqueOrThrow({
    where: { id: reactionId },
  });
  return Response.json({ reaction: presentViewChangeReaction(reaction) });
}
