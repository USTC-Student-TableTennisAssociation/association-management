import { loadChatMessages } from "@/chat/persistence";
import { currentMemoryActor } from "@/memory/chat-assertion";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const messages = await loadChatMessages(currentMemoryActor());
    return Response.json(
      { messages },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[chat.history.read]", error);
    return Response.json(
      { error: "无法从服务器恢复对话。" },
      { status: 500 },
    );
  }
}
