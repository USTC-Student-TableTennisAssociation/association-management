import { beforeEach, describe, expect, it, vi } from "vitest";

const persistenceState = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/chat/persistence", () => ({
  loadChatMessages: persistenceState.load,
}));

import { GET } from "@/app/api/chat/history/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/chat/history", () => {
  it("returns the current actor's server-side chat history without caching", async () => {
    persistenceState.load.mockResolvedValue([{
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "采购怎么报销？" }],
    }]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(persistenceState.load).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "开发用户" }),
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

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "无法从服务器恢复对话。" });
  });
});
