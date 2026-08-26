import { z } from "zod";

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
      conversationId?: string;
    };
    const conversationId = z.string().uuid().optional().parse(body.conversationId);
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
    let aiAttention: "scheduled" | "next_turn" | "ignored" | undefined;
    if (result.kind === "executed") {
      try {
        aiAttention = await viewChangeCoordinator.enqueue({
          executionId: result.executionId,
          actor: user.actor,
          ...(conversationId ? { conversationId } : {}),
        });
      } catch (error) {
        console.error("[view.ai-attention.enqueue]", error);
        aiAttention = "ignored";
      }
    }
    return Response.json(aiAttention ? { ...result, aiAttention } : result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
