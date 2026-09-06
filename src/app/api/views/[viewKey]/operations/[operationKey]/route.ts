import { currentAuthUser } from "@/auth/session";
import { viewOperationRunner } from "@/shell/composition-root";

export async function POST(
  request: Request,
  context: { params: Promise<{ viewKey: string; operationKey: string }> },
) {
  const user = await currentAuthUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  try {
    const { viewKey, operationKey } = await context.params;
    const body = await request.json() as {
      input?: unknown;
      operationVersion?: string;
    };
    const result = await viewOperationRunner.execute({
      viewKey,
      operationKey,
      operationVersion: body.operationVersion,
      input: body.input,
      actor: {
        actorId: user.actor.id,
        permissions: ["view.read", "view.write", ...(user.role === "ADMIN" ? ["view.approve"] : [])],
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
