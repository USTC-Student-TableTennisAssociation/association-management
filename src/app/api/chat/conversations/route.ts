import { z } from "zod";

import { currentAuthUser, unauthorizedResponse } from "@/auth/session";
import {
  createChatConversation,
  listChatConversations,
} from "@/chat/persistence";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
});

export async function GET() {
  try {
    const user = await currentAuthUser();
    if (!user) return unauthorizedResponse();
    return Response.json({
      conversations: await listChatConversations(user.actor),
    });
  } catch (error) {
    console.error("[chat.conversations.list]", error);
    return Response.json({ error: "无法读取对话列表。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await currentAuthUser();
    if (!user) return unauthorizedResponse();
    const input = createSchema.parse(await request.json().catch(() => ({})));
    return Response.json({
      conversation: await createChatConversation(user.actor, input.title),
    }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "对话标题格式错误。" }, { status: 400 });
    }
    console.error("[chat.conversations.create]", error);
    return Response.json({ error: "无法创建对话。" }, { status: 500 });
  }
}
