import { describe, expect, it } from "vitest";

import { buildCurrentTimeInstruction } from "@/ai/current-time-context";

describe("buildCurrentTimeInstruction", () => {
  it("renders one server instant in the organization timezone", () => {
    const instruction = buildCurrentTimeInstruction(
      new Date("2026-08-13T02:03:04.000Z"),
      "Asia/Shanghai",
    );

    expect(instruction).toContain("2026-08-13T02:03:04.000Z");
    expect(instruction).toContain("组织本地时间：2026-08-13 10:03:04");
    expect(instruction).toContain("组织时区：Asia/Shanghai");
    expect(instruction).toContain("不是组织事实证据");
    expect(instruction).toContain("不能仅凭当前时间断言");
  });

  it("rejects an invalid timezone", () => {
    expect(() => buildCurrentTimeInstruction(
      new Date("2026-08-13T02:03:04.000Z"),
      "not-a-timezone",
    )).toThrow(RangeError);
  });
});
