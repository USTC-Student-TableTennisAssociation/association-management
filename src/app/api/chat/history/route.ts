import { currentAuthUser, unauthorizedResponse } from "@/auth/session";
import {
  ChatConversationAccessError,
  loadChatMessages,
} from "@/chat/persistence";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await currentAuthUser();
    if (!user) return unauthorizedResponse();
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    if (!conversationId) {
      return Response.json({ error: "缺少对话 ID。" }, { status: 400 });
    }
    const messages = await loadChatMessages(user.actor, conversationId);
    return Response.json(
      { messages },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ChatConversationAccessError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[chat.history.read]", error);
    return Response.json(
      { error: "无法从服务器恢复对话。" },
      { status: 500 },
    );
  }
}
