import { currentAuthUser } from "@/auth/session";
import { getDatabase } from "@/db";
import { viewChangeCoordinator } from "@/shell/composition-root";
import { presentViewChangeReaction } from "@/view-runtime/application/view-change-reaction";

export async function POST(
  _request: Request,
  context: { params: Promise<{ viewKey: string; reactionId: string }> },
) {
  const user = await currentAuthUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const { viewKey, reactionId } = await context.params;
  const queued = await viewChangeCoordinator.retryAttention({
    reactionId,
    viewKey,
    actorId: user.actor.id,
  });
  if (!queued) {
    return Response.json(
      { error: "这条核对记录不存在，或当前状态不能重新核对。" },
      { status: 409 },
    );
  }
  const reaction = await getDatabase().viewChangeReaction.findUnique({
    where: { id: reactionId },
  });
  if (!reaction) return Response.json({ error: "核对记录不存在。" }, { status: 404 });
  return Response.json({ reaction: presentViewChangeReaction(reaction) });
}
