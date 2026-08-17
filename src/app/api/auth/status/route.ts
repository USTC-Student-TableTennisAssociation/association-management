import { authenticationSetupRequired } from "@/auth/users";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ setupRequired: await authenticationSetupRequired() });
  } catch (error) {
    console.error("[auth.status]", error);
    return Response.json({ error: "无法读取认证状态。" }, { status: 500 });
  }
}
