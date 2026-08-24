import { z } from "zod";

import { createAuthSession } from "@/auth/session";
import { AuthUserValidationError, createInitialAdmin } from "@/auth/users";

const setupSchema = z.object({
  loginName: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(200),
  actorObjectId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  try {
    const input = setupSchema.parse(await request.json());
    const user = await createInitialAdmin(input);
    await createAuthSession(user.id);
    return Response.json({ user }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "请填写有效的姓名、登录名和至少 8 位密码。" }, { status: 400 });
    }
    if (error instanceof AuthUserValidationError) {
      return Response.json({ error: error.message, code: error.code }, { status: 409 });
    }
    console.error("[auth.setup]", error);
    return Response.json({ error: "无法初始化管理员账号。" }, { status: 500 });
  }
}
