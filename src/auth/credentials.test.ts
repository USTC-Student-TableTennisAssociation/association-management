import { describe, expect, it } from "vitest";

import {
  hashPassword,
  normalizeLoginName,
  validatePassword,
  verifyPassword,
} from "@/auth/credentials";

describe("auth credentials", () => {
  it("normalizes compatibility characters, whitespace, and case", () => {
    expect(normalizeLoginName("  Ａlice ")).toBe("alice");
    expect(normalizeLoginName("  雷岳鑫  ")).toBe("雷岳鑫");
  });

  it("stores a salted scrypt hash and verifies only the original password", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first).not.toBe(second);
    expect(first).not.toContain("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", first)).resolves.toBe(false);
    await expect(verifyPassword("correct horse battery staple", "malformed")).resolves.toBe(false);
  });

  it("rejects short passwords", () => {
    expect(() => validatePassword("short")).toThrow("密码长度");
  });
});
