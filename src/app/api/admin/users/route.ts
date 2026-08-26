import { z } from "zod";

import {
  currentAuthUser,
  forbiddenResponse,
  unauthorizedResponse,
} from "@/auth/session";
import {
  AuthUserValidationError,
  createAuthUser,
  listAuthUsers,
} from "@/auth/users";

const createSchema = z.object({
  loginName: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(200),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
  actorObjectId: z.string().uuid().optional(),
});

async function requireAdmin() {
  const user = await currentAuthUser();
  if (!user) return { response: unauthorizedResponse() } as const;
  if (user.role !== "ADMIN") return { response: forbiddenResponse() } as const;
  return { user } as const;
}

export async function GET() {
  try {
    const auth = await requireAdmin();
    if ("response" in auth) return auth.response;
    return Response.json({ users: await listAuthUsers() });
  } catch (error) {
    console.error("[admin.users.list]", error);
    return Response.json({ error: "无法读取账号列表。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin();
    if ("response" in auth) return auth.response;
    const input = createSchema.parse(await request.json());
    return Response.json({ user: await createAuthUser(input) }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "请填写有效的账号信息和至少 8 位密码。" }, { status: 400 });
    }
    if (error instanceof AuthUserValidationError) {
      return Response.json({ error: error.message, code: error.code }, { status: 409 });
    }
    console.error("[admin.users.create]", error);
    return Response.json({ error: "无法创建账号。" }, { status: 500 });
  }
}
