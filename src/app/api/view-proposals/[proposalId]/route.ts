import { z } from "zod";

import { currentAuthUser } from "@/auth/session";
import { viewCommandBus } from "@/shell/composition-root";

const decisionSchema = z.object({ decision: z.enum(["approve", "reject"]) });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ proposalId: string }> },
) {
  const user = await currentAuthUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  try {
    const { proposalId } = await context.params;
    const { decision } = decisionSchema.parse(await request.json());
    const result = await viewCommandBus.decideProposal({
      proposalId,
      decision,
      actor: {
        actorId: user.actor.id,
        permissions: [
          "view.read",
          "view.write",
          ...(user.role === "ADMIN" ? ["view.approve"] : []),
        ],
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
