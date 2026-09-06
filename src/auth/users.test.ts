import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthUser } from "@/auth/users";
import { getDatabase } from "@/db";

vi.mock("@/auth/credentials", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed"),
  normalizeLoginName: (value: string) => value.toLocaleLowerCase("zh-CN"),
}));
vi.mock("@/db", () => ({ getDatabase: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("Auth user Actor Object provisioning", () => {
  it("creates a distinct account identity anchor when no Object is explicitly selected", async () => {
    const transaction = {
      $queryRaw: vi.fn(),
      memoryGlobalObject: {
        create: vi.fn().mockImplementation(({ data }) => ({
          id: data.id,
          canonicalName: data.canonicalName,
        })),
      },
      authUser: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => ({
          id: "00000000-0000-4000-8000-000000000090",
          loginName: data.loginName,
          role: data.role,
          status: "ACTIVE",
          actor: { id: data.actorId, displayName: "魏汉东" },
          actorObject: { id: data.actorObjectId, canonicalName: "魏汉东" },
        })),
      },
      memoryActor: { create: vi.fn() },
    };
    const database = {
      $transaction: vi.fn(async (callback) => callback(transaction)),
    };
    vi.mocked(getDatabase).mockReturnValue(database as never);

    await createAuthUser({
      loginName: "weihandong",
      displayName: "魏汉东",
      password: "password123",
      role: "MEMBER",
    });

    expect(transaction.memoryGlobalObject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        globalObjectKey: expect.stringMatching(/^account-actor:/),
        canonicalName: "魏汉东",
      }),
      select: { id: true, canonicalName: true },
    });
    expect(transaction.authUser.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorObjectId: expect.any(String),
      }),
    }));
  });
});
