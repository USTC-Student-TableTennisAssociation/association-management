import { currentAuthUser, unauthorizedResponse } from "@/auth/session";
import {
  ChatConversationAccessError,
  loadChatMessages,
} from "@/chat/persistence";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const user = await currentAuthUser();
    if (!user) return unauthorizedResponse();
    const { conversationId } = await context.params;
    return Response.json(
      { messages: await loadChatMessages(user.actor, conversationId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ChatConversationAccessError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[chat.conversation.messages]", error);
    return Response.json({ error: "无法恢复对话。" }, { status: 500 });
  }
}
