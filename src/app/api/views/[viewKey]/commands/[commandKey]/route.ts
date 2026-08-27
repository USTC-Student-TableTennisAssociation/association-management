import { currentAuthUser } from "@/auth/session";
import {
  viewChangeCoordinator,
  viewCommandBus,
} from "@/shell/composition-root";

export async function POST(
  request: Request,
  context: { params: Promise<{ viewKey: string; commandKey: string }> },
) {
  const user = await currentAuthUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  try {
    const { viewKey, commandKey } = await context.params;
    const body = await request.json() as {
      input?: unknown;
      commandVersion?: string;
      expectedStateVersion?: string;
    };
    const result = await viewCommandBus.dispatch({
      viewKey,
      commandKey,
      commandVersion: body.commandVersion,
      expectedStateVersion: body.expectedStateVersion,
      input: body.input,
      actor: {
        actorId: user.actor.id,
        permissions: ["view.read", "view.write", ...(user.role === "ADMIN" ? ["view.approve"] : [])],
      },
      initiator: "human",
    });
    if (result.kind === "executed" && result.reaction) {
      try {
        await viewChangeCoordinator.enqueue({
          reactionId: result.reaction.id,
          actorId: user.actor.id,
        });
      } catch (error) {
        console.error("[view.reaction.enqueue]", error);
      }
    }
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
