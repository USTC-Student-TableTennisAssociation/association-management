import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ current: vi.fn() }));
const databaseState = vi.hoisted(() => ({
  objects: vi.fn(),
}));

vi.mock("@/auth/session", () => ({
  currentAuthUser: authState.current,
  unauthorizedResponse: () => Response.json({ error: "请先登录。" }, { status: 401 }),
}));

vi.mock("@/db", () => ({
  getDatabase: () => ({
    memoryGlobalObject: { findMany: databaseState.objects },
  }),
}));

import { GET } from "@/app/api/objects/route";

beforeEach(() => {
  vi.clearAllMocks();
  authState.current.mockResolvedValue({ actor: { id: "actor-1" } });
  databaseState.objects.mockResolvedValue([
    { id: "00000000-0000-4000-8000-000000000001", canonicalName: "周五训练" },
  ]);
});

describe("GET /api/objects", () => {
  it("在唯一 Shared Brain 中搜索稳定 Object", async () => {
    const response = await GET(new Request("http://localhost/api/objects?query=训练&limit=10"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(databaseState.objects).toHaveBeenCalledWith({
      where: {
        canonicalName: { contains: "训练", mode: "insensitive" },
      },
      orderBy: { canonicalName: "asc" },
      take: 10,
      select: { id: true, canonicalName: true },
    });
    expect(await response.json()).toEqual({
      objects: [{
        id: "00000000-0000-4000-8000-000000000001",
        canonicalName: "周五训练",
      }],
    });
  });

  it("拒绝未登录请求", async () => {
    authState.current.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/objects"));
    expect(response.status).toBe(401);
    expect(databaseState.objects).not.toHaveBeenCalled();
  });
});
