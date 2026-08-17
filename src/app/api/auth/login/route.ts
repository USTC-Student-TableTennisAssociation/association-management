import { z } from "zod";

import { normalizeLoginName, verifyPassword } from "@/auth/credentials";
import { createAuthSession } from "@/auth/session";
import { getDatabase } from "@/db";

const loginSchema = z.object({
  loginName: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  try {
    const input = loginSchema.parse(await request.json());
    const database = getDatabase();
    const user = await database.authUser.findUnique({
      where: { normalizedLoginName: normalizeLoginName(input.loginName) },
      select: {
        id: true,
        passwordHash: true,
        status: true,
      },
    });
    if (
      !user ||
      user.status !== "ACTIVE" ||
      !await verifyPassword(input.password, user.passwordHash)
    ) {
      return Response.json({ error: "登录名或密码错误。" }, { status: 401 });
    }
    await database.authUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await createAuthSession(user.id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "登录请求格式错误。" }, { status: 400 });
    }
    console.error("[auth.login]", error);
    return Response.json({ error: "暂时无法登录。" }, { status: 500 });
  }
}
