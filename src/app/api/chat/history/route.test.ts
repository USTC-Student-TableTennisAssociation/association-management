import { beforeEach, describe, expect, it, vi } from "vitest";

const persistenceState = vi.hoisted(() => ({ load: vi.fn() }));
const authState = vi.hoisted(() => ({ current: vi.fn() }));

vi.mock("@/chat/persistence", () => ({
  loadChatMessages: persistenceState.load,
  ChatConversationAccessError: class ChatConversationAccessError extends Error {},
}));

vi.mock("@/auth/session", () => ({
  currentAuthUser: authState.current,
  unauthorizedResponse: () => Response.json({ error: "请先登录。" }, { status: 401 }),
}));

import { GET } from "@/app/api/chat/history/route";

beforeEach(() => {
  vi.clearAllMocks();
  authState.current.mockResolvedValue({
    actor: { id: "00000000-0000-4000-8000-000000000001", displayName: "开发用户" },
  });
});

describe("GET /api/chat/history", () => {
  it("returns the current actor's server-side chat history without caching", async () => {
    persistenceState.load.mockResolvedValue([{
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "采购怎么报销？" }],
    }]);

    const response = await GET(new Request(
      "http://localhost/api/chat/history?conversationId=00000000-0000-4000-8000-000000000002",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(persistenceState.load).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "开发用户" }),
      "00000000-0000-4000-8000-000000000002",
    );
    expect(await response.json()).toEqual({
      messages: [{
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "采购怎么报销？" }],
      }],
    });
  });

  it("returns a recoverable error when history cannot be loaded", async () => {
    persistenceState.load.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(new Request(
      "http://localhost/api/chat/history?conversationId=00000000-0000-4000-8000-000000000002",
    ));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "无法从服务器恢复对话。" });
  });
});
