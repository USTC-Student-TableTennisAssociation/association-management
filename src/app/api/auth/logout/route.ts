import { revokeCurrentSession } from "@/auth/session";

export async function POST() {
  try {
    await revokeCurrentSession();
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[auth.logout]", error);
    return Response.json({ error: "无法退出登录。" }, { status: 500 });
  }
}
