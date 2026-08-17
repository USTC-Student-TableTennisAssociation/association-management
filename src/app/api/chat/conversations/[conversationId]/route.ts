import { z } from "zod";

import { currentAuthUser, unauthorizedResponse } from "@/auth/session";
import {
  ChatConversationAccessError,
  updateChatConversation,
} from "@/chat/persistence";

const updateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  archived: z.boolean().optional(),
}).refine((input) => input.title !== undefined || input.archived !== undefined);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const user = await currentAuthUser();
    if (!user) return unauthorizedResponse();
    const { conversationId } = await context.params;
    const input = updateSchema.parse(await request.json());
    return Response.json({
      conversation: await updateChatConversation({
        actor: user.actor,
        conversationId,
        ...input,
      }),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "对话更新格式错误。" }, { status: 400 });
    }
    if (error instanceof ChatConversationAccessError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[chat.conversations.update]", error);
    return Response.json({ error: "无法更新对话。" }, { status: 500 });
  }
}
