import { describe, expect, it } from "vitest";

import { buildCurrentTimeInstruction } from "@/ai/current-time-context";

describe("buildCurrentTimeInstruction", () => {
  it("renders one server instant in the environment timezone", () => {
    const instruction = buildCurrentTimeInstruction(
      new Date("2026-08-13T02:03:04.000Z"),
      "Asia/Shanghai",
    );

    expect(instruction).toContain("当前组织时间：2026-08-13 10:03:04（Asia/Shanghai）");
    expect(instruction).toContain("不能证明组织信息当前仍然有效");
    expect(instruction).not.toContain("2026-08-13T02:03:04.000Z");
    expect(instruction).toContain("只用于解释相对时间");
  });

  it("rejects an invalid timezone", () => {
    expect(() => buildCurrentTimeInstruction(
      new Date("2026-08-13T02:03:04.000Z"),
      "not-a-timezone",
    )).toThrow(RangeError);
  });
});
