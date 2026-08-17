import { currentAuthUser, unauthorizedResponse } from "@/auth/session";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await currentAuthUser();
    return user ? Response.json({ user }) : unauthorizedResponse();
  } catch (error) {
    console.error("[auth.me]", error);
    return Response.json({ error: "无法读取登录状态。" }, { status: 500 });
  }
}
