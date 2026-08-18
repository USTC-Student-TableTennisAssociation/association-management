import { z } from "zod";

import { currentAuthUser } from "@/auth/session";
import { installedViewService } from "@/shell/composition-root";

const settingsSchema = z.object({
  aiWritePolicy: z.enum(["approval_required", "auto_execute"]),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ viewKey: string }> },
) {
  const user = await currentAuthUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  if (user.role !== "ADMIN") return Response.json({ error: "需要 View 管理权限" }, { status: 403 });
  try {
    const { viewKey } = await context.params;
    const settings = settingsSchema.parse(await request.json());
    await installedViewService.updateSettings({ viewKey, settings });
    return Response.json({ viewKey, settings });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
