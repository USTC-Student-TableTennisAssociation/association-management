import { currentAuthUser } from "@/auth/session";
import { competitionSourceReadInputSchema } from "@/plugins/competition-records/tools/contracts";
import { syncCompetitionEditions } from "@/plugins/competition-records/sync-service";
import { toolRuntime, viewCommandBus } from "@/shell/composition-root";

export async function POST(request: Request) {
  const user = await currentAuthUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  try {
    const raw = await request.json().catch(() => ({}));
    const source = competitionSourceReadInputSchema.parse(raw);
    const result = await syncCompetitionEditions({
      source,
      caller: { kind: "view", viewKey: "competition_records" },
      actor: { actorId: user.actor.id, permissions: ["view.write"] },
      toolRuntime,
      commandBus: viewCommandBus,
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
