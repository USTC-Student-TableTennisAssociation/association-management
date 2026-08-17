import { z } from "zod";

import {
  currentAuthUser,
  forbiddenResponse,
  unauthorizedResponse,
} from "@/auth/session";
import { AuthUserValidationError, updateAuthUser } from "@/auth/users";

const updateSchema = z.object({
  password: z.string().min(8).max(200).optional(),
  role: z.enum(["ADMIN", "MEMBER"]).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
}).refine((input) => Object.keys(input).length > 0);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  try {
    const admin = await currentAuthUser();
    if (!admin) return unauthorizedResponse();
    if (admin.role !== "ADMIN") return forbiddenResponse();
    const { userId } = await context.params;
    const input = updateSchema.parse(await request.json());
    return Response.json({
      user: await updateAuthUser({
        ...input,
        userId,
        actingUserId: admin.userId,
      }),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "账号更新格式错误。" }, { status: 400 });
    }
    if (error instanceof AuthUserValidationError) {
      return Response.json({ error: error.message, code: error.code }, { status: 409 });
    }
    console.error("[admin.users.update]", error);
    return Response.json({ error: "无法更新账号。" }, { status: 500 });
  }
}
