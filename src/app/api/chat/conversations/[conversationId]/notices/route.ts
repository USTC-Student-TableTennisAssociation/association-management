import { z } from "zod";

import { currentAuthUser, unauthorizedResponse } from "@/auth/session";
import {
  appendAssistantTextMessage,
  ChatConversationAccessError,
} from "@/chat/persistence";
import { getDatabase } from "@/db";

const requestSchema = z.object({
  kind: z.literal("view_reaction"),
  viewKey: z.string().trim().min(1),
  reactionId: z.string().uuid(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const user = await currentAuthUser();
    if (!user) return unauthorizedResponse();
    const { conversationId } = await context.params;
    const input = requestSchema.parse(await request.json());
    const reaction = await getDatabase().viewChangeReaction.findFirst({
      where: {
        id: input.reactionId,
        viewKey: input.viewKey,
        actorId: user.actor.id,
        attentionStatus: { in: ["inform", "needs_confirmation"] },
      },
      select: { id: true, message: true },
    });
    if (!reaction?.message?.trim()) {
      return Response.json(
        { error: "这条核对结果已不存在，或没有可发送的对话内容。" },
        { status: 409 },
      );
    }
    const message = await appendAssistantTextMessage({
      actor: user.actor,
      conversationId,
      text: reaction.message,
      messageId: `view-reaction-${reaction.id}`,
    });
    await getDatabase().viewChangeReaction.updateMany({
      where: { id: reaction.id, actorId: user.actor.id, seenAt: null },
      data: { seenAt: new Date() },
    });
    return Response.json({ message });
  } catch (error) {
    if (error instanceof ChatConversationAccessError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof z.ZodError) {
      return Response.json({ error: "对话通知参数无效。" }, { status: 400 });
    }
    console.error("[chat.conversation.notice]", error);
    return Response.json({ error: "无法把核对问题放入对话。" }, { status: 500 });
  }
}
